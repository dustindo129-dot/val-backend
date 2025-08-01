import express from "express";
import Novel from "../models/Novel.js";
import { auth, optionalAuth } from "../middleware/auth.js";
import admin from "../middleware/admin.js";
import Chapter from "../models/Chapter.js";
import Module from "../models/Module.js";
import { cache, clearNovelCaches, notifyAllClients, shouldBypassCache } from '../utils/cacheUtils.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import { addClient, removeClient, sseClients, broadcastEvent, listConnectedClients, performHealthCheck, analyzeTabBehavior, getTabConnectionHistory, isTabBlocked, trackIgnoredDuplicate } from '../services/sseService.js';
import Request from '../models/Request.js';
import Contribution from '../models/Contribution.js';
import { createNovelTransaction } from '../routes/novelTransactions.js';
import { createTransaction } from '../routes/userTransaction.js';
import ContributionHistory from '../models/ContributionHistory.js';
import Comment from '../models/Comment.js';
import mongoose from 'mongoose';
import Gift from '../models/Gift.js';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import { getCachedUserByUsername, clearUserCache } from '../utils/userCache.js';
import { populateStaffNames } from '../utils/populateStaffNames.js';
import { checkAndSwitchRentModuleToPublished, conditionallyRecalculateRentBalance } from './modules.js';

/**
 * Import the functions from modules.js
 * - calculateAndUpdateModuleRentBalance: For initial rentBalance calculation when module is set to rent mode
 * - checkAndSwitchRentModuleToPublished: For checking auto-switch without recalculating rentBalance
 */

const router = express.Router();

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

/**
 * Utility function to validate ObjectId and send error response if invalid
 */
const validateObjectId = (id, res, fieldName = 'ID') => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ message: `Invalid ${fieldName} format` });
    return false;
  }
  return true;
};

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

// Add debug endpoint before SSE endpoint
router.get('/debug/tab/:tabId', async (req, res) => {
  try {
    const { tabId } = req.params;
    const analysis = analyzeTabBehavior(tabId);
    
    if (!analysis) {
      return res.status(404).json({ error: 'Tab not found or no history available' });
    }
    
    res.json({
      tabId,
      analysis: {
        totalEvents: analysis.history.length,
        stats: analysis.stats,
        recentEvents: analysis.history.slice(-20),
        summary: {
          connectionsPerMinute: analysis.stats ? (analysis.stats.totalConnections / Math.max(1, (Date.now() - analysis.history[0]?.timestamp) / 60000)).toFixed(2) : 0,
          avgReconnectInterval: analysis.stats?.connectionFrequency.length > 0 
            ? Math.round(analysis.stats.connectionFrequency.reduce((a, b) => a + b, 0) / analysis.stats.connectionFrequency.length)
            : 0
        }
      }
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Debug endpoint to analyze the problematic tab specifically 
router.get('/debug/problematic-tab', async (req, res) => {
  try {
    const problematicTabId = 'tab_1749148822653_8oekv3a0';
    const analysis = analyzeTabBehavior(problematicTabId);
    
    if (!analysis) {
      return res.json({ 
        message: `No connection history found for tab ${problematicTabId}`,
        tabId: problematicTabId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      tabId: problematicTabId,
      timestamp: new Date().toISOString(),
      analysis: {
        totalEvents: analysis.history.length,
        stats: analysis.stats,
        recentEvents: analysis.history.slice(-20),
        allEvents: analysis.history, // Include all events for this specific tab
        summary: {
          connectionsPerMinute: analysis.stats ? (analysis.stats.totalConnections / Math.max(1, (Date.now() - analysis.history[0]?.timestamp) / 60000)).toFixed(2) : 0,
          avgReconnectInterval: analysis.stats?.connectionFrequency.length > 0 
            ? Math.round(analysis.stats.connectionFrequency.reduce((a, b) => a + b, 0) / analysis.stats.connectionFrequency.length)
            : 0,
          isCurrentlyProblematic: analysis.stats?.connectionFrequency.some(interval => interval < 5000) || false
        }
      }
    });
  } catch (error) {
    console.error('Error in problematic tab debug endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle CORS preflight for SSE endpoint
router.options('/sse', (req, res) => {
  // Main CORS middleware handles most of this, just send success response
  res.status(200).end();
});

// Server-Sent Events endpoint for real-time updates
router.get('/sse', async (req, res) => {
  // AUTHENTICATION: Extract and validate JWT token (from URL params since EventSource doesn't support headers)
  let userId = null;
  const token = req.query.token;
  
  if (token) {
    try {
      const jwt = await import('jsonwebtoken');
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
      userId = decoded.userId;
    } catch (error) {
      // Authentication failed - SSE connections should be authenticated
      return res.status(401).json({ error: 'Authentication required for SSE connection' });
    }
  } else {
    // No authentication provided
    return res.status(401).json({ error: 'Authentication required for SSE connection' });
  }

  // Pre-check connection limits per IP (prevent abuse)
  const clientIP = req.ip || req.socket.remoteAddress;
  const clientsFromSameIP = Array.from(sseClients).filter(existingClient => 
    existingClient.info?.ip === clientIP
  ).length;
  
  if (clientsFromSameIP > 20) {
    return res.status(429).json({ error: 'Too many connections from this IP', maxConnections: 20 });
  }

  // Pre-check if this tab is blocked
  const tabId = req.query.tabId || `manual_${Date.now()}`;
  if (tabId && tabId !== 'unknown') {
    if (isTabBlocked(tabId)) {
      return res.status(429).json({ 
        error: 'Tab temporarily blocked due to repeated duplicate event ignoring',
        tabId: tabId,
        message: 'Please close other tabs and wait before reconnecting'
      });
    }
  }

  // Set SSE headers (CORS is handled by main middleware)
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'Pragma': 'no-cache',
    'Expires': '0'
  };

  try {
    res.writeHead(200, headers);
  } catch (writeError) {
    console.error('Failed to write SSE headers:', writeError);
    return;
  }

  // Create client object with additional info including userId
  const client = {
    res,
    info: {
      userId: userId, // Associate connection with authenticated user
      tabId: req.query.tabId || 'unknown',
      ip: req.ip,
      timestamp: Date.now(),
      url: req.originalUrl
    }
  };

  // Update client info with parsed data
  client.info = {
    ...client.info,
    ip: clientIP, // Use the pre-validated IP
    userAgent: req.headers['user-agent'] || client.info.userAgent || 'unknown',
    tabId: tabId, // Use the pre-validated tabId
    userId: userId, // Ensure userId is set
    timestamp: client.info.timestamp
  };

  // Note: All validation checks have been moved to pre-validation section above
  // to prevent ERR_HTTP_HEADERS_SENT errors

  // Check if this might be a rapid reconnection (monitoring only, no blocking)
  if (tabId && tabId !== 'unknown') {
    const history = getTabConnectionHistory(tabId);
    if (history.stats && history.stats.lastConnectionTime) {
      const timeSinceLastConnection = Date.now() - history.stats.lastConnectionTime;
      // Just track rapid reconnections without logging
    }
  }

  // Check for existing connections from the same tab
  const existingTabConnections = Array.from(sseClients).filter(existingClient => 
    existingClient.info?.tabId === client.info.tabId
  ).length;

  // Send initial connection message with client ID  
  const clientId = addClient(client);
  
  // Log successful SSE connection
  const totalConnections = sseClients.size;
  
  // Safely send initial message
  try {
    res.write(`data: ${JSON.stringify({ 
      message: 'Connected to novel updates',
      clientId: clientId,
      tabId: client.info.tabId,
      userId: userId,
      timestamp: Date.now() 
    })}\n\n`);
  } catch (writeError) {
    console.error('Failed to send initial SSE message:', writeError);
    removeClient(client);
    return;
  }

  // Send a ping every 15 seconds to keep the connection alive
  const pingInterval = setInterval(() => {
    // Skip ping if cleanup already happened
    if (cleanedUp) {
      clearInterval(pingInterval);
      return;
    }
    
    try {
      // Check if connection is still writable
      if (res.writableEnded || res.destroyed) {
        clearInterval(pingInterval);
        cleanup('connection ended');
        return;
      }
      
      res.write(`: heartbeat ${clientId}:${client.info.tabId}:${userId} ${Date.now()}\n\n`);
    } catch (error) {
      console.error('SSE ping error:', error);
      clearInterval(pingInterval);
      cleanup('ping error');
    }
  }, 15000);

  // Track cleanup state to prevent multiple calls
  let cleanedUp = false;
  
  // Handle multiple types of disconnection
  const cleanup = (reason = 'unknown') => {
    if (cleanedUp) {
      return; // Already cleaned up, prevent double execution
    }
    cleanedUp = true;
    
    clearInterval(pingInterval);
    removeClient(client);
    
    // Log SSE disconnection
    const totalConnections = sseClients.size;
  };

  // Handle client disconnect
  req.on('close', () => {
    cleanup('close_event');
  });

  req.on('error', (error) => {
    cleanup('error_event');
  });
  
  // Handle response errors
  res.on('error', (error) => {
    console.error('SSE response error:', error);
    cleanup('response error');
  });
  
  res.on('finish', () => cleanup('response finish'));
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
 * Get Vietnamese novels with proper filtering and sorting
 * @route GET /api/novels/vietnamese
 */
router.get("/vietnamese", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;
    const sortOrder = req.query.sortOrder || 'updated';

    // Check if we should bypass the cache
    const bypass = shouldBypassCache(req.path, req.query);
    
    const cacheKey = `vietnamese_novels_${page}_${limit}_${sortOrder}`;
    const cachedData = bypass ? null : cache.get(cacheKey);
    
    if (cachedData && !bypass) {
      return res.json(cachedData);
    }


    
    // Build sort criteria
    let sortCriteria = {};
    if (sortOrder === 'newest') {
      sortCriteria = { createdAt: -1 };
    } else if (sortOrder === 'updated') {
      sortCriteria = { updatedAt: -1 };
    } else if (sortOrder === 'rating') {
      // Sort by calculated average rating
      sortCriteria = { averageRating: -1 };
    }

    const [result] = await Novel.aggregate([
      // Match novels with "Vietnamese Novel" genre
      {
        $match: {
          genres: { $in: ['Vietnamese Novel'] }
        }
      },
      
      // Calculate average rating for sorting
      {
        $addFields: {
          averageRating: {
            $cond: {
              if: { $gt: ['$ratings.total', 0] },
              then: { $divide: ['$ratings.value', '$ratings.total'] },
              else: 0
            }
          }
        }
      },
      
      {
        $facet: {
          total: [{ $count: 'count' }],
          novels: [
            // Sort first
            { $sort: sortCriteria },
            
            // Then project needed fields
            {
              $project: {
                title: 1,
                illustration: 1,
                status: 1,
                genres: 1,
                description: 1,
                updatedAt: 1,
                createdAt: 1,
                averageRating: 1,
                'ratings.total': 1,
                'ratings.value': 1
              }
            },
            
            // Lookup latest chapters
            {
              $lookup: {
                from: 'chapters',
                let: { novelId: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: { 
                        $and: [
                          { $eq: ['$novelId', '$$novelId'] },
                          // Filter out draft chapters from Vietnamese novels display
                          { $ne: ['$mode', 'draft'] }
                        ]
                      }
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
            
            // First chapter for "first chapter" link
            {
              $lookup: {
                from: 'chapters',
                let: { novelId: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: { 
                        $and: [
                          { $eq: ['$novelId', '$$novelId'] },
                          // Also filter out draft chapters from first chapter link
                          { $ne: ['$mode', 'draft'] }
                        ]
                      }
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
            
            // Set firstChapter as single object
            {
              $addFields: {
                firstChapter: { $arrayElemAt: ['$firstChapter', 0] }
              }
            },
            
            // Apply pagination
            { $skip: skip },
            { $limit: limit }
          ]
        }
      }
    ]);

    const total = result.total[0]?.count || 0;
    const novels = result.novels || [];

    const response = {
      novels: novels,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit) || 1,
        totalItems: total
      }
    };

    // Cache the response
    if (!bypass) {
      cache.set(cacheKey, response);
    }

    res.json(response);
  } catch (err) {
    console.error("Error in GET /api/novels/vietnamese:", err);
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
          // Limit to top 15
          { $limit: 15 },
          // Lookup latest chapters
          {
            $lookup: {
              from: 'chapters',
              let: { novelId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: { 
                      $and: [
                        { $eq: ['$novelId', '$$novelId'] },
                        // Filter out draft chapters from hot novels display
                        { $ne: ['$mode', 'draft'] }
                      ]
                    }
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
          // Limit to top 15
          { $limit: 15 },
          // Lookup latest chapters
          {
            $lookup: {
              from: 'chapters',
              let: { novelId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: { 
                      $and: [
                        { $eq: ['$novelId', '$$novelId'] },
                        // Filter out draft chapters from hot novels display
                        { $ne: ['$mode', 'draft'] }
                      ]
                    }
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
    if (hotNovels.length < 15) {
      // Calculate how many more novels we need
      const remainingCount = 15 - hotNovels.length;
      
      // Get IDs of novels we already have to exclude them
      const existingNovelIds = hotNovels.map(novel => novel._id);
      
      try {
        // Find most recently updated novels that aren't already in our list
        const recentNovels = await Novel.aggregate([
          {
            $match: {
              _id: { $nin: existingNovelIds.map(id => 
                typeof id === 'string' ? mongoose.Types.ObjectId.createFromHexString(id) : id
              ) }
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
                    $expr: { 
                      $and: [
                        { $eq: ['$novelId', '$$novelId'] },
                        // Filter out draft chapters from recent novels display
                        { $ne: ['$mode', 'draft'] }
                      ]
                    }
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
router.get("/", optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Check if we should bypass cache
    const bypass = shouldBypassCache(req.path, req.query);
    console.log(`Novel list request: ${bypass ? 'Bypassing cache' : 'Using cache if available'}`);

    // Check if this is an admin dashboard request (needs full data) for admin/moderator users
    // Admin dashboard typically requests with limit=1000 and bypass=true and (skipPopulation=true OR includePaidInfo=true)
    const isAdminDashboardRequest = req.query.limit === '1000' && 
                                  req.query.bypass === 'true' && 
                                  (req.query.skipPopulation === 'true' || req.query.includePaidInfo === 'true');
    
    // SECURITY FIX: For pj_user, ONLY apply filtering if this is an admin dashboard request
    // Public browsing (homepage, novel directory) should show all novels to everyone including pj_user
    const isPjUser = req.user && req.user.role === 'pj_user';
    
    // For pj_user making admin dashboard requests, apply role-based filtering
    if (isPjUser && isAdminDashboardRequest) {
      console.log('pj_user request detected - applying role-based filtering');
      
      // Build the query conditions, only including defined values
      const queryConditions = [];
      
      // Always include the ObjectId as string
      if (req.user._id) {
        queryConditions.push({ 'active.pj_user': req.user._id.toString() });
      }
      
      // Only include user.id if it's defined
      if (req.user.id) {
        queryConditions.push({ 'active.pj_user': req.user.id });
      }
      
      // Only include username if it's defined
      if (req.user.username) {
        queryConditions.push({ 'active.pj_user': req.user.username });
      }
      
      // If no valid conditions, return empty result
      if (queryConditions.length === 0) {
        return res.json({
          novels: [],
          pagination: {
            currentPage: 1,
            totalPages: 1,
            totalItems: 0
          }
        });
      }
      
      // Check if paid content info is requested
      const includePaidInfo = req.query.includePaidInfo === 'true';
      
      // Find novels where the user is in active.pj_user array
      let userManagedNovels;
      
      if (includePaidInfo) {
        // Use aggregation to include paid content info for pj_user
        userManagedNovels = await Novel.aggregate([
          {
            $match: {
              $or: queryConditions
            }
          },
          // Lookup modules to check for paid content
          {
            $lookup: {
              from: 'modules',
              localField: '_id',
              foreignField: 'novelId',
              pipeline: [
                {
                  $project: {
                    mode: 1,
                    moduleBalance: 1,
                    rentBalance: 1
                  }
                }
              ],
              as: 'modules'
            }
          },
          // Lookup chapters to check for paid content
          {
            $lookup: {
              from: 'chapters',
              localField: '_id',
              foreignField: 'novelId',
              pipeline: [
                {
                  $project: {
                    mode: 1,
                    chapterBalance: 1,
                    moduleId: 1
                  }
                }
              ],
              as: 'chapters'
            }
          },
          // Add fields to check for paid content
          {
            $addFields: {
              hasPaidContent: {
                $or: [
                  // Check if any module has positive balance AND is still paid mode
                  {
                    $gt: [
                      {
                        $size: {
                          $filter: {
                            input: '$modules',
                            cond: { 
                              $and: [
                                { $gt: ['$$this.moduleBalance', 0] },
                                { $eq: ['$$this.mode', 'paid'] }
                              ]
                            }
                          }
                        }
                      },
                      0
                    ]
                  },
                  // Check if any chapter has positive balance AND is still paid mode
                  {
                    $gt: [
                      {
                        $size: {
                          $filter: {
                            input: '$chapters',
                            cond: { 
                              $and: [
                                { $gt: ['$$this.chapterBalance', 0] },
                                { $eq: ['$$this.mode', 'paid'] }
                              ]
                            }
                          }
                        }
                      },
                      0
                    ]
                  }
                ]
              },
              paidModulesCount: {
                $size: {
                  $filter: {
                    input: '$modules',
                    cond: { 
                      $and: [
                        { $gt: ['$$this.moduleBalance', 0] },
                        { $eq: ['$$this.mode', 'paid'] }
                      ]
                    }
                  }
                }
              },
              paidChaptersCount: {
                $size: {
                  $filter: {
                    input: '$chapters',
                    cond: { 
                      $and: [
                        { $gt: ['$$this.chapterBalance', 0] },
                        { $eq: ['$$this.mode', 'paid'] }
                      ]
                    }
                  }
                }
              }
            }
          },
          // Filter to only include novels with current paid content (if requested)
          ...(req.query.sortType === 'paid' ? [{
            $match: {
              $or: [
                { paidModulesCount: { $gt: 0 } },
                { paidChaptersCount: { $gt: 0 } }
              ]
            }
          }] : []),
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
              novelBudget: 1,
              hasPaidContent: 1,
              paidModulesCount: 1,
              paidChaptersCount: 1,
              availableForRent: 1
            }
          },
          { $sort: { updatedAt: -1 } }
        ]);
      } else {
        // Use simple find for pj_user without paid content info
        userManagedNovels = await Novel.find({
          $or: queryConditions
        })
        .select('title illustration author illustrator status genres alternativeTitles updatedAt createdAt description note active inactive novelBalance novelBudget availableForRent')
        .sort({ updatedAt: -1 })
        .lean();
      }

      // Skip expensive chapter lookups and staff population for pj_user - they don't need them for dashboard
      const skipPopulation = req.query.skipPopulation === 'true';
      const finalNovels = skipPopulation ? userManagedNovels : await Promise.all(
        userManagedNovels.map(novel => populateStaffNames(novel))
      );

      const response = {
        novels: finalNovels,
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalItems: finalNovels.length
        }
      };

      return res.json(response);
    }

    // Note: isAdminDashboardRequest is already defined above with more secure logic
    
    // Check if this is a novel directory request (needs word count)
    // Novel directory typically requests with limit=1000 but no skipPopulation
    const isNovelDirectoryRequest = req.query.limit === '1000' && !req.query.skipPopulation;
    
    // Check if paid content info is requested
    const includePaidInfo = req.query.includePaidInfo === 'true';
    
    // Use lightweight query for homepage and novel directory (public access)
    if (!isAdminDashboardRequest) {
      // Generate cache key based on pagination and request type
      const requestType = isNovelDirectoryRequest ? 'directory' : 'homepage';
      const cacheKey = `novels_page_${page}_limit_${limit}_${requestType}`;
      const cachedData = bypass ? null : cache.get(cacheKey);
      
      if (cachedData && !bypass) {
        console.log('Serving novel list from cache');
        return res.json(cachedData);
      }

      console.log('Fetching fresh novel list data from database');

      // Create projection based on request type
      const projection = {
        title: 1,
        illustration: 1,
        status: 1,
        genres: 1,
        description: 1,
        updatedAt: 1
        // Only fields actually used on homepage/directory
        // Exclude: note, active, inactive, novelBalance, novelBudget, author, illustrator, alternativeTitles, createdAt
      };
      
      // Add wordCount and views for novel directory requests
      if (isNovelDirectoryRequest) {
        projection.wordCount = 1;
        projection.views = 1;
      }

      const [result] = await Novel.aggregate([
        {
          $facet: {
            total: [{ $count: 'count' }],
            novels: [
              {
                $project: projection
              },
              // Latest chapters for display (homepage shows up to 3)
              {
                $lookup: {
                  from: 'chapters',
                  let: { novelId: '$_id' },
                  pipeline: [
                    {
                      $match: {
                        $expr: { 
                          $and: [
                            { $eq: ['$novelId', '$$novelId'] },
                            // Filter out draft chapters from homepage display
                            { $ne: ['$mode', 'draft'] }
                          ]
                        }
                      }
                    },
                    { $sort: { createdAt: -1 } },
                    { $limit: 3 }, // Homepage shows latest 3 non-draft chapters
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
              // First chapter for "first chapter" link
              {
                $lookup: {
                  from: 'chapters',
                  let: { novelId: '$_id' },
                  pipeline: [
                    {
                      $match: {
                        $expr: { 
                          $and: [
                            { $eq: ['$novelId', '$$novelId'] },
                            // Also filter out draft chapters from first chapter link
                            { $ne: ['$mode', 'draft'] }
                          ]
                        }
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
              // Set firstChapter as single object (not array)
              {
                $addFields: {
                  firstChapter: { $arrayElemAt: ['$firstChapter', 0] }
                }
              },
              // Sort by latest activity
              { $sort: { updatedAt: -1 } },
              // Apply pagination
              { $skip: skip },
              { $limit: limit }
            ]
          }
        }
      ]);

      const homepageTotal = result.total[0]?.count || 0;
      const homepageNovels = result.novels;

      const response = {
        novels: homepageNovels,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(homepageTotal / limit),
          totalItems: homepageTotal
        }
      };

      // Cache the response
      if (!bypass) {
        cache.set(cacheKey, response);
        console.log('Cached lightweight novel list data');
      }

      return res.json(response);
    }

    // For admin/moderator/regular users, use the full aggregation
    // Note: pj_user can reach this section for public browsing (homepage, novel directory)
    // Generate cache key based on pagination, user role, and paid content info
    const cacheKey = `novels_page_${page}_limit_${limit}_${req.user?.role || 'guest'}_paid_${includePaidInfo}`;
    const cachedData = bypass ? null : cache.get(cacheKey);
    
    if (cachedData && !bypass) {
      console.log('Serving novel list from cache');
      return res.json(cachedData);
    }

    console.log('Fetching fresh novel list data from database');

    // Full aggregation for admin dashboard requests ONLY

    // Build aggregation pipeline with optional paid content info
    const aggregationPipeline = [];
    
    // If paid content info is requested, add lookups for modules and chapters
    // Note: Only modules/chapters with positive balances are considered "paid content"
    if (includePaidInfo) {
      aggregationPipeline.push(
        // Lookup modules to check for paid content
        {
          $lookup: {
            from: 'modules',
            localField: '_id',
            foreignField: 'novelId',
            pipeline: [
              {
                $project: {
                  mode: 1,
                  moduleBalance: 1,
                  rentBalance: 1
                }
              }
            ],
            as: 'modules'
          }
        },
        // Lookup chapters to check for paid content
        {
          $lookup: {
            from: 'chapters',
            localField: '_id',
            foreignField: 'novelId',
            pipeline: [
              {
                $project: {
                  mode: 1,
                  chapterBalance: 1,
                  moduleId: 1
                }
              }
            ],
            as: 'chapters'
          }
        },
        // Add fields to check for paid content
        {
          $addFields: {
            hasPaidContent: {
              $or: [
                // Check if any module has positive balance AND is still paid mode
                {
                  $gt: [
                    {
                      $size: {
                        $filter: {
                          input: '$modules',
                          cond: { 
                            $and: [
                              { $gt: ['$$this.moduleBalance', 0] },
                              { $eq: ['$$this.mode', 'paid'] }
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                },
                // Check if any chapter has positive balance AND is still paid mode
                {
                  $gt: [
                    {
                      $size: {
                        $filter: {
                          input: '$chapters',
                          cond: { 
                            $and: [
                              { $gt: ['$$this.chapterBalance', 0] },
                              { $eq: ['$$this.mode', 'paid'] }
                            ]
                          }
                        }
                      }
                    },
                    0
                  ]
                }
              ]
            },
            paidModulesCount: {
              $size: {
                $filter: {
                  input: '$modules',
                  cond: { 
                    $and: [
                      { $gt: ['$$this.moduleBalance', 0] },
                      { $eq: ['$$this.mode', 'paid'] }
                    ]
                  }
                }
              }
            },
            paidChaptersCount: {
              $size: {
                $filter: {
                  input: '$chapters',
                  cond: { 
                    $and: [
                      { $gt: ['$$this.chapterBalance', 0] },
                      { $eq: ['$$this.mode', 'paid'] }
                    ]
                  }
                }
              }
            }
          }
        }
      );
    }

    // Add filtering stage after paid content calculations when paid content info is requested
    if (includePaidInfo) {
      aggregationPipeline.push({
        $match: {
          $or: [
            { paidModulesCount: { $gt: 0 } },
            { paidChaptersCount: { $gt: 0 } }
          ]
        }
      });
    }

    // Get novels and total count in a single aggregation
    const [result] = await Novel.aggregate([
      // Add the paid content lookups if requested
      ...aggregationPipeline,
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
                novelBudget: 1,
                // Include paid content fields if requested
                ...(includePaidInfo ? {
                  hasPaidContent: 1,
                  paidModulesCount: 1,
                  paidChaptersCount: 1,
                  availableForRent: 1
                } : {}),
                // Always include availableForRent for rental checkbox
                ...(!includePaidInfo ? { availableForRent: 1 } : {})
              }
            },
            // Admin dashboard doesn't need chapter data - skip expensive chapter lookups
            // Sort by updatedAt directly (no need for complex latestActivity calculation)
            { $sort: { updatedAt: -1 } },
            // Apply pagination
            { $skip: skip },
            { $limit: limit }
          ]
        }
      }
    ]);

    const total = result.total[0]?.count || 0;
    const novels = result.novels;

    // Check if we should skip staff population (for admin editing or paid content filtering)
    const skipPopulation = req.query.skipPopulation === 'true' || includePaidInfo;
    
    // Populate staff names for all novels unless skipPopulation is requested or when only paid content info is needed
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
router.post("/", [auth, admin], async (req, res) => {
  try {
    // Only admins and moderators can create novels (since this involves staff assignment)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ 
        message: 'Only admins and moderators can create novels' 
      });
    }

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

    // Auto-promote users to pj_user role when assigned as project managers
    // Note: Admins/moderators assigned as pj_user maintain their higher roles (no downgrade)
    if (active?.pj_user && Array.isArray(active.pj_user)) {
      const User = mongoose.model('User');
      
      // Find users who are being assigned as pj_user
      const newPjUsers = [];
      
      for (const pjUserItem of active.pj_user) {
        // Check if this is a MongoDB ObjectId (not a text string)
        if (mongoose.Types.ObjectId.isValid(pjUserItem)) {
          try {
            const user = await User.findById(pjUserItem);
            if (user && user.role === 'user') {
              // Only promote regular users to pj_user 
              // Admins/moderators maintain their higher roles (no downgrade)
              newPjUsers.push(user);
            }
          } catch (userError) {
            console.warn(`Error checking user ${pjUserItem}:`, userError);
          }
        }
      }
      
      // Promote users to pj_user role
      if (newPjUsers.length > 0) {
        try {
          await User.updateMany(
            { _id: { $in: newPjUsers.map(u => u._id) } },
            { $set: { role: 'pj_user' } }
          );
          
        } catch (updateError) {
          console.error('Error promoting users to pj_user role:', updateError);
          // Don't fail the novel creation if role promotion fails
        }
      }
    }

    const novel = new Novel({
      title,
      alternativeTitles: alternativeTitles || [],
      author,
      illustrator,
      active: {
        pj_user: active?.pj_user || [],
        translator: active?.translator || [],
        editor: active?.editor || [],
        proofreader: active?.proofreader || []
      },
      inactive: {
        pj_user: inactive?.pj_user || [],
        translator: inactive?.translator || [],
        editor: inactive?.editor || [],
        proofreader: inactive?.proofreader || []
      },
      genres: genres || [],
      description,
      note,
      illustration,
      status: status || 'Ongoing',
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
    
    // Validate ObjectId format before proceeding
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(`novel:${novelId}`, async () => {
      // Use a single aggregation pipeline to get all required data in one query
      const [novelWithData] = await Novel.aggregate([
        // Match the specific novel
        {
          $match: { _id: mongoose.Types.ObjectId.createFromHexString(novelId) }
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
                  moduleBalance: 1,
                  rentBalance: 1
                }
              },
              { $sort: { order: 1 } }
            ],
            as: 'modules'
          }
        },
        
        // Lookup all chapters for this novel (no global sorting - we'll sort within modules)
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
              }
              // Removed global sorting - we'll sort within each module instead
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
            wordCount: 1,
            availableForRent: 1,
            modules: 1,
            allChapters: 1
          }
        }
      ]);

      if (!novelWithData) {
        return { error: "Novel not found", status: 404 };
      }

      // Organize chapters by module efficiently AND sort within each module
      const chaptersByModule = novelWithData.allChapters.reduce((acc, chapter) => {
        const moduleId = chapter.moduleId.toString();
        if (!acc[moduleId]) {
          acc[moduleId] = [];
        }
        acc[moduleId].push(chapter);
        return acc;
      }, {});

      // Attach chapters to their modules and sort chapters within each module by order
      const modulesWithChapters = novelWithData.modules.map(module => ({
        ...module,
        chapters: (chaptersByModule[module._id.toString()] || []).sort((a, b) => (a.order || 0) - (b.order || 0))
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
router.put("/:id", [auth, admin], async (req, res) => {
  try {
    const novelId = req.params.id;
    
    // Validate ObjectId format before proceeding
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }
    
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
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Check permissions for staff modification
    const canModifyStaff = req.user.role === 'admin' || req.user.role === 'moderator';
    
    // If pj_user is trying to modify staff, reject the request
    if (!canModifyStaff && (active || inactive)) {
      // Check if staff arrays are actually being changed
      const staffChanged = 
        JSON.stringify(active) !== JSON.stringify(novel.active) ||
        JSON.stringify(inactive) !== JSON.stringify(novel.inactive);
      
      if (staffChanged) {
        return res.status(403).json({ 
          message: 'Only admins and moderators can modify novel staff assignments' 
        });
      }
    }

    // Auto-promote users to pj_user role when assigned as project managers
    // (Only if user has permission to modify staff)
    if (canModifyStaff && active?.pj_user && Array.isArray(active.pj_user)) {
      const User = mongoose.model('User');
      
      // Find users who are being assigned as pj_user
      const newPjUsers = [];
      
      for (const pjUserItem of active.pj_user) {
        // Check if this is a MongoDB ObjectId (not a text string)
        if (mongoose.Types.ObjectId.isValid(pjUserItem)) {
          try {
            const user = await User.findById(pjUserItem);
            if (user && user.role === 'user') {
              // Only promote regular users to pj_user (don't downgrade admins/moderators)
              newPjUsers.push(user);
            }
          } catch (userError) {
            console.warn(`Error checking user ${pjUserItem}:`, userError);
          }
        }
      }
      
      // Promote users to pj_user role
      if (newPjUsers.length > 0) {
        try {
          await User.updateMany(
            { _id: { $in: newPjUsers.map(u => u._id) } },
            { $set: { role: 'pj_user' } }
          );
          
        } catch (updateError) {
          console.error('Error promoting users to pj_user role:', updateError);
          // Don't fail the novel update if role promotion fails
        }
      }
    }

    // Check if any pj_users should be demoted to regular users
    // This happens when they're removed from ACTIVE novel management positions
    // (Only if user has permission to modify staff)
    if (canModifyStaff && novel.active?.pj_user && Array.isArray(novel.active.pj_user)) {
      const User = mongoose.model('User');
      
      // Normalize both arrays to strings for proper comparison
      const previousActivePjUsers = novel.active.pj_user
        .filter(item => mongoose.Types.ObjectId.isValid(item))
        .map(item => item.toString());
      
      const newActivePjUsers = (active?.pj_user || [])
        .filter(item => mongoose.Types.ObjectId.isValid(item))
        .map(item => item.toString());
      
      // Find users who were REMOVED from ACTIVE pj_user position
      const removedFromActivePjUsers = previousActivePjUsers.filter(userId => 
        !newActivePjUsers.includes(userId)
      );
      
      // Only proceed with demotion logic if users were actually removed
      if (removedFromActivePjUsers.length > 0) {
        try {
          // Convert string IDs to ObjectIds for proper MongoDB querying
          const removedObjectIds = removedFromActivePjUsers.map(id => 
            mongoose.Types.ObjectId.createFromHexString(id)
          );
          
          // Check if these users are managing any other novels ACTIVELY
          // Need to check for both ObjectId and string representations since active.pj_user is Mixed type
          const userIdStrings = removedFromActivePjUsers; // These are already strings
          
          const stillManagingNovels = await Novel.find({
            _id: { $ne: novelId }, // Exclude current novel - USE novelId instead of req.params.id
            $or: [
              { 'active.pj_user': { $in: removedObjectIds } }, // Check ObjectId format
              { 'active.pj_user': { $in: userIdStrings } }     // Check string format
            ]
          }).lean();
          
          const stillManagingUserIds = new Set();
          stillManagingNovels.forEach(otherNovel => {
            if (otherNovel.active?.pj_user) {
              otherNovel.active.pj_user.forEach(userId => {
                // Add all users who are still active pj_users in other novels
                const userIdStr = userId.toString();
                stillManagingUserIds.add(userIdStr);
                console.log(`[NOVEL UPDATE] User ${userIdStr} is still active pj_user in novel "${otherNovel.title}"`);
              });
            }
          });
          
          // Users who are not ACTIVELY managing any other novels should be demoted
          const usersToDemote = removedFromActivePjUsers.filter(userId => 
            !stillManagingUserIds.has(userId)
          );
          
          if (usersToDemote.length > 0) {
            // Convert to ObjectIds for database query
            const demoteObjectIds = usersToDemote.map(id => 
              mongoose.Types.ObjectId.createFromHexString(id)
            );
            
            // Only demote users who are currently pj_user (don't downgrade admins/moderators)
            const usersToActuallyDemote = await User.find({
              _id: { $in: demoteObjectIds },
              role: 'pj_user'
            }).select('_id username displayName role').lean();
            
            if (usersToActuallyDemote.length > 0) {
              await User.updateMany(
                { _id: { $in: usersToActuallyDemote.map(u => u._id) } },
                { $set: { role: 'user' } }
              );
            }
          }
        } catch (demoteError) {
          console.error('Error demoting users from pj_user role:', demoteError);
          // Don't fail the novel update if role demotion fails
        }
      }
    }

    // Update fields
    novel.title = title;
    novel.alternativeTitles = alternativeTitles;
    novel.author = author;
    novel.illustrator = illustrator;
    
    // Only update staff if user has permission
    if (canModifyStaff) {
      novel.active = active;
      novel.inactive = inactive;
    }
    
    novel.genres = genres;
    novel.description = description;
    novel.note = note;
    novel.illustration = illustration;
    
    // Check if status changed (this should update timestamp for "latest updates")
    const statusChanged = status && status !== novel.status;
    novel.status = status;
    
    // Only update timestamp for significant changes that should affect "latest updates"
    // - Status changes (completed, ongoing, etc.)
    // - When explicitly requested (preserveTimestamp = false)
    // - Don't update for staff changes, description edits, genre updates, etc.
    const shouldUpdateTimestamp = statusChanged || (!req.body.preserveTimestamp && req.body.forceTimestampUpdate);
    
    if (shouldUpdateTimestamp) {
      novel.updatedAt = new Date();
    }

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
  // Only admins can delete novels
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can delete novels' });
  }

  const novelId = req.params.id;
  
  // Validate ObjectId format before proceeding
  if (!mongoose.Types.ObjectId.isValid(novelId)) {
    return res.status(400).json({ message: "Invalid novel ID format" });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    console.log(`Deleting novel with ID: ${novelId}`);
    const novel = await Novel.findById(novelId).session(session);
    if (!novel) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Novel not found" });
    }

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

    // Delete all user chapter interactions for this novel (chapter likes, ratings, bookmarks, reading history)
    await UserChapterInteraction.deleteMany({ novelId: novelId }).session(session);

    // Delete all contribution history for this novel
    await ContributionHistory.deleteMany({ novelId: novelId }).session(session);

    // Delete all module rentals for this novel
    const ModuleRental = mongoose.model('ModuleRental');
    await ModuleRental.deleteMany({ novelId: novelId }).session(session);

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

    // Check if any pj_users should be demoted after novel deletion
    if (novel.active?.pj_user && Array.isArray(novel.active.pj_user)) {
      try {
        const pjUsersInDeletedNovel = novel.active.pj_user
          .filter(item => mongoose.Types.ObjectId.isValid(item))
          .map(item => item.toString());
        
        if (pjUsersInDeletedNovel.length > 0) {
          // Convert to ObjectIds for MongoDB query
          const pjUserObjectIds = pjUsersInDeletedNovel.map(id => 
            mongoose.Types.ObjectId.createFromHexString(id)
          );
          
          // Check if these users are managing any other novels
          const stillManagingNovels = await Novel.find({
            _id: { $ne: novelId }, // Exclude the novel being deleted
            'active.pj_user': { $in: pjUserObjectIds }
          }).session(session).lean();
          
          const stillManagingUserIds = new Set();
          stillManagingNovels.forEach(otherNovel => {
            if (otherNovel.active?.pj_user) {
              otherNovel.active.pj_user.forEach(userId => {
                // Add all users who are still active pj_users in other novels
                stillManagingUserIds.add(userId.toString());
              });
            }
          });
          
          // Users who are not managing any other novels should be demoted
          const usersToDemote = pjUsersInDeletedNovel.filter(userId => 
            !stillManagingUserIds.has(userId)
          );
          
          if (usersToDemote.length > 0) {
            // Convert to ObjectIds for database query
            const demoteObjectIds = usersToDemote.map(id => 
              mongoose.Types.ObjectId.createFromHexString(id)
            );
            
            // Only demote users who are currently pj_user (don't downgrade admins/moderators)
            const usersToActuallyDemote = await User.find({
              _id: { $in: demoteObjectIds },
              role: 'pj_user'
            }).select('_id username').session(session).lean();
            
            if (usersToActuallyDemote.length > 0) {
              await User.updateMany(
                { _id: { $in: usersToActuallyDemote.map(u => u._id) } },
                { $set: { role: 'user' } }
              ).session(session);
            }
          }
        }
      } catch (demoteError) {
        console.error('Error demoting users from pj_user role after novel deletion:', demoteError);
        // Don't fail the novel deletion if role demotion fails
      }
    }

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
  const novelId = req.params.id;
  
  // Validate ObjectId format before proceeding
  if (!mongoose.Types.ObjectId.isValid(novelId)) {
    return res.status(400).json({ message: "Invalid novel ID format" });
  }
  
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can update novel balance' });
    }
    
    const { novelBalance } = req.body;
    
    if (isNaN(novelBalance)) {
      return res.status(400).json({ message: 'Invalid balance value' });
    }
    
    // Optimized: Get old balance and update in a single atomic operation
    const result = await Novel.findOneAndUpdate(
      { _id: novelId },
      [
        {
          $set: {
            // Store old balance before updating
            oldBalance: { $ifNull: ['$novelBalance', 0] },
            novelBalance: novelBalance
          }
        }
      ],
      { 
        new: true, 
        session,
        // Return both old and new values
        projection: { 
          title: 1, 
          novelBalance: 1, 
          oldBalance: 1,
          novelBudget: 1,
          updatedAt: 1
        }
      }
    );
    
    if (!result) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Novel not found' });
    }
    
    const oldBalance = result.oldBalance || 0;
    const change = novelBalance - oldBalance;
    
    // Only record transaction if there was actually a change
    if (change !== 0) {
      await createNovelTransaction({
        novel: novelId,
        amount: change,
        type: 'admin',
        description: 'Admin điều chỉnh số dư thủ công',
        balanceAfter: novelBalance,
        performedBy: req.user._id
      }, session);
    }
    
    await session.commitTransaction();
    
    // Remove the temporary oldBalance field from response
    const { oldBalance: _, ...responseNovel } = result.toObject();
    
    // Return enriched response with change information for frontend optimization
    res.json({
      ...responseNovel,
      balanceChange: change,
      oldBalance: oldBalance
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Error updating novel balance:', error);
    res.status(500).json({ message: 'Lỗi máy chủ' });
  } finally {
    session.endSession();
  }
});

/**
 * Update novel rental availability
 * @route PATCH /api/novels/:id/rental
 */
router.patch("/:id/rental", auth, async (req, res) => {
  try {
    // Only admins can update rental availability
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        message: 'Only admins can update rental availability' 
      });
    }

    const { availableForRent } = req.body;
    
    if (typeof availableForRent !== 'boolean') {
      return res.status(400).json({ 
        message: 'availableForRent must be a boolean value' 
      });
    }

    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Update rental availability without affecting updatedAt timestamp
    novel.availableForRent = availableForRent;
    
    // Don't update the updatedAt timestamp for rental availability changes
    await novel.save({ timestamps: false });
    
    // Clear all novel-related caches after rental status update
    clearNovelCaches();
    
    res.json({ 
              message: availableForRent ? 'Đã bật chế độ mở tạm thời' : 'Đã tắt chế độ mở tạm thời',
      availableForRent: novel.availableForRent 
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
    
    // Validate ObjectId format before proceeding
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }
    
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

    // Start transaction - includes both contribution and auto-unlock
    const session = await mongoose.startSession();
    session.startTransaction();

    let autoUnlockResult = { unlockedContent: [], finalBudget: 0 };

    try {
      // Deduct from user balance
      await User.findByIdAndUpdate(userId, {
        $inc: { balance: -amount }
      }, { session });

      // Get updated user balance for transaction recording
      const updatedUser = await User.findById(userId).session(session);

      // Clear user cache to ensure fresh balance is returned by API calls
      clearUserCache(userId, user.username);

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

      // Record transaction in UserTransaction ledger
      await createTransaction({
        userId: userId,
        amount: -amount, // Negative amount since balance is deducted
        type: 'contribution',
        description: `Đóng góp cho truyện: ${novel.title}${note ? ` - ${note}` : ''}`,
        sourceId: novelId,
        sourceModel: 'Novel',
        performedById: userId,
        balanceAfter: updatedUser.balance
      }, session);

      // Perform auto-unlock within the same transaction
      autoUnlockResult = await performAutoUnlockInTransaction(novelId, session);

      // Commit the entire transaction (contribution + auto-unlock)
      await session.commitTransaction();

      // Clear caches and notify clients after successful transaction
      if (autoUnlockResult.unlockedContent.length > 0 || autoUnlockResult.switchedModules.length > 0) {
        clearNovelCaches();
        
        // Send notifications for unlocked content
        autoUnlockResult.unlockedContent.forEach(content => {
          if (content.type === 'module') {
            notifyAllClients('module_unlocked', { 
              novelId, 
              moduleId: content.moduleId,
              moduleTitle: content.title 
            });
          } else if (content.type === 'chapter') {
            notifyAllClients('chapter_unlocked', { 
              novelId, 
              moduleId: content.moduleId,
              chapterId: content.chapterId,
              chapterTitle: content.title 
            });
          }
        });

        // Send notifications for modules that switched from rent to published mode
        autoUnlockResult.switchedModules.forEach(module => {
          notifyAllClients('module_mode_changed', { 
            novelId, 
            moduleId: module._id,
            moduleTitle: module.title,
            oldMode: 'rent',
            newMode: 'published',
            reason: 'auto_switch_rent_to_published'
          });
        });

        // Send additional notification if novel moved to top of latest updates
        notifyAllClients('novel_updated_for_latest', { 
          novelId, 
          timestamp: new Date().toISOString(),
          reason: 'content_unlocked'
        });
      }

      // Notify clients of the budget update
      notifyAllClients('novel_budget_updated', { 
        novelId, 
        newBudget: autoUnlockResult.finalBudget,
        newBalance: updatedNovel.novelBalance 
      });

      res.json({ 
        success: true, 
        novelBudget: autoUnlockResult.finalBudget,
        novelBalance: updatedNovel.novelBalance,
        unlockedContent: autoUnlockResult.unlockedContent,
        message: autoUnlockResult.unlockedContent.length > 0 
          ? `Đóng góp thành công! Đã mở khóa ${autoUnlockResult.unlockedContent.length} nội dung.`
          : "Đóng góp thành công!" 
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
 * Internal function to perform auto-unlock within an existing transaction
 * Returns unlocked content and final budget for the calling transaction
 */
async function performAutoUnlockInTransaction(novelId, session) {
  try {
    const novel = await Novel.findById(novelId).session(session);
    if (!novel || novel.novelBudget <= 0) {
      return { unlockedContent: [], finalBudget: novel?.novelBudget || 0 };
    }

    // Get all modules for this novel, sorted by order
    const modules = await Module.find({ novelId })
      .sort({ order: 1 })
      .session(session)
      .lean();

    let remainingBudget = novel.novelBudget;
    let unlockedContent = [];
    let shouldUpdateTimestamp = false;
    // REMOVED: let modulesNeedingRentBalanceUpdate = new Set(); // Track modules that need rentBalance recalculation

    for (const module of modules) {
      // If module is paid or undefined (treat undefined as paid), try to unlock it first
      if (module.mode === 'paid' || module.mode === undefined) {
        const moduleBalance = module.moduleBalance || 0;
        
        if (remainingBudget >= moduleBalance) {
          // Unlock the module by changing mode to published
          await Module.findByIdAndUpdate(module._id, { mode: 'published' }, { session });
          remainingBudget -= moduleBalance;
          shouldUpdateTimestamp = true;
          unlockedContent.push({ 
            type: 'module', 
            title: module.title, 
            cost: moduleBalance,
            moduleId: module._id 
          });

          // Only create system contribution record if there was actually a cost
          if (moduleBalance > 0) {
            await ContributionHistory.create([{
              novelId,
              userId: null, // System action
              amount: -moduleBalance,
              note: `Mở khóa tự động: ${module.title}`,
              budgetAfter: remainingBudget,
              type: 'system'
            }], { session });
          }
        } else {
          // Cannot afford this module, stop here (sequential unlock)
          break;
        }
      }

      // If module is published (free or just unlocked) OR in rent mode, check its chapters in order
      // Rent mode modules can still have individual paid chapters that need unlocking
      if (module.mode === 'published' || module.mode === 'rent') {
        // Get chapters for this module, sorted by order
        const chapters = await Chapter.find({ moduleId: module._id })
          .select('title order mode chapterBalance')
          .sort({ order: 1 })
          .session(session)
          .lean();

        let moduleHasUnpaidChapters = false;
        
        for (const chapter of chapters) {
          // If chapter is paid, try to unlock it
          if (chapter.mode === 'paid') {
            if (remainingBudget >= chapter.chapterBalance) {
              // Unlock the chapter by changing mode to published
              await Chapter.findByIdAndUpdate(chapter._id, { mode: 'published' }, { session });
              remainingBudget -= chapter.chapterBalance;
              shouldUpdateTimestamp = true;
              
              // REMOVED: Mark this module for rentBalance recalculation
              // REMOVED: modulesNeedingRentBalanceUpdate.add(module._id.toString());
              
              unlockedContent.push({ 
                type: 'chapter', 
                title: chapter.title, 
                module: module.title, 
                cost: chapter.chapterBalance,
                moduleId: module._id,
                chapterId: chapter._id 
              });

              // Only create system contribution record if there was actually a cost
              if (chapter.chapterBalance > 0) {
                await ContributionHistory.create([{
                  novelId,
                  userId: null, // System action
                  amount: -chapter.chapterBalance,
                  note: `Mở khóa tự động: ${chapter.title}`,
                  budgetAfter: remainingBudget,
                  type: 'system'
                }], { session });
              }
            } else {
              // Cannot afford this chapter in current module
              moduleHasUnpaidChapters = true;
              break; // Stop processing this module and don't proceed to next modules
            }
          }
        }
        
        // If current module still has unpaid chapters, stop processing entirely
        if (moduleHasUnpaidChapters) {
          break;
        }
      }
    }

    // Check rent modules for auto-switching to published mode (when total paid chapter balance ≤ 200)
    const rentModulesNeedingCheck = new Set();
    
    // Collect rent modules that had chapters unlocked
    for (const module of modules) {
      if (module.mode === 'rent') {
        // Check if this rent module had any chapters unlocked
        const moduleHadUnlockedChapters = unlockedContent.some(content => 
          content.type === 'chapter' && content.moduleId.toString() === module._id.toString()
        );
        
        if (moduleHadUnlockedChapters) {
          rentModulesNeedingCheck.add(module._id.toString());
        }
      }
    }
    
    // Check rent modules for auto-switching (only rent modules, not for rentBalance updates)
    const switchedModules = [];
    for (const moduleId of rentModulesNeedingCheck) {
      try {
        const switchResult = await checkAndSwitchRentModuleToPublished(moduleId, session);
        if (switchResult.switched) {
          switchedModules.push(switchResult.module);
        }
      } catch (error) {
        console.error(`Error checking rent module ${moduleId} for auto-switching:`, error);
        // Don't fail the entire unlock process if auto-switch check fails
      }
    }

    // Conditionally recalculate rent balance for modules that had chapters unlocked
    // This uses the recalculateRentOnUnlock flag to determine if recalculation should happen
    for (const moduleId of rentModulesNeedingCheck) {
      try {
        await conditionallyRecalculateRentBalance(moduleId, session);
      } catch (error) {
        console.error(`Error conditionally recalculating rent balance for module ${moduleId}:`, error);
        // Don't fail the entire unlock process if rent balance recalculation fails
      }
    }

    // Update novel budget and timestamp if anything was unlocked
    if (shouldUpdateTimestamp) {
      const newTimestamp = new Date();
      await Novel.findByIdAndUpdate(novelId, { 
        novelBudget: remainingBudget,
        updatedAt: newTimestamp
      }, { session });
    } else {
      // Just update budget without timestamp
      await Novel.findByIdAndUpdate(novelId, { 
        novelBudget: remainingBudget
      }, { session });
    }

    return { 
      unlockedContent, 
      finalBudget: remainingBudget,
      switchedModules 
    };

  } catch (error) {
    console.error('Error in auto-unlock within transaction:', error);
    throw error;
  }
}

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

    // Find contribution history for this novel (without populate to avoid individual queries)
    const contributions = await ContributionHistory.find({ novelId })
      .sort({ createdAt: -1 })
      .limit(50) // Limit to last 50 contributions
      .lean();

    // Extract unique user IDs
    const userIds = [...new Set(contributions
      .map(contribution => contribution.userId)
      .filter(userId => userId) // Filter out null/undefined userIds (system contributions)
    )];

    // Batch fetch users to avoid individual queries
    const User = mongoose.model('User');
    const users = await User.find({ _id: { $in: userIds } })
      .select('_id username avatar displayName')
      .lean();

    // Create user lookup map
    const userMap = users.reduce((map, user) => {
      map[user._id.toString()] = {
        _id: user._id,
        username: user.username,
        avatar: user.avatar,
        displayName: user.displayName
      };
      return map;
    }, {});

    // Format the response with batched user data
    const formattedContributions = contributions.map(contribution => ({
      _id: contribution._id,
      user: contribution.userId ? userMap[contribution.userId.toString()] : null,
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



// ... existing code ...
export async function checkAndUnlockContent(novelId) {
  // NOTE: This function is deprecated for contribution flows.
  // The contribution route now uses performAutoUnlockInTransaction for atomic operations.
  // This function is kept for backward compatibility with other potential callers.
  // 
  // IMPORTANT: This function checks for auto-switching rent modules to published mode
  // when chapters are unlocked, but does NOT recalculate rentBalance (which should remain unchanged).
  
  const session = await mongoose.startSession();
  let transactionCommitted = false;
  
  try {
    session.startTransaction();
    
    const result = await performAutoUnlockInTransaction(novelId, session);
    await session.commitTransaction();
    transactionCommitted = true;
    
    // Clear caches and notify clients after successful transaction
    if (result.unlockedContent.length > 0 || result.switchedModules.length > 0) {
      clearNovelCaches();
      
      // Send notifications for unlocked content
      result.unlockedContent.forEach(content => {
        if (content.type === 'module') {
          notifyAllClients('module_unlocked', { 
            novelId, 
            moduleId: content.moduleId,
            moduleTitle: content.title 
          });
        } else if (content.type === 'chapter') {
          notifyAllClients('chapter_unlocked', { 
            novelId, 
            moduleId: content.moduleId,
            chapterId: content.chapterId,
            chapterTitle: content.title 
          });
        }
      });

      // Send notifications for modules that switched from rent to published mode
      result.switchedModules.forEach(module => {
        notifyAllClients('module_mode_changed', { 
          novelId, 
          moduleId: module._id,
          moduleTitle: module.title,
          oldMode: 'rent',
          newMode: 'published',
          reason: 'auto_switch_rent_to_published'
        });
      });

      // Send additional notification if novel moved to top of latest updates
      notifyAllClients('novel_updated_for_latest', { 
        novelId, 
        timestamp: new Date().toISOString(),
        reason: 'content_unlocked'
      });
    }

    return result;

  } catch (error) {
    // Only abort transaction if it hasn't been committed yet
    if (!transactionCommitted) {
      await session.abortTransaction();
    }
    console.error('Error in auto-unlock:', error);
    throw error; // Re-throw to allow calling code to handle the error
  } finally {
    session.endSession();
  }
}

/**
 * Get complete novel page data in a single optimized request
 * @route GET /api/novels/:id/complete
 */
router.get("/:id/complete", async (req, res) => {
  try {
    const novelId = req.params.id;
    
    // Validate ObjectId format before proceeding
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }
    
    const userId = req.user ? req.user._id : null;
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(`novel-complete:${novelId}:${userId || 'guest'}`, async () => {
      // Execute all queries in parallel for maximum performance
      const [
        novel, 
        modules, 
        chapters, 
        gifts, 
        userInteraction, 
        novelStats, 
        contributionHistory
      ] = await Promise.all([
        // 1. Get novel data
        Novel.findById(novelId)
          .select('title description alternativeTitles author illustrator illustration status active inactive genres note updatedAt createdAt views ratings novelBalance novelBudget wordCount')
          .lean(),
          
        // 2. Get modules
        Module.find({ novelId: novelId })
          .select('title illustration order chapters mode moduleBalance')
          .sort('order')
          .lean(),
          
        // 3. Get chapters (no global sorting - we'll sort within modules)
        Chapter.find({ novelId: novelId })
          .select('title moduleId order createdAt updatedAt mode chapterBalance')
          .lean(),
          
        // 4. Get gifts with counts (using the same aggregation but cached)
        Gift.aggregate([
          {
            $lookup: {
              from: 'novelgifts',
              let: { giftId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$giftId', '$$giftId'] },
                        { $eq: ['$novelId', mongoose.Types.ObjectId.createFromHexString(novelId)] }
                      ]
                    }
                  }
                }
              ],
              as: 'novelGift'
            }
          },
          {
            $addFields: {
              count: {
                $ifNull: [{ $arrayElemAt: ['$novelGift.count', 0] }, 0]
              }
            }
          },
          {
            $project: {
              _id: 1,
              name: 1,
              icon: 1,
              price: 1,
              order: 1,
              count: 1
            }
          },
          {
            $sort: { order: 1 }
          }
        ]),
        
        // 5. Get user interaction if logged in
        userId ? UserNovelInteraction.findOne({ 
          userId, 
          novelId: mongoose.Types.ObjectId.createFromHexString(novelId) 
        }).lean() : null,
        
        // 6. Get novel interaction statistics
        UserNovelInteraction.aggregate([
          {
            $match: { novelId: mongoose.Types.ObjectId.createFromHexString(novelId) }
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
        ]),
        
        // 7. Get recent contribution history
        ContributionHistory.find({ novelId: novelId })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean()
      ]);

      if (!novel) {
        return { error: "Novel not found", status: 404 };
      }

      // Populate staff ObjectIds with user display names
      const populatedNovel = await populateStaffNames(novel);

      // Organize chapters by module and sort within each module
      const chaptersByModule = chapters.reduce((acc, chapter) => {
        const moduleId = chapter.moduleId.toString();
        if (!acc[moduleId]) {
          acc[moduleId] = [];
        }
        acc[moduleId].push(chapter);
        return acc;
      }, {});

      // Attach chapters to their modules and sort chapters within each module by order
      const modulesWithChapters = modules.map(module => ({
        ...module,
        chapters: (chaptersByModule[module._id.toString()] || []).sort((a, b) => (a.order || 0) - (b.order || 0))
      }));

      // Build interaction response
      const stats = novelStats[0];
      const interactions = {
        totalLikes: stats?.totalLikes || 0,
        totalRatings: stats?.totalRatings || 0,
        averageRating: stats?.totalRatings > 0 
          ? (stats.ratingSum / stats.totalRatings).toFixed(1) 
          : '0.0',
        userInteraction: {
          liked: userInteraction?.liked || false,
          rating: userInteraction?.rating || null,
          bookmarked: userInteraction?.bookmarked || false
        }
      };

      return {
        novel: populatedNovel,
        modules: modulesWithChapters,
        gifts,
        interactions,
        contributionHistory
      };
    });

    // Handle deduplication errors
    if (result.error) {
      return res.status(result.status).json({ message: result.error });
    }

    // Return complete novel page data
    res.json(result);

    // Increment view count after sending response (non-blocking)
    if (req.query.skipViewTracking !== 'true') {
      Novel.findById(novelId)
        .then(fullNovel => {
          if (fullNovel) {
            return fullNovel.incrementViews();
          }
        })
        .catch(err => console.error('Error updating view count:', err));
    }
  } catch (err) {
    console.error('Error in novel complete route:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get complete homepage data in a single optimized request
 * @route GET /api/novels/homepage
 */
router.get("/homepage", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;
    const userId = req.user ? req.user._id : null;
    const timeRange = req.query.timeRange || 'today';

    // Check if we should bypass cache
    const bypass = shouldBypassCache(req.path, req.query);
    const cacheKey = `homepage_${page}_${limit}_${timeRange}_${userId || 'guest'}`;
    
    if (!bypass) {
      const cachedData = cache.get(cacheKey);
      if (cachedData) {
        return res.json(cachedData);
      }
    }

    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(cacheKey, async () => {
      // Execute all homepage queries in parallel for maximum performance
      const [
        novelListResult,
        hotNovels,
        recentComments,
        readingHistory
      ] = await Promise.all([
        // 1. Novel list with pagination (existing optimized aggregation)
        Novel.aggregate([
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
              novelBudget: 1,
              availableForRent: 1
            }
          },
                // Simplified chapter lookup - only get what we need
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
                      { $limit: 3 }, // Homepage shows latest 3 chapters
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
                // First chapter for "first chapter" link
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
                // Set firstChapter as single object (not array)
                {
                  $addFields: {
                    firstChapter: { $arrayElemAt: ['$firstChapter', 0] }
                  }
                },
                // Calculate latest activity
                {
                  $addFields: {
                    latestActivity: {
                      $max: [
                        '$updatedAt',
                        { $max: '$chapters.createdAt' }
                      ]
                    },
                    latestChapter: { $arrayElemAt: ['$chapters', 0] }
                  }
                },
                { $sort: { latestActivity: -1 } },
                { $skip: skip },
                { $limit: limit }
              ]
            }
          }
        ]),

        // 2. Hot novels (cached separately with shorter TTL)
        dedupQuery(`hot_novels_${timeRange}`, async () => {
          const now = new Date();
          let startDate;
          
          if (timeRange === 'today') {
            startDate = new Date();
            startDate.setHours(0, 0, 0, 0);
          } else if (timeRange === 'week') {
            startDate = new Date();
            startDate.setDate(startDate.getDate() - 7);
          }

          try {
            return await Novel.aggregate([
              { $match: { "views.daily": { $exists: true, $ne: [] } } },
              { $unwind: "$views.daily" },
              {
                $match: {
                  "views.daily.date": { $gte: startDate }
                }
              },
              {
                $group: {
                  _id: "$_id",
                  title: { $first: "$title" },
                  illustration: { $first: "$illustration" },
                  status: { $first: "$status" },
                  dailyViews: { $sum: "$views.daily.count" }
                }
              },
              { $sort: { dailyViews: -1 } },
              { $limit: 5 },
              {
                $project: {
                  _id: 1,
                  title: 1,
                  illustration: 1,
                  status: 1,
                  dailyViews: 1
                }
              }
            ]);
          } catch (err) {
            console.warn('Hot novels query failed, returning empty array:', err);
            return [];
          }
        }),

        // 3. Recent comments (optimized with proper title lookups)
        dedupQuery(`recent_comments_10`, async () => {
          try {
            return await Comment.aggregate([
              {
                $match: {
                  isDeleted: { $ne: true },
                  adminDeleted: { $ne: true },
                  parentId: null
                }
              },
              { $sort: { createdAt: -1 } },
              { $limit: 10 },
              {
                $lookup: {
                  from: 'users',
                  localField: 'user',
                  foreignField: '_id',
                  pipeline: [
                    { $project: { username: 1, avatar: 1 } }
                  ],
                  as: 'userInfo'
                }
              },
              { $unwind: '$userInfo' },
              // Lookup novel titles for novel comments
              {
                $lookup: {
                  from: 'novels',
                  let: { 
                    contentId: '$contentId',
                    contentType: '$contentType'
                  },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ['$$contentType', 'novels'] },
                            { $eq: [{ $toString: '$_id' }, '$$contentId'] }
                          ]
                        }
                      }
                    },
                    { $project: { title: 1 } }
                  ],
                  as: 'novelInfo'
                }
              },
              // Lookup chapter and novel info for chapter comments
              {
                $lookup: {
                  from: 'chapters',
                  let: { 
                    contentId: '$contentId',
                    contentType: '$contentType'
                  },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ['$$contentType', 'chapters'] },
                            { $eq: [{ $toString: '$_id' }, { $arrayElemAt: [{ $split: ['$$contentId', '-'] }, 1] }] }
                          ]
                        }
                      }
                    },
                    {
                      $lookup: {
                        from: 'novels',
                        localField: 'novelId',
                        foreignField: '_id',
                        pipeline: [
                          { $project: { title: 1 } }
                        ],
                        as: 'novel'
                      }
                    },
                    {
                      $project: {
                        title: 1,
                        novelTitle: { $arrayElemAt: ['$novel.title', 0] }
                      }
                    }
                  ],
                  as: 'chapterInfo'
                }
              },
              // Resolve content titles properly
              {
                $addFields: {
                  contentTitle: {
                    $switch: {
                      branches: [
                        {
                          case: { $eq: ['$contentType', 'novels'] },
                          then: { $arrayElemAt: ['$novelInfo.title', 0] }
                        },
                        {
                          case: { $eq: ['$contentType', 'chapters'] },
                          then: { $arrayElemAt: ['$chapterInfo.novelTitle', 0] }
                        }
                      ],
                      default: 'Feedback'
                    }
                  },
                  chapterTitle: {
                    $cond: [
                      { $eq: ['$contentType', 'chapters'] },
                      { $arrayElemAt: ['$chapterInfo.title', 0] },
                      null
                    ]
                  }
                }
              },
              {
                $project: {
                  _id: 1,
                  text: 1,
                  contentType: 1,
                  contentId: 1,
                  contentTitle: 1,
                  chapterTitle: 1,
                  createdAt: 1,
                  user: {
                    _id: '$userInfo._id',
                    username: '$userInfo.username',
                    avatar: '$userInfo.avatar'
                  }
                }
              }
            ]);
          } catch (err) {
            console.warn('Comments query failed, returning empty array:', err);
            return [];
          }
        }),

        // 4. Reading history (only if user is logged in)
        userId ? UserChapterInteraction.aggregate([
          {
            $match: {
              userId: mongoose.Types.ObjectId.createFromHexString(userId),
              lastReadAt: {
                $ne: null,
                $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) // Last 2 weeks
              }
            }
          },
          { $sort: { lastReadAt: -1 } },
          {
            $group: {
              _id: '$novelId',
              latestInteraction: { $first: '$$ROOT' }
            }
          },
          { $replaceRoot: { newRoot: '$latestInteraction' } },
          { $sort: { lastReadAt: -1 } },
          { $limit: 5 },
          // Simplified lookups
          {
            $lookup: {
              from: 'chapters',
              localField: 'chapterId',
              foreignField: '_id',
              pipeline: [
                { $project: { title: 1, novelId: 1 } }
              ],
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
            $addFields: {
              chapter: { $arrayElemAt: ['$chapter', 0] },
              novel: { $arrayElemAt: ['$novel', 0] }
            }
          },
          {
            $match: {
              'chapter._id': { $exists: true },
              'novel._id': { $exists: true }
            }
          },
          {
            $project: {
              chapterId: 1,
              novelId: 1,
              lastReadAt: 1,
              chapter: 1,
              novel: 1
            }
          }
        ]) : []
      ]);

      // Process novel list result
      const total = novelListResult[0]?.total[0]?.count || 0;
      const novels = novelListResult[0]?.novels || [];

      return {
        novelList: {
          novels,
          pagination: {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total
          }
        },
        hotNovels: hotNovels || [],
        recentComments: recentComments || [],
        readingHistory: readingHistory || []
      };
    });

    // Cache the result only if not bypassing
    if (!bypass) {
      cache.set(cacheKey, result, 1000 * 60 * 2); // 2 minutes cache
    }

    res.json(result);

  } catch (err) {
    console.error('Error in homepage route:', err);
    res.status(500).json({
      novelList: { novels: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0 } },
      hotNovels: [],
      recentComments: [],
      readingHistory: [],
      error: err.message
    });
  }
});

/**
 * Get optimized dashboard data for a novel (eliminates duplicate queries)
 * @route GET /api/novels/:id/dashboard
 */
router.get("/:id/dashboard", async (req, res) => {
  try {
    const novelId = req.params.id;
    
    // Validate ObjectId format before proceeding
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }
    
    const moduleId = req.query.moduleId;
    
    // Check if we should bypass cache
    const bypass = shouldBypassCache(req.path, req.query);
    const cacheKey = `novel-dashboard:${novelId}:${moduleId || 'all'}`;
    
    // Try to get from cache first (short TTL for dashboard data)
    if (!bypass) {
      const cachedData = cache.get(cacheKey);
      if (cachedData) {
        return res.json(cachedData);
      }
    }
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(cacheKey, async () => {
      // Optimized aggregation pipeline that minimizes data transfer
      const [dashboardData] = await Novel.aggregate([
        // Match the specific novel
        {
          $match: { _id: mongoose.Types.ObjectId.createFromHexString(novelId) }
        },
        
        // Lookup all modules for this novel with full details
        {
          $lookup: {
            from: 'modules',
            localField: '_id',
            foreignField: 'novelId',
            pipeline: [
              { $sort: { order: 1 } }
            ],
            as: 'modules'
          }
        },
        
        // Only lookup chapters for the specific module if moduleId is provided
        // Otherwise, just get chapter counts per module for performance
        ...(moduleId ? [
          {
            $lookup: {
              from: 'chapters',
              let: { moduleId: mongoose.Types.ObjectId.createFromHexString(moduleId) },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ['$moduleId', '$$moduleId'] }
                  }
                },
                { $sort: { order: 1 } },
                // Project only essential fields for dashboard
                {
                  $project: {
                    title: 1,
                    order: 1,
                    mode: 1,
                    chapterBalance: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    moduleId: 1
                  }
                }
              ],
              as: 'moduleChapters'
            }
          }
        ] : [
          // If no specific module, get chapter counts per module for overview
          {
            $lookup: {
              from: 'chapters',
              localField: '_id',
              foreignField: 'novelId',
              pipeline: [
                {
                  $group: {
                    _id: '$moduleId',
                    count: { $sum: 1 },
                    lastUpdated: { $max: '$updatedAt' }
                  }
                }
              ],
              as: 'chapterCounts'
            }
          }
        ]),
        
        // If specific moduleId is provided, also get that module's details
        ...(moduleId ? [
          {
            $lookup: {
              from: 'modules',
              let: { novelId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$_id', mongoose.Types.ObjectId.createFromHexString(moduleId)] },
                        { $eq: ['$novelId', '$$novelId'] }
                      ]
                    }
                  }
                }
              ],
              as: 'selectedModule'
            }
          }
        ] : []),
        
        // Project the final structure
        {
          $project: {
            // Novel fields
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
            wordCount: 1,
            // Module data
            modules: 1,
            // Conditional chapter data
            ...(moduleId ? { 
              moduleChapters: 1,
              selectedModule: { $arrayElemAt: ['$selectedModule', 0] }
            } : { 
              chapterCounts: 1 
            })
          }
        }
      ]);

      if (!dashboardData) {
        return { error: "Novel not found", status: 404 };
      }

      // Populate staff ObjectIds with user display names
      const populatedNovel = await populateStaffNames({
        _id: dashboardData._id,
        title: dashboardData.title,
        description: dashboardData.description,
        alternativeTitles: dashboardData.alternativeTitles,
        author: dashboardData.author,
        illustrator: dashboardData.illustrator,
        illustration: dashboardData.illustration,
        status: dashboardData.status,
        active: dashboardData.active,
        inactive: dashboardData.inactive,
        genres: dashboardData.genres,
        note: dashboardData.note,
        updatedAt: dashboardData.updatedAt,
        createdAt: dashboardData.createdAt,
        views: dashboardData.views,
        ratings: dashboardData.ratings,
        novelBalance: dashboardData.novelBalance,
        novelBudget: dashboardData.novelBudget,
        wordCount: dashboardData.wordCount
      });

      let modulesWithChapters;
      
      if (moduleId && dashboardData.moduleChapters) {
        // If specific module requested, only attach chapters to that module
        modulesWithChapters = dashboardData.modules.map(module => {
          if (module._id.toString() === moduleId) {
            return {
              ...module,
              chapters: dashboardData.moduleChapters || []
            };
          }
          return {
            ...module,
            chapters: [] // Empty for other modules to save memory
          };
        });
      } else if (dashboardData.chapterCounts) {
        // If no specific module, add chapter counts to modules
        const countsByModule = dashboardData.chapterCounts.reduce((acc, count) => {
          acc[count._id.toString()] = count;
          return acc;
        }, {});
        
        modulesWithChapters = dashboardData.modules.map(module => ({
          ...module,
          chapterCount: countsByModule[module._id.toString()]?.count || 0,
          lastChapterUpdate: countsByModule[module._id.toString()]?.lastUpdated || null,
          chapters: [] // Don't load all chapters for overview
        }));
      } else {
        // Fallback: modules without chapter data
        modulesWithChapters = dashboardData.modules.map(module => ({
          ...module,
          chapters: []
        }));
      }

      return {
        novel: populatedNovel,
        modules: modulesWithChapters,
        // Only include chapters array if specific module requested
        chapters: moduleId ? (dashboardData.moduleChapters || []) : [],
        selectedModule: dashboardData.selectedModule || null
      };
    });

    // Handle deduplication errors
    if (result.error) {
      return res.status(result.status).json({ message: result.error });
    }

    // Cache the result for a short time (30 seconds for dashboard data)
    if (!bypass) {
      cache.set(cacheKey, result, 1000 * 30); // 30 seconds cache
    }

    // Return dashboard data
    res.json(result);
  } catch (err) {
    console.error('Error in novel dashboard route:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Manual auto-unlock for admins
 * @route POST /api/novels/:id/auto-unlock
 */
router.post("/:id/auto-unlock", auth, async (req, res) => {
  try {
    // Only admins can manually trigger auto-unlock
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can manually trigger auto-unlock' });
    }

    const novelId = req.params.id;
    
    // Validate ObjectId format before proceeding
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Check if there's budget to unlock
    if (novel.novelBudget <= 0) {
      return res.status(400).json({ message: "Không có kho lúa để mở khóa" });
    }

    // Use the existing checkAndUnlockContent function
    const result = await checkAndUnlockContent(novelId);

    // Clear novel caches after manual unlock
    clearNovelCaches();

    // Notify clients of the update
    notifyAllClients('novel_budget_updated', { 
      novelId, 
      newBudget: result.finalBudget,
      timestamp: new Date().toISOString(),
      reason: 'manual_unlock'
    });

    res.json({
      success: true,
      message: result.unlockedContent.length > 0 
        ? `Đã mở khóa ${result.unlockedContent.length} nội dung thành công!`
        : 'Không có nội dung nào có thể mở khóa với số lúa hiện tại.',
      unlockedContent: result.unlockedContent,
      finalBudget: result.finalBudget
    });

  } catch (err) {
    console.error("Error in manual auto-unlock:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get multiple novels by IDs (batch endpoint to reduce duplicate queries)
 * @route POST /api/novels/batch
 */
router.post('/batch', async (req, res) => {
  try {
    const { novelIds } = req.body;
    
    if (!Array.isArray(novelIds) || novelIds.length === 0) {
      return res.status(400).json({ message: 'novelIds array is required' });
    }
    
    // Deduplicate first, then check batch size
    const uniqueIds = [...new Set(novelIds)]; // Remove duplicates
    
    // Limit batch size to prevent abuse (after deduplication)
    if (uniqueIds.length > 20) {
      return res.status(400).json({ message: 'Cannot fetch more than 20 unique novels at once' });
    }
    
    // Validate all IDs
    const validIds = uniqueIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    
    if (validIds.length === 0) {
      return res.json({ novels: [] });
    }
    
    // Use the same aggregation pattern as individual novel queries but for multiple novels
    const novels = await Novel.aggregate([
      { 
        $match: {
          _id: { $in: validIds.map(id => new mongoose.Types.ObjectId(id)) }
        }
      },
      {
        $lookup: {
          from: 'modules',
          localField: '_id',
          foreignField: 'novelId',
          pipeline: [{ $sort: { order: 1 } }],
          as: 'modules'
        }
      },
      {
        $lookup: {
          from: 'chapters',
          localField: '_id',
          foreignField: 'novelId',
          pipeline: [
            {
              $group: {
                _id: '$moduleId',
                count: { $sum: 1 },
                lastUpdated: { $max: '$updatedAt' }
              }
            }
          ],
          as: 'chapterCounts'
        }
      },
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
          wordCount: 1,
          modules: 1,
          chapterCounts: 1
        }
      }
    ]);
    
    res.json({ novels });
  } catch (error) {
    console.error('Error fetching novels batch:', error);
    res.status(500).json({ message: 'Failed to fetch novels' });
  }
});

export default router;
