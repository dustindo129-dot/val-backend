import express from "express";
import Novel from "../models/Novel.js";
import { auth } from "../middleware/auth.js";
import Chapter from "../models/Chapter.js";
import Module from "../models/Module.js";
import { cache, clearNovelCaches, notifyAllClients, shouldBypassCache } from '../utils/cacheUtils.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import { addClient, removeClient } from '../services/sseService.js';
import Request from '../models/Request.js';
import Contribution from '../models/Contribution.js';
import { createNovelTransaction } from '../routes/novelTransactions.js';
import ContributionHistory from '../models/ContributionHistory.js';
import Comment from '../models/Comment.js';
import mongoose from 'mongoose';

const router = express.Router();

// Server-Sent Events endpoint for real-time updates
router.get('/sse', (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });

  // Store client IP, user agent and tab ID to help identify unique clients
  const clientInfo = {
    ip: req.ip || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    tabId: req.query.tabId || `manual_${Date.now()}`,
    timestamp: Date.now()
  };

  // Send initial connection message with client ID
  const client = { res, info: clientInfo };
  const clientId = addClient(client);
  
  res.write(`data: ${JSON.stringify({ 
    message: 'Connected to novel updates',
    clientId: clientId,
    tabId: clientInfo.tabId,
    timestamp: Date.now() 
  })}\n\n`);

  // Send a ping every 20 seconds to keep the connection alive
  const pingInterval = setInterval(() => {
    try {
      res.write(`: ping ${clientId}:${clientInfo.tabId}\n\n`);
    } catch (error) {
      clearInterval(pingInterval);
      removeClient(client);
    }
  }, 20000);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(pingInterval);
    removeClient(client);
  });
});

// Add cache control headers middleware
const setCacheControlHeaders = (req, res, next) => {
  // Check if this is a critical path that should bypass cache
  const isCriticalPath = shouldBypassCache(req.path, req.query);
  
  if (isCriticalPath) {
    // Set the most aggressive no-cache headers possible
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '-1');
    res.set('Surrogate-Control', 'no-store');
    // Add a timestamp to make sure browser doesn't use cached response
    res.set('X-Timestamp', new Date().getTime().toString());
  } 
  // For other GET requests, allow minimal caching
  else if (req.method === 'GET') {
    res.set('Cache-Control', 'private, max-age=10'); // Only 10 seconds
  } 
  // For mutations (POST, PUT, DELETE), prevent caching
  else {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
};

// Apply cache control headers to all routes
router.use(setCacheControlHeaders);

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
    
    // If we have a short ID (8 hex characters), find the novel
    if (/^[0-9a-fA-F]{8}$/.test(shortId)) {
      // Use a more robust approach - get all novels and filter in JavaScript
      // This is more reliable than regex with ObjectIds
      const novels = await Novel.find({}, '_id title').lean();
      const matchingNovel = novels.find(novel => 
        novel._id.toString().toLowerCase().endsWith(shortId.toLowerCase())
      );
      
      if (matchingNovel) {
        return res.json({ id: matchingNovel._id, title: matchingNovel.title });
      }
    }
    
    res.status(404).json({ message: "Novel not found" });
  } catch (err) {
    console.error('Error in novel slug lookup:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Search novels by title
 * Supports partial matches and case-insensitive search
 * @route GET /api/novels/search
 */
router.get("/search", async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) {
      return res.status(400).json({ message: "Search query is required" });
    }

    // Split search terms and create regex pattern
    const searchTerms = title.split(" ").filter((term) => term.length > 0);
    const searchPattern = searchTerms.map((term) => `(?=.*${term})`).join("");

    const novels = await Novel.aggregate([
      {
        $match: {
          $or: [
            // Match main title
            { title: { $regex: searchPattern, $options: "i" } },
            // Match alternative titles if they exist
            { alternativeTitles: { $regex: searchPattern, $options: "i" } },
          ],
        }
      },
      // Lookup chapters to get accurate count
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
            {
              $count: 'total'
            }
          ],
          as: 'chapterCount'
        }
      },
      // Add chapter count field
      {
        $addFields: {
          totalChapters: {
            $cond: {
              if: { $gt: [{ $size: '$chapterCount' }, 0] },
              then: { $arrayElemAt: ['$chapterCount.total', 0] },
              else: 0
            }
          }
        }
      },
      {
        $project: {
          title: 1,
          illustration: 1,
          author: 1,
          status: 1,
          totalChapters: 1
        }
      },
      { $limit: 10 }
    ]);

    res.json(novels);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get hot novels (most viewed in specific time range)
 * @route GET /api/novels/hot
 */
router.get("/hot", async (req, res) => {
  try {
    const timeRange = req.query.timeRange || 'today';
    
    // Check if we should bypass the cache
    const bypass = shouldBypassCache(req.path, req.query);
    
    // Only check cache if not bypassing
    const cacheKey = `hot_novels_${timeRange}`;
    const cachedData = bypass ? null : cache.get(cacheKey);
    
    if (cachedData && !bypass) {
      return res.json(cachedData);
    }

    console.log(`Fetching fresh hot novels data for ${timeRange} from database`);
    
    // Set date range based on timeRange parameter
    const now = new Date();
    let startDate;
    
    if (timeRange === 'today') {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
    } else if (timeRange === 'week') {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
    }
    
    let hotNovels = [];
    
    // First try to get novels based on view count
    if (timeRange === 'today' || timeRange === 'week') {
      // For today and week timeframes
      try {
        // Find novels with views in the selected time range
        hotNovels = await Novel.aggregate([
          // Only include novels with daily views
          { $match: { "views.daily": { $exists: true, $ne: [] } } },
          // Unwind daily views array
          { $unwind: "$views.daily" },
          // Match views from selected time range
          {
            $match: {
              "views.daily.date": { $gte: startDate }
            }
          },
          // Group by novel ID to prevent duplicates and sum the view counts
          {
            $group: {
              _id: "$_id",
              title: { $first: "$title" },
              illustration: { $first: "$illustration" },
              status: { $first: "$status" },
              updatedAt: { $first: "$updatedAt" },
              dailyViews: { $sum: "$views.daily.count" }
            }
          },
          // Sort by the summed daily views
          { $sort: { dailyViews: -1 } },
          // Limit to top 5
          { $limit: 5 },
          // Lookup latest chapters
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
                { $limit: 1 },
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
          // Project final fields
          {
            $project: {
              _id: 1,
              title: 1,
              illustration: 1,
              status: 1,
              updatedAt: 1,
              chapters: 1,
              dailyViews: 1,
              source: { $literal: "views" }
            }
          }
        ]);
      } catch (err) {
        console.error("Error fetching novels by views:", err);
        // Continue with empty array if this fails
        hotNovels = [];
      }
    } else {
      // For alltime, use total views
      try {
        hotNovels = await Novel.aggregate([
          // Match only novels with total views
          { $match: { "views.total": { $exists: true, $gt: 0 } } },
          // Sort by total views
          { $sort: { "views.total": -1 } },
          // Limit to top 5
          { $limit: 5 },
          // Lookup latest chapters
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
                { $limit: 1 },
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
          // Project final fields
          {
            $project: {
              _id: 1,
              title: 1,
              illustration: 1,
              status: 1,
              updatedAt: 1,
              chapters: 1,
              dailyViews: "$views.total",
              source: { $literal: "views" }
            }
          }
        ]);
      } catch (err) {
        console.error("Error fetching novels by all-time views:", err);
        // Continue with empty array if this fails
        hotNovels = [];
      }
    }
    
    // Check if we need to add more novels
    if (hotNovels.length < 5) {
      // Calculate how many more novels we need
      const remainingCount = 5 - hotNovels.length;
      
      // Get IDs of novels we already have to exclude them
      const existingNovelIds = hotNovels.map(novel => novel._id);
      
      try {
        // Find most recently updated novels that aren't already in our list
        const recentNovels = await Novel.aggregate([
          {
            $match: {
              _id: { $nin: existingNovelIds.map(id => new mongoose.Types.ObjectId(id)) }
            }
          },
          // Sort by updatedAt (most recent first)
          { $sort: { updatedAt: -1 } },
          // Limit to what we need
          { $limit: remainingCount },
          // Lookup latest chapters
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
                { $limit: 1 },
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
          // Project the same fields as hotNovels
          {
            $project: {
              _id: 1,
              title: 1,
              illustration: 1,
              status: 1,
              updatedAt: 1,
              chapters: 1,
              dailyViews: { $literal: 0 },
              source: { $literal: "recent" }
            }
          }
        ]);
        
        // Combine the two sets of novels
        hotNovels = [...hotNovels, ...recentNovels];
      } catch (err) {
        console.error("Error fetching recent novels:", err);
      }
    }
    
    const result = { novels: hotNovels };
    
    // Cache the result only if not bypassing
    if (!bypass) {
      cache.set(cacheKey, result);
    }
    
    res.json(result);
  } catch (err) {
    console.error("Error in GET /api/novels/hot:", err);
    res.status(500).json({
      novels: [],
      error: err.message
    });
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

    const response = {
      novels,
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
 * Get single novel and increment view count
 * @route GET /api/novels/:id
 */
router.get("/:id", async (req, res) => {
  try {
    // Get novel and modules in parallel with proper projection
    const [novel, modules] = await Promise.all([
      Novel.findById(req.params.id)
        .select('title description alternativeTitles author illustrator illustration status active inactive genres note updatedAt createdAt views ratings novelBalance novelBudget')
        .lean(),
      Module.find({ novelId: req.params.id })
        .select('title illustration order chapters mode moduleBalance')
        .sort('order')
        .lean()
    ]);

    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Get chapters with minimal fields needed
    const chapters = await Chapter.find({ 
      novelId: req.params.id 
    })
    .select('title moduleId order createdAt updatedAt mode chapterBalance')
    .sort('order')
    .lean();

    // Organize chapters by module
    const chaptersByModule = chapters.reduce((acc, chapter) => {
      const moduleId = chapter.moduleId.toString();
      if (!acc[moduleId]) {
        acc[moduleId] = [];
      }
      acc[moduleId].push(chapter);
      return acc;
    }, {});

    // Attach chapters to their modules
    const modulesWithChapters = modules.map(module => ({
      ...module,
      chapters: chaptersByModule[module._id.toString()] || []
    }));

    // Return combined data
    res.json({
      novel,
      modules: modulesWithChapters
    });

    // Increment view count after sending response
    if (req.query.skipViewTracking !== 'true') {
      // Find the full document (not lean) and use the model method
      Novel.findById(req.params.id)
        .then(fullNovel => {
          if (fullNovel) {
            return fullNovel.incrementViews();
          }
        })
        .catch(err => console.error('Error updating view count:', err));
    }
  } catch (err) {
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
 * Get a specific chapter of a novel
 * @route GET /api/novels/:id/chapters/:chapterId
 */
router.get("/:id/chapters/:chapterId", async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const chapter = novel.chapters.find(
      (ch) => ch._id.toString() === req.params.chapterId
    );
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    res.json(chapter);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Add a new chapter to a novel
 * @route POST /api/novels/:id/chapters
 */
router.post("/:id/chapters", auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const { title, content } = req.body;

    const newChapter = {
      title,
      content,
      createdAt: new Date(),
    };

    novel.chapters.push(newChapter);
    novel.updatedAt = new Date();

    await novel.save();
    res.status(201).json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Update a chapter
 * @route PUT /api/novels/:id/chapters/:chapterId
 */
router.put("/:id/chapters/:chapterId", auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const chapterIndex = novel.chapters.findIndex(
      (ch) => ch._id.toString() === req.params.chapterId
    );

    if (chapterIndex === -1) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    const { title, content } = req.body;
    novel.chapters[chapterIndex].title = title;
    novel.chapters[chapterIndex].content = content;
    novel.chapters[chapterIndex].updatedAt = new Date();

    await novel.save();
    res.json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Delete a chapter
 * @route DELETE /api/novels/:id/chapters/:chapterId
 */
router.delete("/:id/chapters/:chapterId", auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const chapterIndex = novel.chapters.findIndex(
      (ch) => ch._id.toString() === req.params.chapterId
    );

    if (chapterIndex === -1) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    novel.chapters.splice(chapterIndex, 1);
    await novel.save();
    res.json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
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

/**
 * Force refresh all novel data
 * @route GET /api/novels/refresh
 */
router.get("/refresh", auth, async (req, res) => {
  try {
    // Clear all novel caches
    clearNovelCaches();
    
    // Notify clients
    notifyAllClients('refresh', { 
      timestamp: new Date().toISOString(),
      message: 'All novel data has been refreshed'
    });
    
    res.json({ 
      success: true, 
      message: 'All caches cleared and clients notified' 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: err.message 
    });
  }
});

/**
 * Force browser refresh timestamp
 * @route GET /api/novels/browser-refresh
 */
router.get("/browser-refresh", async (req, res) => {
  try {
    // This endpoint just returns a new timestamp that clients can use
    // to force their browser to bypass any caching
    const timestamp = new Date().getTime();
    
    // Set aggressive no-cache headers
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '-1');
    res.set('Surrogate-Control', 'no-store');
    
    res.json({ 
      timestamp,
      cacheBuster: `_cb=${timestamp}`,
      message: 'Add this cacheBuster to your API requests to force fresh data'
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: err.message 
    });
  }
});

/**
 * Toggle like status for a novel
 * Increments/decrements the novel's like count based on user action
 * @route POST /api/novels/:id/like
 */
router.post("/:id/like", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find existing interaction or create new one
    let interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      // Create new interaction with liked=true
      interaction = new UserNovelInteraction({
        userId,
        novelId,
        liked: true
      });
      await interaction.save();
      
      // Increment novel likes count
      await Novel.findByIdAndUpdate(novelId, { $inc: { likes: 1 } });
      
      return res.status(200).json({ 
        liked: true, 
        likes: novel.likes + 1 
      });
    } else {
      // Toggle existing interaction
      const newLikedStatus = !interaction.liked;
      interaction.liked = newLikedStatus;
      await interaction.save();
      
      // Update novel likes count accordingly
      const updateVal = newLikedStatus ? 1 : -1;
      const updatedNovel = await Novel.findByIdAndUpdate(
        novelId, 
        { $inc: { likes: updateVal } },
        { new: true }
      );
      
      return res.status(200).json({ 
        liked: newLikedStatus, 
        likes: updatedNovel.likes 
      });
    }
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Rate a novel
 * Updates the novel's rating statistics
 * @route POST /api/novels/:id/rate
 */
router.post("/:id/rate", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;
    const { rating } = req.body;
    
    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find existing interaction or create new one
    let interaction = await UserNovelInteraction.findOne({ userId, novelId });
    let prevRating = 0;
    
    if (!interaction) {
      // Create new interaction with provided rating
      interaction = new UserNovelInteraction({
        userId,
        novelId,
        rating
      });
      
      // Update novel's rating statistics
      await Novel.findByIdAndUpdate(novelId, {
        $inc: {
          'ratings.total': 1,
          'ratings.value': rating
        }
      });
    } else {
      // Get previous rating if exists
      prevRating = interaction.rating || 0;
      
      // Update interaction with new rating
      interaction.rating = rating;
      
      if (prevRating > 0) {
        // Update rating value by removing previous and adding new
        await Novel.findByIdAndUpdate(novelId, {
          $inc: {
            'ratings.value': (rating - prevRating)
          }
        });
      } else {
        // First time rating, increment total and add value
        await Novel.findByIdAndUpdate(novelId, {
          $inc: {
            'ratings.total': 1,
            'ratings.value': rating
          }
        });
      }
    }
    
    await interaction.save();
    
    // Get updated novel to calculate average
    const updatedNovel = await Novel.findById(novelId);
    const averageRating = updatedNovel.ratings.total > 0 
      ? (updatedNovel.ratings.value / updatedNovel.ratings.total).toFixed(1) 
      : '0.0';
    
    return res.status(200).json({
      rating,
      ratingsCount: updatedNovel.ratings.total,
      averageRating
    });
  } catch (err) {
    console.error("Error rating novel:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Remove rating from a novel
 * Updates the novel's rating statistics
 * @route DELETE /api/novels/:id/rate
 */
router.delete("/:id/rate", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find existing interaction
    const interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction || !interaction.rating) {
      return res.status(404).json({ message: "No rating found for this novel" });
    }
    
    const prevRating = interaction.rating;
    
    // Remove rating from interaction
    interaction.rating = null;
    await interaction.save();
    
    // Update novel's rating statistics
    await Novel.findByIdAndUpdate(novelId, {
      $inc: {
        'ratings.total': -1,
        'ratings.value': -prevRating
      }
    });
    
    // Get updated novel to calculate average
    const updatedNovel = await Novel.findById(novelId);
    const averageRating = updatedNovel.ratings.total > 0 
      ? (updatedNovel.ratings.value / updatedNovel.ratings.total).toFixed(1) 
      : '0.0';
    
    return res.status(200).json({
      ratingsCount: updatedNovel.ratings.total,
      averageRating
    });
  } catch (err) {
    console.error("Error removing rating:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get user's interaction with a novel (like status and rating)
 * @route GET /api/novels/:id/interaction
 */
router.get("/:id/interaction", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;

    // Find interaction
    const interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      return res.json({ liked: false, rating: null });
    }
    
    return res.json({
      liked: interaction.liked || false,
      rating: interaction.rating || null
    });
  } catch (err) {
    console.error("Error getting user interaction:", err);
    res.status(500).json({ message: err.message });
  }
});

// Add this route to get approved contributions and requests for a novel
router.get('/:novelId/contributions', async (req, res) => {
  try {
    const novelId = req.params.novelId;
    
    // Find the novel
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }
    
    // PART 1: Find approved contributions for open and web requests
    // Find requests for this novel (open and web types)
    const openWebRequests = await Request.find({ 
      novel: novelId, 
      type: { $in: ['open', 'web'] }
    })
    .select('_id')
    .lean();
    
    let contributions = [];
    if (openWebRequests && openWebRequests.length > 0) {
      // Get request IDs
      const requestIds = openWebRequests.map(req => req._id);
      
      // Find approved contributions for these requests
      contributions = await Contribution.find({ 
        request: { $in: requestIds },
        status: 'approved'
      })
      .populate('user', 'username avatar')
      .populate('request', 'type title')
      .sort({ updatedAt: -1 })
      .lean();
    }
    
    // PART 2: Find approved 'new' requests for this novel
    const approvedNewRequests = await Request.find({ 
      novel: novelId, 
      type: 'new',
      status: 'approved'
    })
    .populate('user', 'username avatar')
    .lean();
    
    // Handle 'new' request deposits as contributions
    const newRequestDeposits = approvedNewRequests.map(request => ({
      _id: request._id + '_deposit', // Create unique ID
      user: request.user,
      amount: request.deposit,
      status: 'approved',
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      request: {
        _id: request._id,
        type: 'new',
        title: 'Yêu cầu truyện mới'
      },
      note: 'Tiền cọc yêu cầu truyện mới',
      isDeposit: true
    }));
    
    // Find approved contributions for all 'new' requests
    let newRequestContributions = [];
    if (approvedNewRequests.length > 0) {
      const newRequestIds = approvedNewRequests.map(req => req._id);
      
      newRequestContributions = await Contribution.find({ 
        request: { $in: newRequestIds },
        status: 'approved'
      })
      .populate('user', 'username avatar')
      .populate('request', 'type title')
      .lean();
    }
    
    // PART 3: Find approved open requests for this novel with module/chapter info
    const approvedOpenRequests = await Request.find({ 
      novel: novelId, 
      type: 'open',
      status: 'approved'
    })
    .populate('user', 'username avatar')
    .populate('module', 'title')
    .populate('chapter', 'title')
    .sort({ updatedAt: -1 })
    .lean();
    
    // Combine all contributions
    const allContributions = [
      ...contributions,
      ...newRequestContributions,
      ...newRequestDeposits
    ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    // Return all data
    return res.json({ 
      contributions: allContributions,
      requests: approvedOpenRequests
    });
  } catch (error) {
    console.error('Error fetching novel contributions:', error);
    return res.status(500).json({ message: 'Failed to fetch contributions' });
  }
});

/**
 * Contribute to novel budget
 * @route POST /api/novels/:id/contribute
 */
router.post("/:id/contribute", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;
    const { amount, note } = req.body;

    // Validate amount
    if (!amount || amount < 10) {
      return res.status(400).json({ message: "Số lượng đóng góp tối thiểu là 10 🌾" });
    }

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Check user balance
    const User = mongoose.model('User');
    const user = await User.findById(userId);
    if (!user || user.balance < amount) {
      return res.status(400).json({ message: "Số dư không đủ để thực hiện đóng góp này" });
    }

    // Start transaction
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Deduct from user balance
      await User.findByIdAndUpdate(userId, {
        $inc: { balance: -amount }
      }, { session });

      // Add to novel budget and balance
      const updatedNovel = await Novel.findByIdAndUpdate(novelId, {
        $inc: { 
          novelBudget: amount,
          novelBalance: amount 
        }
      }, { session, new: true });

      // Create contribution record
      await ContributionHistory.create([{
        novelId,
        userId,
        amount,
        note: note || 'Đóng góp cho truyện',
        budgetAfter: updatedNovel.novelBudget,
        type: 'user'
      }], { session });

      // Create novel transaction record
      await createNovelTransaction({
        novel: novelId,
        amount,
        type: 'contribution',
        description: note || 'Đóng góp cho truyện',
        balanceAfter: updatedNovel.novelBalance,
        performedBy: userId
      }, session);

      await session.commitTransaction();

      // Check for auto-unlock after contribution
      await checkAndUnlockContent(novelId);

      // Notify clients of the update
      notifyAllClients('novel_budget_updated', { 
        novelId, 
        newBudget: updatedNovel.novelBudget,
        newBalance: updatedNovel.novelBalance 
      });

      res.json({ 
        success: true, 
        novelBudget: updatedNovel.novelBudget,
        novelBalance: updatedNovel.novelBalance,
        message: "Đóng góp thành công!" 
      });

    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }

  } catch (err) {
    console.error("Error contributing to novel:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get contribution history for a novel
 * @route GET /api/novels/:id/contribution-history
 */
router.get("/:id/contribution-history", async (req, res) => {
  try {
    const novelId = req.params.id;

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find contribution history for this novel
    const contributions = await ContributionHistory.find({ novelId })
      .populate('userId', 'username avatar')
      .sort({ createdAt: -1 })
      .limit(50) // Limit to last 50 contributions
      .lean();

    // Format the response
    const formattedContributions = contributions.map(contribution => ({
      _id: contribution._id,
      user: contribution.userId,
      amount: contribution.amount,
      note: contribution.note,
      budgetAfter: contribution.budgetAfter,
      type: contribution.type,
      createdAt: contribution.createdAt,
      updatedAt: contribution.updatedAt
    }));

    res.json({ contributions: formattedContributions });

  } catch (err) {
    console.error("Error fetching contribution history:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Auto-unlock content based on novel budget
 * This function checks if any paid modules/chapters can be unlocked in sequential order
 * It stops at the first paid content that cannot be afforded
 */
export async function checkAndUnlockContent(novelId) {
  try {
    const novel = await Novel.findById(novelId);
    if (!novel || novel.novelBudget <= 0) return;

    // Get all modules for this novel, sorted by order
    const modules = await Module.find({ novelId })
      .sort({ order: 1 })
      .lean();

    let remainingBudget = novel.novelBudget;
    let unlocked = false;

    for (const module of modules) {
      // If module is paid, try to unlock it first
      if (module.mode === 'paid') {
        if (remainingBudget >= module.moduleBalance) {
          // Unlock the module by changing mode to published
          await Module.findByIdAndUpdate(module._id, { mode: 'published' });
          remainingBudget -= module.moduleBalance;
          unlocked = true;

          // Create system contribution record
          await ContributionHistory.create({
            novelId,
            userId: null, // System action
            amount: -module.moduleBalance,
            note: `Mở khóa tự động: ${module.title}`,
            budgetAfter: remainingBudget,
            type: 'system'
          });

          // Notify clients
          notifyAllClients('module_unlocked', { 
            novelId, 
            moduleId: module._id,
            moduleTitle: module.title 
          });

          // Continue to check chapters in this now-unlocked module
        } else {
          // Cannot afford this module, stop here (sequential unlock)
          break;
        }
      }

      // If module is published (free or just unlocked), check its chapters in order
      if (module.mode === 'published') {
        // Get chapters for this module, sorted by order
        const chapters = await Chapter.find({ moduleId: module._id })
          .sort({ order: 1 })
          .lean();

        for (const chapter of chapters) {
          // If chapter is paid, try to unlock it
          if (chapter.mode === 'paid') {
            if (remainingBudget >= chapter.chapterBalance) {
              // Unlock the chapter by changing mode to published
              await Chapter.findByIdAndUpdate(chapter._id, { mode: 'published' });
              remainingBudget -= chapter.chapterBalance;
              unlocked = true;

              // Create system contribution record
              await ContributionHistory.create({
                novelId,
                userId: null, // System action
                amount: -chapter.chapterBalance,
                note: `Mở khóa tự động: ${chapter.title}`,
                budgetAfter: remainingBudget,
                type: 'system'
              });

              // Notify clients
              notifyAllClients('chapter_unlocked', { 
                novelId, 
                moduleId: module._id,
                chapterId: chapter._id,
                chapterTitle: chapter.title 
              });
            } else {
              // Cannot afford this chapter, stop here (sequential unlock)
              // This means we cannot proceed to the next module either
              return await Novel.findByIdAndUpdate(novelId, { novelBudget: remainingBudget });
            }
          }
          // If chapter is already published, continue to next chapter
        }
      }
    }

    // Update novel budget if anything was unlocked
    if (unlocked) {
      await Novel.findByIdAndUpdate(novelId, { novelBudget: remainingBudget });
    }

  } catch (error) {
    console.error('Error in auto-unlock:', error);
  }
}

export default router;
