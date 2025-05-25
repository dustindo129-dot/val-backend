import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import Chapter from '../models/Chapter.js';
import { getCacheValue, setCacheValue, deleteCacheValue, deleteByPattern } from '../utils/redisClient.js';

const router = express.Router();

// Cache keys constants
const CACHE_TTL = 300; // 5 minutes in seconds
const getUserInteractionCacheKey = (userId, chapterId) => `user:${userId}:chapter:${chapterId}:interaction`;
const getChapterStatsCacheKey = (chapterId) => `chapter:${chapterId}:stats`;

/**
 * Get chapter interaction statistics
 * @route GET /api/userchapterinteractions/stats/:chapterId
 */
router.get('/stats/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    
    // Try to get from cache first
    const cacheKey = getChapterStatsCacheKey(chapterId);
    const cachedStats = await getCacheValue(cacheKey);
    
    if (cachedStats) {
      return res.json(cachedStats);
    }
    
    // Aggregate interactions data
    const [stats] = await UserChapterInteraction.aggregate([
      {
        $match: { chapterId: new mongoose.Types.ObjectId(chapterId) }
      },
      {
        $group: {
          _id: null,
          totalLikes: {
            $sum: { $cond: [{ $eq: ['$liked', true] }, 1, 0] }
          },
          totalRatings: {
            $sum: { $cond: [{ $ne: ['$rating', null] }, 1, 0] }
          },
          ratingSum: {
            $sum: { $ifNull: ['$rating', 0] }
          }
        }
      }
    ]);

    // If no interactions exist yet, return default values
    const result = stats 
      ? {
          totalLikes: stats.totalLikes,
          totalRatings: stats.totalRatings,
          averageRating: stats.totalRatings > 0 
            ? (stats.ratingSum / stats.totalRatings).toFixed(1) 
            : '0.0'
        }
      : {
          totalLikes: 0,
          totalRatings: 0,
          averageRating: '0.0'
        };
    
    // Cache the result
    await setCacheValue(cacheKey, result, CACHE_TTL);

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
    const cachedInteraction = await getCacheValue(cacheKey);
    
    if (cachedInteraction) {
      return res.json(cachedInteraction);
    }

    // Use lean() for better performance and only select needed fields
    const interaction = await UserChapterInteraction.findOne(
      { userId, chapterId },
      { liked: 1, rating: 1, bookmarked: 1, _id: 0 }  // Only select needed fields
    )
    .lean()
    .maxTimeMS(2000);  // Set timeout to prevent long-running queries
    
    // Default response
    const result = {
      liked: interaction?.liked || false,
      rating: interaction?.rating || null,
      bookmarked: interaction?.bookmarked || false
    };
    
    // Cache the result
    await setCacheValue(cacheKey, result, CACHE_TTL);
    
    return res.json(result);
  } catch (err) {
    console.error("Error getting user interaction:", err);
    // Return default values instead of error for better UX
    if (err.name === 'MongooseError' || err.name === 'MongoError') {
      return res.json({
        liked: false, 
        rating: null, 
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
    await deleteCacheValue(getUserInteractionCacheKey(userId, chapterId));
    await deleteCacheValue(getChapterStatsCacheKey(chapterId));
    
    return res.json(result);
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Rate a chapter
 * @route POST /api/userchapterinteractions/rate
 */
router.post('/rate', auth, async (req, res) => {
  try {
    const { chapterId, rating } = req.body;
    const userId = req.user._id;

    if (!chapterId) {
      return res.status(400).json({ message: 'Chapter ID is required' });
    }

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
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
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        rating
      });
    } else {
      interaction.rating = rating;
    }
    await interaction.save();

    // Calculate new rating statistics
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: new mongoose.Types.ObjectId(chapterId), rating: { $exists: true, $ne: null } } },
      { 
        $group: { 
          _id: null, 
          totalRatings: { $sum: 1 },
          ratingSum: { $sum: "$rating" }
        } 
      }
    ]);

    const totalRatings = stats?.totalRatings || 0;
    const averageRating = totalRatings > 0 
      ? (stats.ratingSum / totalRatings).toFixed(1) 
      : '0.0';

    const result = {
      rating,
      totalRatings,
      averageRating
    };
    
    // Invalidate related caches
    await deleteCacheValue(getUserInteractionCacheKey(userId, chapterId));
    await deleteCacheValue(getChapterStatsCacheKey(chapterId));
    
    return res.json(result);
  } catch (err) {
    console.error("Error rating chapter:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Remove rating from a chapter
 * @route DELETE /api/userchapterinteractions/rate/:chapterId
 */
router.delete('/rate/:chapterId', auth, async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const userId = req.user._id;

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find interaction
    const interaction = await UserChapterInteraction.findOne({ userId, chapterId });
    if (!interaction || !interaction.rating) {
      return res.status(404).json({ message: "No rating found for this chapter" });
    }

    // Remove rating
    interaction.rating = null;
    await interaction.save();

    // Calculate new rating statistics
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: new mongoose.Types.ObjectId(chapterId), rating: { $exists: true, $ne: null } } },
      { 
        $group: { 
          _id: null, 
          totalRatings: { $sum: 1 },
          ratingSum: { $sum: "$rating" }
        } 
      }
    ]);

    const totalRatings = stats?.totalRatings || 0;
    const averageRating = totalRatings > 0 
      ? (stats.ratingSum / totalRatings).toFixed(1) 
      : '0.0';

    const result = {
      totalRatings,
      averageRating
    };
    
    // Invalidate related caches
    await deleteCacheValue(getUserInteractionCacheKey(userId, chapterId));
    await deleteCacheValue(getChapterStatsCacheKey(chapterId));
    
    return res.json(result);
  } catch (err) {
    console.error("Error removing rating:", err);
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
      await deleteByPattern(`user:${userId}:chapter:*:interaction`);
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
    await deleteCacheValue(getUserInteractionCacheKey(userId, chapterId));
    await deleteCacheValue(`user:${userId}:novel:${chapter.novelId}:bookmark`);
    
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
    const cachedBookmark = await getCacheValue(cacheKey);
    
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
      await setCacheValue(cacheKey, result, CACHE_TTL);
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
        await setCacheValue(cacheKey, result, CACHE_TTL);
        return res.json(result);
      }
      
      const result = {
        bookmarkedChapter: {
          id: interaction.chapterId._id,
          title: interaction.chapterId.title
        }
      };
      
      // Cache the result
      await setCacheValue(cacheKey, result, CACHE_TTL);
      
      return res.json(result);
    } catch (populateErr) {
      const result = { bookmarkedChapter: null };
      await setCacheValue(cacheKey, result, CACHE_TTL);
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
 * Record a view for a chapter
 * @route POST /api/userchapterinteractions/view/:chapterId
 */
router.post('/view/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    
    // Use a direct atomic update instead of loading the entire chapter first
    // This is much faster and avoids race conditions
    const updateResult = await Chapter.findByIdAndUpdate(
      chapterId,
      { $inc: { views: 1 } },
      { new: true, select: 'views' } // Return just the updated views field
    );
    
    if (!updateResult) {
      return res.status(404).json({ message: "Chapter not found" });
    }
    
    // Return the updated view count
    return res.json({ 
      views: updateResult.views,
      counted: true
    });
  } catch (err) {
    console.error("Error recording view:", err);
    // Still return some data to prevent client-side errors
    res.status(200).json({ 
      views: 0,
      counted: false,
      error: "Error recording view"
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
    await deleteCacheValue(`user:${userId}:recently-read`);
    await deleteCacheValue(getUserInteractionCacheKey(userId, chapterId));

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
    const cachedData = await getCacheValue(cacheKey);
    
    if (cachedData) {
      return res.json(cachedData);
    }

    // Aggregate recently read chapters with novel and module info
    // Only get the most recent chapter per novel
    const recentlyRead = await UserChapterInteraction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          lastReadAt: { $ne: null }
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
      {
        $limit: limit
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
        $project: {
          chapterId: 1,
          novelId: 1,
          lastReadAt: 1,
          chapter: { $arrayElemAt: ['$chapter', 0] },
          novel: { $arrayElemAt: ['$novel', 0] },
          module: { $arrayElemAt: ['$module', 0] }
        }
      },
      {
        $match: {
          'chapter._id': { $exists: true },
          'novel._id': { $exists: true }
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
    await setCacheValue(cacheKey, formattedData, CACHE_TTL);

    res.json(formattedData);
  } catch (err) {
    console.error("Error getting recently read chapters:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 