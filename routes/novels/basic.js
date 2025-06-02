import express from "express";
import Novel from "../../models/Novel.js";
import { auth } from "../../middleware/auth.js";
import Chapter from "../../models/Chapter.js";
import Module from "../../models/Module.js";
import { cache, clearNovelCaches, notifyAllClients, shouldBypassCache } from '../../utils/cacheUtils.js';
import UserNovelInteraction from '../../models/UserNovelInteraction.js';
import Request from '../../models/Request.js';
import Contribution from '../../models/Contribution.js';
import { createNovelTransaction } from '../novelTransactions.js';
import ContributionHistory from '../../models/ContributionHistory.js';
import Comment from '../../models/Comment.js';
import mongoose from 'mongoose';
import UserChapterInteraction from '../../models/UserChapterInteraction.js';
import { populateStaffNames } from '../../utils/populateStaffNames.js';

const router = express.Router();

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

// Query deduplication helper
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
 * Lookup novel ID by slug
 * @route GET /api/novels/slug/:slug
 */
router.get("/slug/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Extract the short ID from the slug (last 8 characters after final hyphen)
    const parts = slug.split('-');
    const shortId = parts[parts.length - 1];
    
    // If it's already a full MongoDB ID, return it
    if (/^[0-9a-fA-F]{24}$/.test(slug)) {
      const novel = await Novel.findById(slug).select('_id title').lean();
      if (novel) {
        return res.json({ id: novel._id, title: novel.title });
      }
      return res.status(404).json({ message: "Novel not found" });
    }
    
    // If we have a short ID (8 hex characters), find the novel using ObjectId range query
    if (/^[0-9a-fA-F]{8}$/.test(shortId)) {
      const shortIdLower = shortId.toLowerCase();
      
      try {
        // Use targeted aggregation for efficient lookup
        const [novel] = await Novel.aggregate([
          {
            $addFields: {
              idString: { $toString: "$_id" }
            }
          },
          {
            $match: {
              idString: { $regex: new RegExp(shortIdLower + '$', 'i') }
            }
          },
          {
            $project: {
              _id: 1,
              title: 1
            }
          },
          {
            $limit: 1
          }
        ]);
        
        if (novel) {
          return res.json({ id: novel._id, title: novel.title });
        }
      } catch (aggregationError) {
        console.warn('Aggregation failed, falling back to alternative method:', aggregationError);
        
        // Fallback: fetch novels in batches and check suffix
        let skip = 0;
        const batchSize = 100;
        let found = false;
        
        while (!found) {
          const novels = await Novel.find({}, { _id: 1, title: 1 })
            .lean()
            .skip(skip)
            .limit(batchSize);
          
          if (novels.length === 0) break; // No more novels to check
          
          const matchingNovel = novels.find(novel => 
            novel._id.toString().toLowerCase().endsWith(shortIdLower)
          );
          
          if (matchingNovel) {
            return res.json({ id: matchingNovel._id, title: matchingNovel.title });
          }
          
          skip += batchSize;
        }
      }
    }
    
    res.status(404).json({ message: "Novel not found" });
  } catch (err) {
    console.error('Error in novel slug lookup:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get all novels with pagination
 * @route GET /api/novels
 */
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Check if we should bypass cache
    const bypass = shouldBypassCache(req.path, req.query);
    console.log(`Novel list request: ${bypass ? 'Bypassing cache' : 'Using cache if available'}`);

    // Generate cache key based on pagination
    const cacheKey = `novels_page_${page}_limit_${limit}`;
    const cachedData = bypass ? null : cache.get(cacheKey);
    
    if (cachedData && !bypass) {
      console.log('Serving novel list from cache');
      return res.json(cachedData);
    }

    console.log('Fetching fresh novel list data from database');

    // Get novels and total count in a single aggregation
    const [result] = await Novel.aggregate([
      {
        $facet: {
          total: [{ $count: 'count' }],
          novels: [
            {
              $project: {
                title: 1,
                illustration: 1,
                author: 1,
                illustrator: 1,
                status: 1,
                genres: 1,
                alternativeTitles: 1,
                updatedAt: 1,
                createdAt: 1,
                description: 1,
                note: 1,
                active: 1,
                inactive: 1,
                novelBalance: 1,
                novelBudget: 1
              }
            },
            // Lookup latest chapters for display
            {
              $lookup: {
                from: 'chapters',
                let: { novelId: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$novelId', '$$novelId'] }
                    }
                  },
                  { $sort: { createdAt: -1 } },
                  { $limit: 3 },
                  {
                    $project: {
                      _id: 1,
                      title: 1,
                      createdAt: 1
                    }
                  }
                ],
                as: 'chapters'
              }
            },
            // Lookup first chapter (by order)
            {
              $lookup: {
                from: 'chapters',
                let: { novelId: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$novelId', '$$novelId'] }
                    }
                  },
                  { $sort: { order: 1 } },
                  { $limit: 1 },
                  {
                    $project: {
                      _id: 1,
                      title: 1,
                      order: 1
                    }
                  }
                ],
                as: 'firstChapter'
              }
            },
            // Calculate latest activity and set first chapter
            {
              $addFields: {
                latestActivity: {
                  $max: [
                    '$updatedAt',
                    { $max: '$chapters.createdAt' }
                  ]
                },
                firstChapter: { $arrayElemAt: ['$firstChapter', 0] }
              }
            },
            // Sort by latest activity
            { $sort: { latestActivity: -1 } },
            // Apply pagination
            { $skip: skip },
            { $limit: limit }
          ]
        }
      }
    ]);

    const total = result.total[0]?.count || 0;
    const novels = result.novels;

    // Check if we should skip staff population (for admin editing)
    const skipPopulation = req.query.skipPopulation === 'true';
    
    // Populate staff names for all novels unless skipPopulation is requested
    const finalNovels = skipPopulation ? novels : await Promise.all(
      novels.map(novel => populateStaffNames(novel))
    );

    const response = {
      novels: finalNovels,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total
      }
    };

    // Cache the response only if not bypassing
    if (!bypass) {
      cache.set(cacheKey, response);
      console.log('Cached novel list data');
    } else {
      console.log('Not caching novel list per configuration');
    }

    res.json(response);
  } catch (err) {
    console.error("Error in GET /api/novels:", err);
    res.status(500).json({
      novels: [],
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalItems: 0
      },
      error: err.message
    });
  }
});

/**
 * Create a new novel
 * @route POST /api/novels
 */
router.post("/", auth, async (req, res) => {
  try {
    const {
      title,
      alternativeTitles,
      author,
      illustrator,
      active,
      inactive,
      genres,
      description,
      note,
      illustration,
      status
    } = req.body;

    const novel = new Novel({
      title,
      alternativeTitles: alternativeTitles || [],
      author,
      illustrator,
      active: {
        translator: active?.translator || [],
        editor: active?.editor || [],
        proofreader: active?.proofreader || []
      },
      inactive: {
        translator: inactive?.translator || [],
        editor: inactive?.editor || [],
        proofreader: inactive?.proofreader || []
      },
      genres: genres || [],
      description,
      note,
      illustration,
      status: status || 'Ongoing',
      chapters: [],
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const newNovel = await novel.save();
    
    // Clear all novel-related caches after creating new novel
    clearNovelCaches();
    
    // Explicitly notify clients about the new novel
    notifyAllClients('new_novel', { 
      id: newNovel._id,
      title: newNovel.title,
      timestamp: new Date().toISOString() 
    });
    
    res.status(201).json(newNovel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Get single novel and increment view count (OPTIMIZED)
 * @route GET /api/novels/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const novelId = req.params.id;
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(`novel:${novelId}`, async () => {
      // Use a single aggregation pipeline to get all required data in one query
      const [novelWithData] = await Novel.aggregate([
        // Match the specific novel
        {
          $match: { _id: new mongoose.Types.ObjectId(novelId) }
        },
        
        // Lookup modules for this novel
        {
          $lookup: {
            from: 'modules',
            localField: '_id',
            foreignField: 'novelId',
            pipeline: [
              {
                $project: {
                  title: 1,
                  illustration: 1,
                  order: 1,
                  mode: 1,
                  moduleBalance: 1
                }
              },
              { $sort: { order: 1 } }
            ],
            as: 'modules'
          }
        },
        
        // Lookup all chapters for this novel
        {
          $lookup: {
            from: 'chapters',
            localField: '_id',
            foreignField: 'novelId',
            pipeline: [
              {
                $project: {
                  title: 1,
                  moduleId: 1,
                  order: 1,
                  createdAt: 1,
                  updatedAt: 1,
                  mode: 1,
                  chapterBalance: 1
                }
              },
              { $sort: { order: 1 } }
            ],
            as: 'allChapters'
          }
        },
        
        // Project only the fields we need from the novel
        {
          $project: {
            title: 1,
            description: 1,
            alternativeTitles: 1,
            author: 1,
            illustrator: 1,
            illustration: 1,
            status: 1,
            active: 1,
            inactive: 1,
            genres: 1,
            note: 1,
            updatedAt: 1,
            createdAt: 1,
            views: 1,
            ratings: 1,
            novelBalance: 1,
            novelBudget: 1,
            modules: 1,
            allChapters: 1
          }
        }
      ]);

      if (!novelWithData) {
        return { error: "Novel not found", status: 404 };
      }

      // Organize chapters by module efficiently
      const chaptersByModule = novelWithData.allChapters.reduce((acc, chapter) => {
        const moduleId = chapter.moduleId.toString();
        if (!acc[moduleId]) {
          acc[moduleId] = [];
        }
        acc[moduleId].push(chapter);
        return acc;
      }, {});

      // Attach chapters to their modules
      const modulesWithChapters = novelWithData.modules.map(module => ({
        ...module,
        chapters: chaptersByModule[module._id.toString()] || []
      }));

      // Clean up the response structure
      const { allChapters, ...novel } = novelWithData;
      
      // Populate staff ObjectIds with user display names
      const populatedNovel = await populateStaffNames(novel);
      
      return {
        novel: populatedNovel,
        modules: modulesWithChapters
      };
    });

    // Handle deduplication errors
    if (result.error) {
      return res.status(result.status).json({ message: result.error });
    }

    // Return combined data
    res.json(result);

    // Increment view count after sending response (non-blocking)
    if (req.query.skipViewTracking !== 'true') {
      // Find the full document (not lean) and use the model method
      Novel.findById(novelId)
        .then(fullNovel => {
          if (fullNovel) {
            return fullNovel.incrementViews();
          }
        })
        .catch(err => console.error('Error updating view count:', err));
    }
  } catch (err) {
    console.error('Error in novel route:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Update a novel
 * @route PUT /api/novels/:id
 */
router.put("/:id", auth, async (req, res) => {
  try {
    const {
      title,
      alternativeTitles,
      author,
      illustrator,
      active,
      inactive,
      genres,
      description,
      note,
      illustration,
      status
    } = req.body;

    // Find novel and update it
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Update fields
    novel.title = title;
    novel.alternativeTitles = alternativeTitles;
    novel.author = author;
    novel.illustrator = illustrator;
    novel.active = active;
    novel.inactive = inactive;
    novel.genres = genres;
    novel.description = description;
    novel.note = note;
    novel.illustration = illustration;
    novel.status = status;
    novel.updatedAt = new Date();

    // Save the updated novel
    const updatedNovel = await novel.save();

    // Clear novel caches
    clearNovelCaches();

    // Notify SSE clients about the update
    notifyAllClients({
      type: 'novel-updated',
      data: {
        novelId: updatedNovel._id,
        updatedAt: updatedNovel.updatedAt
      }
    });

    res.json(updatedNovel);
  } catch (err) {
    console.error("Error updating novel:", err);
    res.status(400).json({ message: err.message });
  }
});

/**
 * Delete a novel
 * @route DELETE /api/novels/:id
 */
router.delete("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    console.log(`Deleting novel with ID: ${req.params.id}`);
    const novel = await Novel.findById(req.params.id).session(session);
    if (!novel) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Novel not found" });
    }

    const novelId = req.params.id;

    // First get all chapter IDs for this novel (before deleting them)
    const chapterIds = await Chapter.find({ novelId: novelId })
      .select('_id')
      .session(session)
      .lean();

    // Delete all comments for this novel (contentType: 'novels' and contentId: novelId)
    await Comment.deleteMany({ 
      contentType: 'novels', 
      contentId: novelId 
    }).session(session);

    // Delete all comments for chapters of this novel
    if (chapterIds.length > 0) {
      const chapterIdStrings = chapterIds.map(ch => ch._id.toString());
      // Delete comments for chapters (contentType: 'chapters' and contentId contains chapter ID)
      await Comment.deleteMany({
        contentType: 'chapters',
        contentId: { $in: chapterIdStrings.map(id => new RegExp(id)) }
      }).session(session);
    }

    // Delete all chapters associated with this novel
    await Chapter.deleteMany({ novelId: novelId }).session(session);
    
    // Delete all modules associated with this novel
    await Module.deleteMany({ novelId: novelId }).session(session);

    // Delete all user interactions with this novel (ratings, reviews, likes, bookmarks)
    await UserNovelInteraction.deleteMany({ novelId: novelId }).session(session);

    // Delete all contribution history for this novel
    await ContributionHistory.deleteMany({ novelId: novelId }).session(session);

    // Delete all novel transactions for this novel
    const NovelTransaction = mongoose.model('NovelTransaction');
    await NovelTransaction.deleteMany({ novel: novelId }).session(session);

    // First find all request IDs for this novel (before deleting them)
    const novelRequests = await Request.find({ novel: novelId })
      .select('_id')
      .session(session)
      .lean();
    
    // Delete all contributions to requests related to this novel
    if (novelRequests.length > 0) {
      const requestIds = novelRequests.map(req => req._id);
      await Contribution.deleteMany({ 
        request: { $in: requestIds } 
      }).session(session);
    }

    // Delete all requests related to this novel
    await Request.deleteMany({ novel: novelId }).session(session);

    // Remove this novel from all users' favorites
    const User = mongoose.model('User');
    await User.updateMany(
      { favorites: novelId },
      { $pull: { favorites: novelId } }
    ).session(session);

    // Finally, delete the novel itself
    await Novel.findByIdAndDelete(novelId).session(session);

    await session.commitTransaction();

    // Clear all novel-related caches after deletion
    clearNovelCaches();
    
    // Send special notification about novel deletion
    notifyAllClients('novel_deleted', { 
      id: novelId,
      title: novel.title,
      timestamp: new Date().toISOString()
    });
    
    res.json({ message: "Novel and all related content deleted successfully" });
  } catch (err) {
    await session.abortTransaction();
    console.error("Error deleting novel:", err);
    res.status(500).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

/**
 * Update novel balance
 * @route PATCH /api/novels/:id/balance
 */
router.patch("/:id/balance", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can update novel balance' });
    }
    
    const { novelBalance } = req.body;
    const novelId = req.params.id;
    
    if (isNaN(novelBalance)) {
      return res.status(400).json({ message: 'Invalid balance value' });
    }
    
    // Find novel first to get current balance
    const novel = await Novel.findById(novelId).session(session);
    if (!novel) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Novel not found' });
    }
    
    const oldBalance = novel.novelBalance || 0;
    const change = novelBalance - oldBalance;
    
    // Update novel balance
    const updatedNovel = await Novel.findByIdAndUpdate(
      novelId,
      { novelBalance },
      { new: true, session }
    );
    
    // Record transaction
    await createNovelTransaction({
      novel: novelId,
      amount: change,
      type: 'admin',
      description: 'Admin điều chỉnh số dư thủ công',
      balanceAfter: novelBalance,
      performedBy: req.user._id
    }, session);
    
    await session.commitTransaction();
    res.json(updatedNovel);
  } catch (error) {
    await session.abortTransaction();
    console.error('Error updating novel balance:', error);
    res.status(500).json({ message: 'Lỗi máy chủ' });
  } finally {
    session.endSession();
  }
});

export default router;
export { dedupQuery }; 