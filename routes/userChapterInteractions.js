import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import Chapter from '../models/Chapter.js';
import NodeCache from 'node-cache';

const router = express.Router();

/**
 * PERFORMANCE OPTIMIZATION NOTES:
 * 
 * For optimal performance of userChapterInteractions queries, ensure these indexes exist:
 * 
 * 1. db.userchapterinteractions.createIndex({ "chapterId": 1 }) // For stats queries
 * 2. db.userchapterinteractions.createIndex({ "userId": 1, "chapterId": 1 }) // For user interaction queries
 * 3. db.userchapterinteractions.createIndex({ "userId": 1, "novelId": 1, "bookmarked": 1 }) // For bookmark queries
 * 4. db.userchapterinteractions.createIndex({ "userId": 1, "lastReadAt": -1 }) // For recently read queries
 * 5. db.userchapterinteractions.createIndex({ "chapterId": 1, "liked": 1 }) // For like count queries
 * 
 * These indexes will eliminate the duplicate query patterns and improve response times significantly.
 */

// Create in-memory cache for chapter interactions (5 minutes TTL)
const interactionCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

// Cache keys constants
const getUserInteractionCacheKey = (userId, chapterId) => `user:${userId}:chapter:${chapterId}:interaction`;
const getChapterStatsCacheKey = (chapterId) => `chapter:${chapterId}:stats`;

// Helper function for query deduplication
const dedupQuery = async (key, queryFn) => {
  // If query is already pending, wait for it
  if (pendingQueries.has(key)) {
    return await pendingQueries.get(key);
  }
  
  // Start new query
  const queryPromise = queryFn();
  pendingQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    // Clean up pending query
    pendingQueries.delete(key);
  }
};

/**
 * Get chapter interaction statistics
 * @route GET /api/userchapterinteractions/stats/:chapterId
 */
router.get('/stats/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    
    // Try to get from cache first
    const cacheKey = getChapterStatsCacheKey(chapterId);
    const cachedStats = interactionCache.get(cacheKey);
    
    if (cachedStats) {
      return res.json(cachedStats);
    }
    
    // Use query deduplication for the aggregation
    const result = await dedupQuery(`stats:${chapterId}`, async () => {
      // Aggregate interactions data (only likes, no ratings)
      const [stats] = await UserChapterInteraction.aggregate([
        {
          $match: { chapterId: new mongoose.Types.ObjectId(chapterId) }
        },
        {
          $group: {
            _id: null,
            totalLikes: {
              $sum: { $cond: [{ $eq: ['$liked', true] }, 1, 0] }
            }
          }
        }
      ]);

      // If no interactions exist yet, return default values
      return stats 
        ? {
            totalLikes: stats.totalLikes
          }
        : {
            totalLikes: 0
          };
    });
    
    // Cache the result
    interactionCache.set(cacheKey, result);

    res.json(result);
  } catch (err) {
    console.error('Error getting chapter interactions:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get user's interaction with a chapter
 * @route GET /api/userchapterinteractions/user/:chapterId
 */
router.get('/user/:chapterId', auth, async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const userId = req.user._id;

    // Validate IDs to prevent invalid ObjectId errors
    if (!mongoose.Types.ObjectId.isValid(chapterId)) {
      return res.status(400).json({ message: "Invalid chapter ID format" });
    }
    
    // Try to get from cache first
    const cacheKey = getUserInteractionCacheKey(userId, chapterId);
    const cachedInteraction = interactionCache.get(cacheKey);
    
    if (cachedInteraction) {
      return res.json(cachedInteraction);
    }

    // Use query deduplication for the database lookup
    const result = await dedupQuery(`user-interaction:${userId}:${chapterId}`, async () => {
      // Use lean() for better performance and only select needed fields
      const interaction = await UserChapterInteraction.findOne(
        { userId, chapterId },
        { liked: 1, bookmarked: 1, _id: 0 }  // Only select needed fields, removed rating
      )
      .lean()
      .maxTimeMS(2000);  // Set timeout to prevent long-running queries
      
      // Default response
      return {
        liked: interaction?.liked || false,
        bookmarked: interaction?.bookmarked || false
      };
    });
    
    // Cache the result
    interactionCache.set(cacheKey, result);
    
    return res.json(result);
  } catch (err) {
    console.error("Error getting user interaction:", err);
    // Return default values instead of error for better UX
    if (err.name === 'MongooseError' || err.name === 'MongoError') {
      return res.json({
        liked: false, 
        bookmarked: false,
        error: "Database error, using default values"
      });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

/**
 * Toggle like status for a chapter
 * @route POST /api/userchapterinteractions/like
 */
router.post('/like', auth, async (req, res) => {
  try {
    const { chapterId } = req.body;
    const userId = req.user._id;

    if (!chapterId) {
      return res.status(400).json({ message: 'Chapter ID is required' });
    }

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find or create interaction
    let interaction = await UserChapterInteraction.findOne({ 
      userId, 
      chapterId,
      novelId: chapter.novelId 
    });
    
    if (!interaction) {
      // Create new interaction with liked=true
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        liked: true
      });
    } else {
      // Toggle existing interaction
      interaction.liked = !interaction.liked;
    }
    await interaction.save();

    // Get total likes count
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: new mongoose.Types.ObjectId(chapterId), liked: true } },
      { $group: { _id: null, totalLikes: { $sum: 1 } } }
    ]);
    
    const result = { 
      liked: interaction.liked,
      totalLikes: stats?.totalLikes || 0
    };
    
    // Invalidate related caches
    interactionCache.del(getUserInteractionCacheKey(userId, chapterId));
    interactionCache.del(getChapterStatsCacheKey(chapterId));
    
    return res.json(result);
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Bookmark a chapter
 * @route POST /api/userchapterinteractions/bookmark
 */
router.post('/bookmark', auth, async (req, res) => {
  try {
    const { chapterId } = req.body;
    const userId = req.user._id;

    if (!chapterId) {
      return res.status(400).json({ message: 'Chapter ID is required' });
    }

    // Check if chapter exists and get novel ID
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find current interaction to determine state
    let interaction = await UserChapterInteraction.findOne({ 
      userId, 
      chapterId,
      novelId: chapter.novelId 
    });
    
    const currentlyBookmarked = interaction?.bookmarked || false;

    // Only clear other bookmarks if we're setting a new one (not unbookmarking)
    if (!currentlyBookmarked) {
      // Remove any existing bookmarks for this novel
      await UserChapterInteraction.updateMany(
        { 
          userId,
          novelId: chapter.novelId,
          bookmarked: true,
          chapterId: { $ne: chapterId }
        },
        { 
          $set: { bookmarked: false }
        }
      );
      
      // Invalidate all bookmark caches for this user and novel
      // Note: NodeCache doesn't support pattern deletion, so we'll clear the entire cache
      // This is acceptable since it's in-memory and will be repopulated quickly
      interactionCache.flushAll();
    }

    // Update or create interaction for this chapter
    if (!interaction) {
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        bookmarked: true
      });
    } else {
      interaction.bookmarked = !currentlyBookmarked;
    }
    await interaction.save();

    // Auto-bookmark the novel when a chapter is bookmarked
    if (interaction.bookmarked) {
      // Find or create novel interaction
      let novelInteraction = await UserNovelInteraction.findOne({ 
        userId, 
        novelId: chapter.novelId 
      });
      
      if (!novelInteraction) {
        // Create new novel interaction with bookmarked=true
        novelInteraction = new UserNovelInteraction({
          userId,
          novelId: chapter.novelId,
          bookmarked: true,
          updatedAt: new Date()
        });
        await novelInteraction.save();
      } else if (!novelInteraction.bookmarked) {
        // Update existing interaction to bookmark the novel
        novelInteraction.bookmarked = true;
        novelInteraction.updatedAt = new Date();
        await novelInteraction.save();
      }
    }
    
    const result = { 
      bookmarked: interaction.bookmarked,
      chapterId: interaction.bookmarked ? chapterId : null
    };
    
    // Invalidate related caches
    interactionCache.del(getUserInteractionCacheKey(userId, chapterId));
    interactionCache.del(`user:${userId}:novel:${chapter.novelId}:bookmark`);
    
    return res.json(result);
  } catch (err) {
    console.error("Error toggling bookmark:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get bookmarked chapter for a novel
 * @route GET /api/userchapterinteractions/bookmark/:novelId
 */
router.get('/bookmark/:novelId', auth, async (req, res) => {
  try {
    const novelId = req.params.novelId;
    const userId = req.user._id;

    // Verify the novelId is valid
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }

    // Handle missing user ID
    if (!userId) {
      return res.status(401).json({ message: "User authentication required" });
    }
    
    // Try to get from cache first
    const cacheKey = `user:${userId}:novel:${novelId}:bookmark`;
    const cachedBookmark = interactionCache.get(cacheKey);
    
    if (cachedBookmark) {
      return res.json(cachedBookmark);
    }

    // First try to find the interaction without populating to check if it exists
    const interactionExists = await UserChapterInteraction.findOne({
      userId,
      novelId,
      bookmarked: true
    });

    if (!interactionExists) {
      const result = { bookmarkedChapter: null };
      interactionCache.set(cacheKey, result);
      return res.json(result);
    }
    
    // If the interaction exists, now try to populate with error handling
    try {
      const interaction = await UserChapterInteraction.findOne({
        userId,
        novelId,
        bookmarked: true
      }).populate('chapterId', 'title');
      
      // Check if chapter reference is valid
      if (!interaction.chapterId || typeof interaction.chapterId === 'string') {
        // The chapter reference is invalid or missing - update the record
        await UserChapterInteraction.findByIdAndUpdate(
          interaction._id,
          { bookmarked: false } // Unmark the bookmark if chapter doesn't exist
        );
        
        const result = { bookmarkedChapter: null };
        interactionCache.set(cacheKey, result);
        return res.json(result);
      }
      
      const result = {
        bookmarkedChapter: {
          id: interaction.chapterId._id,
          title: interaction.chapterId.title
        }
      };
      
      // Cache the result
      interactionCache.set(cacheKey, result);
      
      return res.json(result);
    } catch (populateErr) {
      const result = { bookmarkedChapter: null };
      interactionCache.set(cacheKey, result);
      return res.json(result);
    }
  } catch (err) {
    console.error("Error getting bookmarked chapter:", err);
    // Return a graceful error instead of 500
    return res.json({ 
      bookmarkedChapter: null,
      error: "Error retrieving bookmark information"
    });
  }
});

/**
 * Record a view for a chapter (DEPRECATED - views are now tracked automatically)
 * @route POST /api/userchapterinteractions/view/:chapterId
 * @deprecated This endpoint is deprecated as views are now tracked automatically with cooldown
 */
router.post('/view/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    
    // This endpoint is deprecated - views are now tracked automatically
    // Just return the current view count without incrementing
    const chapter = await Chapter.findById(chapterId).select('views');
    
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }
    
    // Return the current view count without incrementing
    return res.json({ 
      views: chapter.views || 0,
      counted: false,
      message: "Views are now tracked automatically"
    });
  } catch (err) {
    console.error("Error getting view count:", err);
    // Still return some data to prevent client-side errors
    res.status(200).json({ 
      views: 0,
      counted: false,
      error: "Error getting view count"
    });
  }
});

/**
 * Record recently read chapter for user
 * @route POST /api/userchapterinteractions/recently-read
 */
router.post('/recently-read', auth, async (req, res) => {
  try {
    const { chapterId, novelId, moduleId } = req.body;
    const userId = req.user._id;

    if (!chapterId || !novelId) {
      return res.status(400).json({ message: 'Chapter ID and Novel ID are required' });
    }

    // Verify chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Update or create interaction with lastReadAt timestamp
    const interaction = await UserChapterInteraction.findOneAndUpdate(
      { userId, chapterId, novelId },
      { 
        $set: { 
          lastReadAt: new Date(),
          updatedAt: new Date()
        },
        $setOnInsert: {
          userId,
          chapterId,
          novelId,
          createdAt: new Date()
        }
      },
      { 
        upsert: true, 
        new: true 
      }
    );

    // Invalidate related caches
    interactionCache.del(`user:${userId}:recently-read`);
    interactionCache.del(getUserInteractionCacheKey(userId, chapterId));

    res.json({ 
      success: true, 
      lastReadAt: interaction.lastReadAt 
    });
  } catch (err) {
    console.error("Error recording recently read:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get recently read chapters for user
 * @route GET /api/userchapterinteractions/recently-read
 */
router.get('/recently-read', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const limit = parseInt(req.query.limit) || 4;

    // Try to get from cache first
    const cacheKey = `user:${userId}:recently-read`;
    const cachedData = interactionCache.get(cacheKey);
    
    if (cachedData) {
      return res.json(cachedData);
    }

    // Aggregate recently read chapters with novel and module info
    // Only get the most recent chapter per novel within the last 2 weeks
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    const recentlyRead = await UserChapterInteraction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          lastReadAt: { 
            $ne: null,
            $gte: twoWeeksAgo // Only include chapters read within the last 2 weeks
          }
        }
      },
      {
        $sort: { lastReadAt: -1 }
      },
      {
        $group: {
          _id: '$novelId',
          latestInteraction: { $first: '$$ROOT' }
        }
      },
      {
        $replaceRoot: { newRoot: '$latestInteraction' }
      },
      // Re-sort after grouping to restore proper order by lastReadAt
      {
        $sort: { lastReadAt: -1 }
      },
      {
        $lookup: {
          from: 'chapters',
          localField: 'chapterId',
          foreignField: '_id',
          as: 'chapter'
        }
      },
      {
        $lookup: {
          from: 'novels',
          localField: 'novelId',
          foreignField: '_id',
          pipeline: [
            { $project: { title: 1, illustration: 1 } }
          ],
          as: 'novel'
        }
      },
      // First extract the chapter from array, then do module lookup
      {
        $addFields: {
          chapter: { $arrayElemAt: ['$chapter', 0] },
          novel: { $arrayElemAt: ['$novel', 0] }
        }
      },
      {
        $lookup: {
          from: 'modules',
          localField: 'chapter.moduleId',
          foreignField: '_id',
          pipeline: [
            { $project: { title: 1 } }
          ],
          as: 'module'
        }
      },
      {
        $addFields: {
          module: { $arrayElemAt: ['$module', 0] }
        }
      },
      {
        $match: {
          'chapter._id': { $exists: true },
          'novel._id': { $exists: true }
        }
      },
      // Apply limit AFTER filtering to ensure we get exactly the number we want
      {
        $limit: limit
      },
      {
        $project: {
          chapterId: 1,
          novelId: 1,
          lastReadAt: 1,
          chapter: 1,
          novel: 1,
          module: 1
        }
      }
    ]);

    // Format the response to match frontend expectations
    const formattedData = recentlyRead.map(item => ({
      chapterId: item.chapterId,
      novelId: item.novelId,
      lastReadAt: item.lastReadAt,
      chapter: {
        _id: item.chapterId,
        title: item.chapter?.title || 'Unknown Chapter'
      },
      novel: {
        _id: item.novelId,
        title: item.novel?.title || 'Unknown Novel',
        illustration: item.novel?.illustration || null
      },
      module: {
        _id: item.chapter?.moduleId,
        title: item.module?.title || 'Unknown Module'
      }
    }));

    // Cache the result for 5 minutes
    interactionCache.set(cacheKey, formattedData);

    res.json(formattedData);
  } catch (err) {
    console.error("Error getting recently read chapters:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 