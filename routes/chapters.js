/**
 * CHAPTERS ROUTE - MongoDB Write Conflict Prevention
 * 
 * This module implements retry logic to handle MongoDB write conflicts that can occur
 * during high-concurrency operations, especially when multiple users are:
 * - Creating/updating/deleting chapters simultaneously
 * - Updating novel word counts
 * - Modifying module references
 * 
 * RECOMMENDED MONGODB CONFIGURATION:
 * - Ensure proper indexing on frequently queried fields
 * - Consider using MongoDB transactions with appropriate read/write concerns
 * - Monitor for lock contention in high-traffic scenarios
 * 
 * PERFORMANCE INDEXES RECOMMENDED:
 * - db.chapters.createIndex({ "novelId": 1, "order": 1 })
 * - db.chapters.createIndex({ "moduleId": 1, "order": 1 })
 * - db.chapters.createIndex({ "_id": 1 }) // Usually exists by default
 * - db.novels.createIndex({ "_id": 1, "wordCount": 1 })
 */

import express from 'express';
import Chapter from '../models/Chapter.js';
import { auth, optionalAuth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';
import Module from '../models/Module.js';
import Novel from '../models/Novel.js';
import mongoose from 'mongoose';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import ModuleRental from '../models/ModuleRental.js';

// Import the novel cache clearing function
import { clearNovelCaches, clearChapterCaches, notifyAllClients } from '../utils/cacheUtils.js';
import { createNewChapterNotifications } from '../services/notificationService.js';
import { populateStaffNames } from '../utils/populateStaffNames.js';

const router = express.Router();

// Simple in-memory cache for slug lookups to avoid repeated DB queries
const slugCache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes
const MAX_CACHE_SIZE = 1000;

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

/**
 * Server-side word counting function that replicates TinyMCE's algorithm
 * @param {string} htmlContent - HTML content to count words in
 * @returns {number} Word count using TinyMCE-compatible algorithm
 */
const calculateWordCount = (htmlContent) => {
  if (!htmlContent || typeof htmlContent !== 'string') return 0;
  
  // Step 1: Extract text from HTML exactly like TinyMCE
  const tempDiv = { innerHTML: htmlContent };
  // Simple HTML tag removal for server-side processing
  let text = htmlContent.replace(/<[^>]*>/g, ' ');
  
  if (!text.trim()) return 0;
  
  // Step 2: Handle HTML entities
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'")
             .replace(/&apos;/g, "'");
  
  // Step 3: Use TinyMCE's word counting approach
  const wordRegex = /[\w\u00C0-\u024F\u1E00-\u1EFF\u0100-\u017F\u0180-\u024F\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF]+/g;
  
  // Step 4: Find all word matches
  const matches = text.match(wordRegex);
  
  if (!matches) return 0;
  
  // Step 5: Filter matches like TinyMCE does
  const filteredMatches = matches.filter(match => {
    // Filter out single standalone digits
    if (match.length === 1 && /^\d$/.test(match)) {
      return false;
    }
    
    // Filter out single standalone letters that are likely not words
    if (match.length === 1 && /^[a-zA-Z]$/.test(match)) {
      return false;
    }
    
    return true;
  });
  
  return filteredMatches.length;
};

// Helper function to manage cache
const getCachedSlug = (slug) => {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedSlug = (slug, data) => {
  // Remove oldest entries if cache is too large
  if (slugCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = slugCache.keys().next().value;
    slugCache.delete(oldestKey);
  }
  
  slugCache.set(slug, {
    data,
    timestamp: Date.now()
  });
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

/**
 * Get appropriate access message for denied chapter access
 * @param {Object} chapterData - Chapter data with mode and module info
 * @param {Object} user - Current user object (can be null)
 * @returns {string} Access denial message
 */
const getAccessMessage = (chapterData, user) => {
  if (!user) {
    if (chapterData.mode === 'protected') {
      return 'Vui lòng đăng nhập để đọc chương này.';
    }
    if (chapterData.mode === 'paid') {
      return `Chương này yêu cầu thanh toán ${chapterData.chapterBalance || 0} 🌾 để truy cập hoặc bạn có thể thuê tập.`;
    }
    if (chapterData.module?.mode === 'paid') {
      return `Module này yêu cầu thanh toán ${chapterData.module.moduleBalance || 0} 🌾 để truy cập hoặc bạn có thể thuê tập với giá ${chapterData.module.rentBalance || 0} 🌾.`;
    }
    return 'Vui lòng đăng nhập để truy cập nội dung này.';
  }

  if (chapterData.mode === 'draft') {
    return 'Chương này đang ở chế độ nháp và không khả dụng cho người dùng.';
  }
  
  if (chapterData.mode === 'paid') {
    return `Chương này yêu cầu thanh toán ${chapterData.chapterBalance || 0} 🌾 để truy cập hoặc bạn có thể thuê tập.`;
  }
  
  if (chapterData.module?.mode === 'paid') {
    return `Module này yêu cầu thanh toán ${chapterData.module.moduleBalance || 0} 🌾 để truy cập hoặc bạn có thể thuê tập với giá ${chapterData.module.rentBalance || 0} 🌾.`;
  }
  
  return 'Bạn không có quyền truy cập nội dung này.';
};

/**
 * Helper function to execute MongoDB operations with retry logic for write conflicts
 * @param {Function} operation - The operation to execute
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {string} operationName - Name of the operation for logging
 */
const executeWithRetry = async (operation, maxRetries = 3, operationName = 'operation') => {
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      attempt++;
      
      // Check if this is a transient error that can be retried
      const isRetryableError = error.errorLabels?.includes('TransientTransactionError') ||
                              error.code === 112 || // WriteConflict
                              error.code === 11000 || // DuplicateKey
                              error.code === 16500; // InterruptedAtShutdown
      
      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Retrying ${operationName} (attempt ${attempt}/${maxRetries}):`, error.message);
        
        // Exponential backoff with jitter
        const baseDelay = Math.pow(2, attempt - 1) * 100; // 100ms, 200ms, 400ms
        const jitter = Math.random() * 50; // Add up to 50ms random jitter
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
        
        continue;
      }
      
      console.error(`${operationName} failed after ${attempt} attempts:`, error);
      throw error;
    }
  }
};

/**
 * Lookup chapter ID by slug
 * @route GET /api/chapters/slug/:slug
 * 
 * PERFORMANCE NOTE: For optimal performance, ensure these indexes exist:
 * - db.chapters.createIndex({ "_id": 1 }) // Usually exists by default
 * - db.chapters.createIndex({ "title": 1 }) // For title searches
 * 
 * This optimized version uses ObjectId range queries for efficient lookups.
 */
router.get("/slug/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Check cache first
    const cached = getCachedSlug(slug);
    if (cached) {
      return res.json(cached);
    }
    
    // Extract the short ID from the slug (last 8 characters after final hyphen)
    const parts = slug.split('-');
    const shortId = parts[parts.length - 1];
    
    let result = null;
    
    // If it's already a full MongoDB ID, return it
    if (/^[0-9a-fA-F]{24}$/.test(slug)) {
      const chapter = await Chapter.findById(slug).select('_id title').lean();
      if (chapter) {
        result = { id: chapter._id, title: chapter.title };
      }
    } 
    // If we have a short ID (8 hex characters), find the chapter using ObjectId range query
    else if (/^[0-9a-fA-F]{8}$/.test(shortId)) {
      const shortIdLower = shortId.toLowerCase();
      
      // Create ObjectId range for efficient query
      // ObjectIds are 24 hex characters, so we want to find all IDs ending with our 8 characters
      // This means IDs from xxxxxxxxxxxxxxxx[shortId] to xxxxxxxxxxxxxxxx[shortId+1]
      
      // Create the lower bound: pad with zeros at the beginning
      const lowerBound = '0'.repeat(16) + shortIdLower;
      
      // Create the upper bound: increment the last character and pad
      let upperHex = shortIdLower;
      let carry = 1;
      let upperBoundArray = upperHex.split('').reverse();
      
      for (let i = 0; i < upperBoundArray.length && carry; i++) {
        let val = parseInt(upperBoundArray[i], 16) + carry;
        if (val > 15) {
          upperBoundArray[i] = '0';
          carry = 1;
        } else {
          upperBoundArray[i] = val.toString(16);
          carry = 0;
        }
      }
      
      let upperBound;
      if (carry) {
        // Overflow case - use max possible value
        upperBound = 'f'.repeat(24);
      } else {
        upperBound = '0'.repeat(16) + upperBoundArray.reverse().join('');
      }
      
      try {
        // Use a more targeted aggregation that's still efficient
        const [chapter] = await Chapter.aggregate([
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
        
        if (chapter) {
          result = { id: chapter._id, title: chapter.title };
        }
      } catch (aggregationError) {
        console.warn('Aggregation failed, falling back to alternative method:', aggregationError);
        
        // Fallback: fetch chapters in batches and check suffix
        let skip = 0;
        const batchSize = 100;
        let found = false;
        
        while (!found) {
          const chapters = await Chapter.find({}, { _id: 1, title: 1 })
            .lean()
            .skip(skip)
            .limit(batchSize);
          
          if (chapters.length === 0) break; // No more chapters to check
          
          const matchingChapter = chapters.find(chapter => 
            chapter._id.toString().toLowerCase().endsWith(shortIdLower)
          );
          
          if (matchingChapter) {
            result = { id: matchingChapter._id, title: matchingChapter.title };
            found = true;
          }
          
          skip += batchSize;
        }
      }
    }
    
    if (result) {
      // Cache the result for future requests
      setCachedSlug(slug, result);
      return res.json(result);
    }
    
    res.status(404).json({ message: "Chapter not found" });
  } catch (err) {
    console.error('Error in chapter slug lookup:', err);
    res.status(500).json({ message: err.message });
  }
});

// Get all chapters for a module
router.get('/module/:moduleId', async (req, res) => {
  try {
    const chapters = await Chapter.find({ moduleId: req.params.moduleId })
      .sort({ order: 1 });
    res.json(chapters);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all chapters for a novel
router.get('/novel/:novelId', async (req, res) => {
  try {
    const chapters = await Chapter.find({ novelId: req.params.novelId })
      .sort({ order: 1 });
    res.json(chapters);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get chapter count for a specific user
router.get('/count/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    
    const count = await Chapter.countDocuments({ 
      createdBy: mongoose.Types.ObjectId.createFromHexString(userId) 
    });
    
    res.json({ count });
  } catch (err) {
    console.error('Error counting user chapters:', err);
    res.status(500).json({ message: err.message });
  }
});

// Get chapter participation count for a specific user (as translator, editor, or proofreader)
// Each chapter is counted only ONCE per user, regardless of how many roles they have on that chapter
router.get('/participation/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    
    // Get user data to check for all possible identifiers
    const user = await mongoose.model('User').findById(userId).select('username displayName').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const userObjectId = mongoose.Types.ObjectId.createFromHexString(userId);
    const userIdString = userId.toString();
    
    // Build query conditions for all possible ways the user could be identified in staff fields
    const userConditions = [
      // ObjectId as ObjectId type
      userObjectId,
      // ObjectId as string
      userIdString,
      // Username
      user.username
    ];
    
    // Add displayName if it exists and is different from username
    if (user.displayName && user.displayName !== user.username) {
      userConditions.push(user.displayName);
    }
    
    // Count unique chapters where the user participated in any role
    // Since we're using $or on the same document, each chapter is naturally counted only once
    // even if the user has multiple roles (translator, editor, proofreader) on the same chapter
    const count = await Chapter.countDocuments({
      $or: [
        { translator: { $in: userConditions } },
        { editor: { $in: userConditions } },
        { proofreader: { $in: userConditions } }
      ]
    });
    
    res.json({ count });
  } catch (err) {
    console.error('Error counting user chapter participation:', err);
    res.status(500).json({ message: err.message });
  }
});

// Get a specific chapter
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    console.log(`Fetching chapter with ID: ${req.params.id}`);
    
    // Use query deduplication to prevent multiple identical requests
    const chapterData = await dedupQuery(`chapter:${req.params.id}`, async () => {
      // Get chapter and its siblings in a single aggregation pipeline
      const [chapter] = await Chapter.aggregate([
        // First, match the requested chapter by ID
        {
          $match: { _id: mongoose.Types.ObjectId.createFromHexString(req.params.id) }
        },
        
        // Lookup the module information
        {
          $lookup: {
            from: 'modules',
            localField: 'moduleId',
            foreignField: '_id',
            pipeline: [
              { $project: { mode: 1, moduleBalance: 1, rentBalance: 1 } }
            ],
            as: 'module'
          }
        },
        
        // Next, lookup the novel info (including active staff for permissions)
        {
          $lookup: {
            from: 'novels',
            localField: 'novelId',
            foreignField: '_id',
            pipeline: [
              { $project: { title: 1, active: 1 } }
            ],
            as: 'novel'
          }
        },
        
        // Lookup the module for this chapter
        {
          $lookup: {
            from: 'modules',
            localField: 'moduleId',
            foreignField: '_id',
            pipeline: [
              { $project: { title: 1, mode: 1, moduleBalance: 1, rentBalance: 1 } }
            ],
            as: 'module'
          }
        },
        
        // Lookup the user who created this chapter
        {
          $lookup: {
            from: 'users',
            localField: 'createdBy',
            foreignField: '_id',
            pipeline: [
              { $project: { displayName: 1, username: 1 } }
            ],
            as: 'createdByUser'
          }
        },
        
        // Then, lookup all chapters from the same module
        {
          $lookup: {
            from: 'chapters',
            let: { 
              moduleId: '$moduleId', 
              currentOrder: '$order', 
              chapterId: '$_id' 
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$moduleId', '$$moduleId'] }, // Only match chapters in same module
                      { $ne: ['$_id', '$$chapterId'] }
                    ]
                  }
                }
              },
              { $project: { _id: 1, title: 1, order: 1 } },
              { $sort: { order: 1 } }
            ],
            as: 'siblingChapters'
          }
        },
        
        // Add fields for novel, module, createdByUser, prevChapter, and nextChapter
        {
          $addFields: {
            novel: { $arrayElemAt: ['$novel', 0] },
            module: { $arrayElemAt: ['$module', 0] },
            createdByUser: { $arrayElemAt: ['$createdByUser', 0] },
            prevChapter: {
              $let: {
                vars: {
                  prevChapters: {
                    $filter: {
                      input: '$siblingChapters',
                      as: 'sibling',
                      cond: { $lt: ['$$sibling.order', '$order'] }
                    }
                  }
                },
                in: {
                  $arrayElemAt: [
                    { $sortArray: { input: '$$prevChapters', sortBy: { order: -1 } } },
                    0
                  ]
                }
              }
            },
            nextChapter: {
              $let: {
                vars: {
                  nextChapters: {
                    $filter: {
                      input: '$siblingChapters',
                      as: 'sibling',
                      cond: { $gt: ['$$sibling.order', '$order'] }
                    }
                  }
                },
                in: {
                  $arrayElemAt: [
                    { $sortArray: { input: '$$nextChapters', sortBy: { order: 1 } } },
                    0
                  ]
                }
              }
            }
          }
        },
        
        // Remove the siblings field from the output and ensure moduleId is included
        {
          $project: {
            siblingChapters: 0,
            moduleId: 1, // Explicitly include moduleId
            novelId: 1,  // Explicitly include novelId for safety
            title: 1,
            content: 1,
            order: 1,
            mode: 1,
            chapterBalance: 1,
            createdAt: 1,
            updatedAt: 1,
            translator: 1,
            editor: 1,
            proofreader: 1,
            createdBy: 1,
            footnotes: 1,
            wordCount: 1,
            views: 1,
            novel: 1,
            module: 1,
            createdByUser: 1,
            prevChapter: 1,
            nextChapter: 1
          }
        }
      ]);

      return chapter;
    });

    if (!chapterData) {
      console.log('Chapter not found');
      return res.status(404).json({ message: 'Chapter not found' });
    }

    console.log(`Found chapter: ${chapterData.title}`);
    console.log(`Navigation: prev=${chapterData.prevChapter?._id}, next=${chapterData.nextChapter?._id}`);

    // Check if user can access this chapter content
    const user = req.user; // Will be undefined if not authenticated
    let hasAccess = false;
    let accessReason = '';

    // Admin, moderator always have access
    if (user && (user.role === 'admin' || user.role === 'moderator')) {
      hasAccess = true;
      accessReason = 'admin/moderator';
    }
    // PJ_user for their assigned novels
    else if (user && user.role === 'pj_user' && chapterData.novel?.active?.pj_user) {
      const isAuthorized = chapterData.novel.active.pj_user.includes(user._id.toString()) || 
                          chapterData.novel.active.pj_user.includes(user.username);
      if (isAuthorized) {
        hasAccess = true;
        accessReason = 'pj_user';
      }
    }
    
    // Check mode-based access for regular users
    if (!hasAccess) {
      switch (chapterData.mode) {
        case 'published':
          hasAccess = true;
          accessReason = 'published';
          break;
        case 'protected':
          if (user) {
            hasAccess = true;
            accessReason = 'protected-authenticated';
          }
          break;
        case 'draft':
          // Draft is only accessible to admin/mod/assigned pj_user (already checked above)
          break;
        case 'paid':
          // Check if user has active rental for this module
          if (user && chapterData.moduleId) {
            const activeRental = await ModuleRental.findActiveRentalForUserModule(user._id, chapterData.moduleId);
            
            if (activeRental && activeRental.isValid()) {
              hasAccess = true;
              accessReason = 'rental';
              
              // Add rental information to the response
              chapterData.rentalInfo = {
                hasActiveRental: true,
                endTime: activeRental.endTime,
                timeRemaining: Math.max(0, activeRental.endTime - new Date())
              };
            }
          }
          break;
      }
    }
    
    // Check if module is paid and user has rental access
    if (!hasAccess && chapterData.module?.mode === 'paid' && user && chapterData.moduleId) {
      const activeRental = await ModuleRental.findActiveRentalForUserModule(user._id, chapterData.moduleId);
      
      if (activeRental && activeRental.isValid()) {
        hasAccess = true;
        accessReason = 'module-rental';
        
        // Add rental information to the response
        chapterData.rentalInfo = {
          hasActiveRental: true,
          endTime: activeRental.endTime,
          timeRemaining: Math.max(0, activeRental.endTime - new Date())
        };
      }
    }

    // If user doesn't have access, return limited chapter info
    if (!hasAccess) {
      // Populate staff ObjectIds with user display names for metadata
      const populatedChapter = await populateStaffNames(chapterData);
      
      // Return chapter without content
      const { content, ...chapterWithoutContent } = populatedChapter;
      
      return res.json({ 
        chapter: {
          ...chapterWithoutContent,
          accessDenied: true,
          accessMessage: getAccessMessage(chapterData, user)
        }
      });
    }

    // Populate staff ObjectIds with user display names
    const populatedChapter = await populateStaffNames(chapterData);

    // We don't need to increment views here anymore.
    // The view increment is now handled by the dedicated endpoint
    // in userChapterInteractions.js that respects the 8-hour window.
    // This prevents double-counting of views.

    res.json({ chapter: populatedChapter });
  } catch (err) {
    console.error('Error fetching chapter:', err);
    res.status(500).json({ message: err.message });
  }
});

// Create a new chapter (admin, moderator, or pj_user managing the novel)
router.post('/', auth, async (req, res) => {
  try {
    const { 
      novelId, 
      moduleId, 
      title, 
      content,
      translator,
      editor,
      proofreader,
      mode,
      footnotes,
      chapterBalance
    } = req.body;
    
    // Check if user has permission (admin, moderator, or pj_user managing this novel)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      // For pj_user, check if they manage this novel
      if (req.user.role === 'pj_user') {
        const novel = await Novel.findById(novelId).lean();
        if (!novel) {
          return res.status(404).json({ message: 'Novel not found' });
        }
        
        // Check if user is in the novel's active pj_user array (handle both ObjectIds and usernames)
        const isAuthorized = novel.active?.pj_user?.includes(req.user._id.toString()) || 
                            novel.active?.pj_user?.includes(req.user.username);
        
        if (!isAuthorized) {
          return res.status(403).json({ message: 'Access denied. You do not manage this novel.' });
        }
      } else {
        return res.status(403).json({ message: 'Access denied. Admin, moderator, or project user privileges required.' });
      }
    }
    
    // Use aggregation to get the module and determine order in a single query
    const [moduleData] = await Module.aggregate([
      { $match: { _id: mongoose.Types.ObjectId.createFromHexString(moduleId) } },
      {
        $lookup: {
          from: 'chapters',
          let: { moduleId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$moduleId', '$$moduleId'] } } },
            { $sort: { order: -1 } },
            { $limit: 1 },
            { $project: { order: 1 } }
          ],
          as: 'lastChapter'
        }
      },
      {
        $project: {
          mode: 1,
          lastChapterOrder: { 
            $cond: [
              { $gt: [{ $size: '$lastChapter' }, 0] },
              { $arrayElemAt: ['$lastChapter.order', 0] },
              -1
            ]
          }
        }
      }
    ]);

    if (!moduleData) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Validate that paid chapters cannot be created in paid modules
    if (mode === 'paid' && moduleData.mode === 'paid') {
      return res.status(400).json({ 
        message: 'Không thể tạo chương trả phí trong tập đã trả phí. Tập trả phí đã bao gồm tất cả chương bên trong.' 
      });
    }

    // Validate minimum chapter balance for paid chapters
    if (mode === 'paid' && parseInt(chapterBalance) < 1) {
      return res.status(400).json({ 
        message: 'Số lúa chương tối thiểu là 1 🌾 cho chương trả phí.' 
      });
    }

    const order = moduleData.lastChapterOrder + 1;

    // Calculate word count for the chapter content
    const calculatedWordCount = calculateWordCount(content);

    // Create the new chapter with staff fields and footnotes
    const chapter = new Chapter({
      novelId,
      moduleId,
      title,
      content,
      order,
      translator,
      editor,
      proofreader,
      createdBy: req.user._id,
      mode: mode || 'published',
      views: 0,
      footnotes: footnotes || [],
      chapterBalance: mode === 'paid' ? (chapterBalance || 0) : 0,
      wordCount: calculatedWordCount
    });

    // Save the chapter
    const newChapter = await chapter.save();

    // Perform multiple updates in parallel with timeout protection
    await Promise.all([
      // Update the module's chapters array
      Module.findByIdAndUpdate(
        moduleId,
        { $addToSet: { chapters: newChapter._id } },
        { maxTimeMS: 5000 }
      ),
      
      // Update novel's updatedAt timestamp ONLY (no view count updates)
      Novel.findByIdAndUpdate(
        novelId,
        { updatedAt: new Date() },
        { maxTimeMS: 5000 }
      ),
      
      // Recalculate novel word count with the new chapter (has built-in retry logic)
      recalculateNovelWordCount(novelId),
      
      // Clear novel caches
      clearNovelCaches()
    ]);

    // Get novel info for the notification
    const novel = await Novel.findById(novelId).select('title');

    // Create notifications for users who bookmarked this novel
    await createNewChapterNotifications(
      novelId.toString(),
      newChapter._id.toString(),
      newChapter.title
    );

    // Notify all clients about the new chapter
    notifyAllClients('new_chapter', {
      chapterId: newChapter._id,
      chapterTitle: newChapter.title,
      novelId: novelId,
      novelTitle: novel?.title || 'Unknown Novel',
      timestamp: new Date().toISOString()
    });

    // Check for auto-unlock if a paid chapter was created
    if (mode === 'paid') {
      // Import the checkAndUnlockContent function from novels.js
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(novelId);
      
      // IMPORTANT: Clear all relevant caches after auto-unlock to prevent stale data
      clearChapterCaches(newChapter._id.toString());
      
      // Clear slug cache entries for this chapter to prevent stale mode caching
      const chapterIdString = newChapter._id.toString();
      const keysToDelete = [];
      for (const [key, value] of slugCache.entries()) {
        if (value.data && value.data.id && value.data.id.toString() === chapterIdString) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => slugCache.delete(key));
      
      // Clear query deduplication cache for this chapter
      pendingQueries.delete(`chapter:${newChapter._id}`);
    }

    // Fetch the final chapter state AFTER auto-unlock (if it happened)
    // This ensures we return the correct mode to the client
    const finalChapter = await Chapter.findById(newChapter._id).populate('moduleId', 'title');
    const populatedChapter = await populateStaffNames(finalChapter.toObject());

    res.status(201).json(populatedChapter);
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(400).json({ message: err.message });
  }
});

/**
 * Helper function to recalculate and update novel word count with retry logic
 * @param {string} novelId - The novel ID
 * @param {object} session - MongoDB session (optional)
 * @param {number} maxRetries - Maximum number of retry attempts
 */
const recalculateNovelWordCount = async (novelId, session = null, maxRetries = 3) => {
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      // Ensure novelId is a proper ObjectId (handle both string and ObjectId inputs)
      const novelObjectId = mongoose.Types.ObjectId.isValid(novelId) 
        ? (typeof novelId === 'string' ? mongoose.Types.ObjectId.createFromHexString(novelId) : novelId)
        : null;
      
      if (!novelObjectId) {
        throw new Error('Invalid novelId provided to recalculateNovelWordCount');
      }
      
      // Aggregate total word count from all chapters in this novel
      const result = await Chapter.aggregate([
        { $match: { novelId: novelObjectId } },
        { 
          $group: {
            _id: null,
            totalWordCount: { $sum: '$wordCount' }
          }
        }
      ]).session(session);

      const totalWordCount = result.length > 0 ? result[0].totalWordCount : 0;

      // Update the novel with the new word count using retry-safe options
      await Novel.findByIdAndUpdate(
        novelObjectId,
        { wordCount: totalWordCount },
        { 
          session,
          // Add options to handle write conflicts better
          upsert: false,
          new: true,
          maxTimeMS: 5000 // 5 second timeout
        }
      );

      return totalWordCount;
    } catch (error) {
      attempt++;
      
      // Check if this is a transient error that can be retried
      const isRetryableError = error.errorLabels?.includes('TransientTransactionError') ||
                              error.code === 112 || // WriteConflict
                              error.code === 11000 || // DuplicateKey
                              error.code === 16500; // InterruptedAtShutdown
      
      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Retrying novel word count update (attempt ${attempt}/${maxRetries}) for novel ${novelId}:`, error.message);
        
        // Exponential backoff with jitter
        const baseDelay = Math.pow(2, attempt - 1) * 100; // 100ms, 200ms, 400ms
        const jitter = Math.random() * 50; // Add up to 50ms random jitter
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
        
        continue;
      }
      
      console.error(`Error recalculating novel word count after ${attempt} attempts:`, error);
      throw error;
    }
  }
};

/**
 * Update a chapter with retry logic for transaction conflicts
 * @route PUT /api/chapters/:id
 */
router.put('/:id', auth, async (req, res) => {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction();
      
      const chapterId = req.params.id;
      
      // Validate ObjectId format
      if (!mongoose.Types.ObjectId.isValid(chapterId)) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Invalid chapter ID format' });
      }

      const {
        title,
        content,
        translator,
        editor,
        proofreader,
        mode,
        chapterBalance = 0,
        footnotes = [],
        wordCount = 0
      } = req.body;
      
      // Find the existing chapter
      const existingChapter = await Chapter.findById(chapterId).session(session);
      if (!existingChapter) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Chapter not found' });
      }

      // Check if user has permission to edit this chapter
      const novel = await Novel.findById(existingChapter.novelId).session(session);
      if (!novel) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Novel not found' });
      }

      // Permission check: admin, moderator, or pj_user managing this novel
      let hasPermission = false;
      if (req.user.role === 'admin' || req.user.role === 'moderator') {
        hasPermission = true;
      } else if (req.user.role === 'pj_user') {
        // Check if user manages this novel
        const isAuthorized = novel.active?.pj_user?.includes(req.user._id.toString()) || 
                            novel.active?.pj_user?.includes(req.user.username);
        hasPermission = isAuthorized;
      }

      if (!hasPermission) {
        await session.abortTransaction();
        return res.status(403).json({ 
          message: 'Access denied. You do not have permission to edit this chapter.' 
        });
      }

      // Prevent pj_users from changing paid mode (only when actually changing, not when keeping the same)
      if (req.user.role === 'pj_user' && mode && mode !== existingChapter.mode && (existingChapter.mode === 'paid' || mode === 'paid')) {
        await session.abortTransaction();
        return res.status(403).json({ 
          message: 'Bạn không có quyền thay đổi chế độ trả phí. Chỉ admin mới có thể thay đổi.' 
        });
      }

      // Validate chapter balance for paid chapters
      // Only enforce minimum balance validation when:
      // 1. User is admin (who can actually set the balance), AND
      // 2. Mode is being changed TO paid (not already paid), AND 
      // 3. Balance is less than 1
      if (req.user.role === 'admin' && mode === 'paid' && existingChapter.mode !== 'paid' && chapterBalance < 1) {
        await session.abortTransaction();
        return res.status(400).json({ 
          message: 'Số lúa chương tối thiểu là 1 🌾 cho chương trả phí.' 
        });
      }
      
      // Determine the final chapter balance
      let finalChapterBalance;
      if (req.user.role === 'admin') {
        // Admins can set the balance
        finalChapterBalance = mode === 'paid' ? Math.max(0, chapterBalance || 0) : 0;
      } else {
        // Non-admins preserve existing balance for paid chapters, 0 for others
        finalChapterBalance = mode === 'paid' ? existingChapter.chapterBalance : 0;
      }

      // Check if content changed and calculate word count accordingly
      const contentChanged = content && content !== existingChapter.content;
      let finalWordCount = existingChapter.wordCount;
      
      if (contentChanged) {
        // If content changed, recalculate word count server-side
        finalWordCount = calculateWordCount(content);
      } else if (wordCount !== undefined && wordCount !== existingChapter.wordCount) {
        // If word count was explicitly provided (from TinyMCE), use that
        finalWordCount = Math.max(0, wordCount);
      }
      
      const shouldRecalculateWordCount = contentChanged || finalWordCount !== existingChapter.wordCount;

      // Update the chapter
      const updatedChapter = await Chapter.findByIdAndUpdate(
        chapterId,
        {
          ...(title && { title }),
          ...(content && { content }),
          ...(translator !== undefined && { translator }),
          ...(editor !== undefined && { editor }),
          ...(proofreader !== undefined && { proofreader }),
          ...(mode && { mode }),
          chapterBalance: finalChapterBalance,
          footnotes,
          wordCount: finalWordCount, // Use calculated or provided word count
          updatedAt: new Date()
        },
        { 
          new: true, 
          session,
          runValidators: true,
          maxTimeMS: 5000
        }
      );

      // Only recalculate novel word count if content or word count actually changed
      if (shouldRecalculateWordCount) {
        await recalculateNovelWordCount(existingChapter.novelId, session);
      }

      // Check if chapter is being switched from paid to published/protected mode
      // This should update the novel timestamp to show it in latest updates
      const isUnlockingPaidContent = existingChapter.mode === 'paid' && 
        mode && (mode === 'published' || mode === 'protected');

      // Only update novel's timestamp for significant changes that should affect "latest updates"
      // Don't update for simple content edits, administrative balance changes, etc.
      // Novel timestamp will be updated automatically when paid content is unlocked via contributions
      // Exception: When manually switching a chapter from paid to published/protected
      const shouldUpdateNovelTimestamp = isUnlockingPaidContent;

      if (shouldUpdateNovelTimestamp) {
        await Novel.findByIdAndUpdate(
          existingChapter.novelId,
          { updatedAt: new Date() },
          { session }
        );
      }

      await session.commitTransaction();

      // Clear novel caches
      clearNovelCaches();

      // Check if chapterBalance changed and trigger auto-unlock if needed
      const chapterBalanceChanged = req.user.role === 'admin' && 
        finalChapterBalance !== existingChapter.chapterBalance;
      
      if (chapterBalanceChanged) {
        try {
          // Import and call the auto-unlock function
          const { checkAndUnlockContent } = await import('./novels.js');
          await checkAndUnlockContent(existingChapter.novelId);
          
          // Clear caches again after potential auto-unlock
          clearNovelCaches();
          clearChapterCaches(updatedChapter._id.toString());
          
          // Clear slug cache entries for this chapter to prevent stale mode caching
          const chapterIdString = updatedChapter._id.toString();
          const keysToDelete = [];
          for (const [key, value] of slugCache.entries()) {
            if (value.data && value.data.id && value.data.id.toString() === chapterIdString) {
              keysToDelete.push(key);
            }
          }
          keysToDelete.forEach(key => slugCache.delete(key));
          
          // Clear query deduplication cache for this chapter
          pendingQueries.delete(`chapter:${updatedChapter._id}`);
        } catch (unlockError) {
          console.error('Error during auto-unlock after chapterBalance change:', unlockError);
          // Don't fail the chapter update if auto-unlock fails
        }
      }

      // Notify clients of the update
      notifyAllClients('update', {
        type: 'chapter_updated',
        novelId: existingChapter.novelId,
        chapterId: updatedChapter._id,
        chapterTitle: updatedChapter.title,
        timestamp: new Date().toISOString()
      });

      // Populate and return the updated chapter
      const populatedChapter = await populateStaffNames(updatedChapter.toObject());
      return res.json(populatedChapter);

    } catch (err) {
      await session.abortTransaction();
      attempt++;
      
      // Check if this is a transient error that can be retried
      const isRetryableError = err.errorLabels?.includes('TransientTransactionError') ||
                              err.code === 112 || // WriteConflict
                              err.code === 11000 || // DuplicateKey
                              err.code === 16500; // InterruptedAtShutdown
      
      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Retrying chapter update (attempt ${attempt}/${maxRetries}) for chapter ${chapterId}:`, err.message);
        
        // Exponential backoff with jitter
        const baseDelay = Math.pow(2, attempt - 1) * 150; // 150ms, 300ms, 600ms
        const jitter = Math.random() * 75; // Add up to 75ms random jitter
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
        
        continue;
      }
      
      console.error(`Error updating chapter after ${attempt} attempts:`, err);
      return res.status(400).json({ message: err.message });
    } finally {
      session.endSession();
    }
  }
});

/**
 * Delete a chapter with retry logic for transaction conflicts
 * @route DELETE /api/chapters/:id
 */
router.delete('/:id', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction();
      
      const chapterId = req.params.id;

      // Validate chapter ID format
      if (!mongoose.Types.ObjectId.isValid(chapterId)) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Invalid chapter ID format' });
      }

      // Find the chapter to delete
      const chapter = await Chapter.findById(chapterId).session(session);
      if (!chapter) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Chapter not found' });
      }

      // Store IDs for cleanup operations
      const { novelId, moduleId } = chapter;

      // Delete the chapter
      await Chapter.findByIdAndDelete(chapterId).session(session);

      // Remove chapter reference from module
      await Module.findByIdAndUpdate(
        moduleId,
        { 
          $pull: { chapters: chapterId },
          $set: { updatedAt: new Date() }
        },
        { session, maxTimeMS: 5000 }
      );

      // Delete all user interactions for this chapter
      await UserChapterInteraction.deleteMany(
        { chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId) },
        { session }
      );

      // Recalculate novel word count with retry logic
      await recalculateNovelWordCount(novelId, session);

      // Don't update novel's timestamp when deleting chapters
      // Chapter deletion is a management action, not new content

      await session.commitTransaction();

      // Clear novel caches
      clearNovelCaches();

      // Notify clients of the chapter deletion
      notifyAllClients('update', {
        type: 'chapter_deleted',
        novelId: novelId,
        chapterId: chapterId,
        chapterTitle: chapter.title,
        timestamp: new Date().toISOString()
      });

      return res.json({ 
        message: 'Chapter deleted successfully',
        deletedChapter: {
          id: chapterId,
          title: chapter.title
        }
      });

    } catch (err) {
      await session.abortTransaction();
      attempt++;
      
      // Check if this is a transient error that can be retried
      const isRetryableError = err.errorLabels?.includes('TransientTransactionError') ||
                              err.code === 112 || // WriteConflict
                              err.code === 11000 || // DuplicateKey
                              err.code === 16500; // InterruptedAtShutdown
      
      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Retrying chapter deletion (attempt ${attempt}/${maxRetries}) for chapter ${req.params.id}:`, err.message);
        
        // Exponential backoff with jitter
        const baseDelay = Math.pow(2, attempt - 1) * 200; // 200ms, 400ms, 800ms
        const jitter = Math.random() * 100; // Add up to 100ms random jitter
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
        
        continue;
      }
      
      console.error(`Error deleting chapter after ${attempt} attempts:`, err);
      return res.status(500).json({ message: err.message });
    } finally {
      session.endSession();
    }
  }
});

/**
 * Get full chapter data with all related information
 * @route GET /api/chapters/:id/full
 */
router.get('/:id/full', optionalAuth, async (req, res) => {
  try {
    const chapterId = req.params.id;
    const userId = req.user ? req.user._id : null;
    
    // Execute all queries in parallel for better performance
    const [chapterResult, interactionStats, userInteraction] = await Promise.all([
      // Fetch chapter with novel info, module info, and navigation data
      Chapter.aggregate([
        { '$match': { _id: mongoose.Types.ObjectId.createFromHexString(chapterId) } },
        { '$lookup': { 
            from: 'novels', 
            localField: 'novelId', 
            foreignField: '_id', 
            pipeline: [ { '$project': { title: 1, illustration: 1, active: 1 } } ], 
            as: 'novel' 
        }},
        // CRITICAL: Add module lookup for rental access checks
        { '$lookup': { 
            from: 'modules', 
            localField: 'moduleId', 
            foreignField: '_id', 
            pipeline: [ { '$project': { title: 1, mode: 1, moduleBalance: 1, rentBalance: 1 } } ], 
            as: 'module' 
        }},
        { '$lookup': { 
            from: 'users', 
            localField: 'createdBy', 
            foreignField: '_id', 
            pipeline: [ { '$project': { displayName: 1, username: 1 } } ], 
            as: 'createdByUser' 
        }},
        { '$lookup': { 
            from: 'chapters', 
            let: { moduleId: '$moduleId', currentOrder: '$order', chapterId: '$_id' }, 
            pipeline: [ 
              { '$match': { 
                  '$expr': { '$and': [ 
                    { '$eq': [ '$moduleId', '$$moduleId' ] }, 
                    { '$ne': [ '$_id', '$$chapterId' ] } 
                  ]} 
              }}, 
              { '$project': { _id: 1, title: 1, order: 1 } }, 
              { '$sort': { order: 1 } } 
            ], 
            as: 'siblingChapters' 
        }},
        { '$addFields': { 
            novel: { '$arrayElemAt': [ '$novel', 0 ] },
            module: { '$arrayElemAt': [ '$module', 0 ] },
            createdByUser: { '$arrayElemAt': [ '$createdByUser', 0 ] },
            prevChapter: { 
              '$let': { 
                vars: { 
                  prevChapters: { 
                    '$filter': { 
                      input: '$siblingChapters', 
                      as: 'sibling', 
                      cond: { '$lt': [ '$$sibling.order', '$order' ] } 
                    } 
                  } 
                }, 
                in: { '$arrayElemAt': [ { '$sortArray': { input: '$$prevChapters', sortBy: { order: -1 } } }, 0 ] } 
              } 
            },
            nextChapter: { 
              '$let': { 
                vars: { 
                  nextChapters: { 
                    '$filter': { 
                      input: '$siblingChapters', 
                      as: 'sibling', 
                      cond: { '$gt': [ '$$sibling.order', '$order' ] } 
                    } 
                  } 
                }, 
                in: { '$arrayElemAt': [ { '$sortArray': { input: '$$nextChapters', sortBy: { order: 1 } } }, 0 ] } 
              } 
            } 
        }},
        { '$project': { siblingChapters: 0 } }
      ]),

      // Get interaction statistics
      UserChapterInteraction.aggregate([
        {
          $match: { chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId) }
        },
        {
          $group: {
            _id: null,
            totalLikes: {
              $sum: { $cond: [{ $eq: ['$liked', true] }, 1, 0] }
            }
          }
        }
      ]),

      // Get user-specific interaction data if user is logged in
      userId ? UserChapterInteraction.findOne({ 
        userId, 
        chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId) 
      }).lean() : null
    ]);

    if (!chapterResult.length) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    const chapter = chapterResult[0];
    const stats = interactionStats[0];
    
    // CRITICAL: Add access control logic for rental system
    const user = req.user;
    let hasAccess = false;
    let accessReason = '';

    // Admin, moderator always have access
    if (user && (user.role === 'admin' || user.role === 'moderator')) {
      hasAccess = true;
      accessReason = 'admin/moderator';
    }
    // PJ_user for their assigned novels
    else if (user && user.role === 'pj_user' && chapter.novel?.active?.pj_user) {
      const isAuthorized = chapter.novel.active.pj_user.includes(user._id.toString()) || 
                          chapter.novel.active.pj_user.includes(user.username);
      if (isAuthorized) {
        hasAccess = true;
        accessReason = 'pj_user';
      }
    }
    
    // Check mode-based access for regular users
    if (!hasAccess) {
      switch (chapter.mode) {
        case 'published':
          hasAccess = true;
          accessReason = 'published';
          break;
        case 'protected':
          if (user) {
            hasAccess = true;
            accessReason = 'protected-authenticated';
          }
          break;
        case 'draft':
          // Draft is only accessible to admin/mod/assigned pj_user (already checked above)
          break;
        case 'paid':
          // Check if user has active rental for this module
          if (user && chapter.moduleId) {
            const activeRental = await ModuleRental.findActiveRentalForUserModule(user._id, chapter.moduleId);
            if (activeRental && activeRental.isValid()) {
              hasAccess = true;
              accessReason = 'rental';
              
              // Add rental information to the response
              chapter.rentalInfo = {
                hasActiveRental: true,
                endTime: activeRental.endTime,
                timeRemaining: Math.max(0, activeRental.endTime - new Date())
              };
            }
          }
          break;
      }
    }
    
    // Check if module is paid and user has rental access
    if (!hasAccess && chapter.module?.mode === 'paid' && user && chapter.moduleId) {
      const activeRental = await ModuleRental.findActiveRentalForUserModule(user._id, chapter.moduleId);
      if (activeRental && activeRental.isValid()) {
        hasAccess = true;
        accessReason = 'module-rental';
        
        // Add rental information to the response
        chapter.rentalInfo = {
          hasActiveRental: true,
          endTime: activeRental.endTime,
          timeRemaining: Math.max(0, activeRental.endTime - new Date())
        };
      }
    }

    // Populate staff ObjectIds with user display names
    const populatedChapter = await populateStaffNames(chapter);

    // If user doesn't have access, return limited chapter info
    if (!hasAccess) {
      // Return chapter without content
      const { content, ...chapterWithoutContent } = populatedChapter;
      
      // Build interaction response
      const interactions = {
        totalLikes: stats?.totalLikes || 0,
        userInteraction: {
          liked: userInteraction?.liked || false,
          bookmarked: userInteraction?.bookmarked || false
        }
      };
      
      return res.json({
        chapter: {
          ...chapterWithoutContent,
          accessDenied: true,
          accessMessage: getAccessMessage(chapter, user)
        },
        interactions
      });
    }

    console.log(`Access granted for chapter ${chapter.title}: reason=${accessReason}`);

    // Build interaction response
    const interactions = {
      totalLikes: stats?.totalLikes || 0,
      userInteraction: {
        liked: userInteraction?.liked || false,
        bookmarked: userInteraction?.bookmarked || false
      }
    };

    // Combine everything into a single response
    res.json({
      chapter: populatedChapter,
      interactions
    });
  } catch (err) {
    console.error('Error getting full chapter data:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Batch update word counts for chapters with 0 word count
 * @route POST /api/chapters/batch-update-wordcount
 */
router.post('/batch-update-wordcount', auth, async (req, res) => {
  // Only allow admins to run this batch operation
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
  }

  try {
    // Find all chapters with 0 word count but have content
    const chaptersToUpdate = await Chapter.find({
      wordCount: 0,
      content: { $exists: true, $ne: '' }
    }).select('_id content novelId').lean();

    console.log(`Found ${chaptersToUpdate.length} chapters to update word counts for.`);

    let updatedCount = 0;
    const batchSize = 50; // Process in batches to avoid overwhelming the database
    
    if (chaptersToUpdate.length > 0) {
      for (let i = 0; i < chaptersToUpdate.length; i += batchSize) {
        const batch = chaptersToUpdate.slice(i, i + batchSize);
        const bulkOps = [];

        for (const chapter of batch) {
          const wordCount = calculateWordCount(chapter.content);
          if (wordCount > 0) {
            bulkOps.push({
              updateOne: {
                filter: { _id: chapter._id },
                update: { $set: { wordCount: wordCount, updatedAt: new Date() } }
              }
            });
          }
        }

        if (bulkOps.length > 0) {
          const result = await Chapter.bulkWrite(bulkOps);
          updatedCount += result.modifiedCount;
        }

        console.log(`Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(chaptersToUpdate.length / batchSize)}`);
      }
    }

    // Now find ALL novels that have chapters and recalculate their word counts
    // This catches novels with correct chapter word counts but wrong novel totals
    const novelsWithChapters = await Chapter.aggregate([
      {
        $group: {
          _id: '$novelId'
        }
      }
    ]);

    console.log(`Recalculating word counts for ${novelsWithChapters.length} novels with chapters...`);

    let novelsRecalculated = 0;
    for (const novelGroup of novelsWithChapters) {
      try {
        await recalculateNovelWordCount(novelGroup._id);
        novelsRecalculated++;
      } catch (error) {
        console.error(`Failed to recalculate word count for novel ${novelGroup._id}:`, error);
      }
    }

    // Clear caches
    clearNovelCaches();

    res.json({
      message: `Successfully updated word counts for ${updatedCount} chapters and recalculated ${novelsRecalculated} novel word counts.`,
      updated: updatedCount,
      novelsRecalculated: novelsRecalculated
    });

  } catch (error) {
    console.error('Error in batch word count update:', error);
    res.status(500).json({ 
      message: 'Error updating word counts', 
      error: error.message 
    });
  }
});

/**
 * Fix novel word counts specifically - recalculate all novels that have chapters
 * @route POST /api/chapters/fix-novel-wordcounts
 */
router.post('/fix-novel-wordcounts', auth, async (req, res) => {
  // Only allow admins to run this batch operation
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
  }

  try {
    // Find all novels that have chapters
    const novelsWithChapters = await Chapter.aggregate([
      {
        $group: {
          _id: '$novelId',
          chapterCount: { $sum: 1 },
          totalWords: { $sum: '$wordCount' }
        }
      }
    ]);

    console.log(`Found ${novelsWithChapters.length} novels with chapters to recalculate.`);

    let novelsRecalculated = 0;
    let novelsWith0WordCount = 0;

    for (const novelGroup of novelsWithChapters) {
      try {
        // Get current novel word count
        const currentNovel = await Novel.findById(novelGroup._id).select('wordCount title').lean();
        
        if (currentNovel) {
          console.log(`Novel "${currentNovel.title}": Current DB=${currentNovel.wordCount}, Calculated=${novelGroup.totalWords}, Chapters=${novelGroup.chapterCount}`);
          
          if (currentNovel.wordCount === 0 && novelGroup.totalWords > 0) {
            novelsWith0WordCount++;
          }
        }

        await recalculateNovelWordCount(novelGroup._id);
        novelsRecalculated++;
      } catch (error) {
        console.error(`Failed to recalculate word count for novel ${novelGroup._id}:`, error);
      }
    }

    // Clear caches
    clearNovelCaches();

    res.json({
      message: `Successfully recalculated word counts for ${novelsRecalculated} novels. Found ${novelsWith0WordCount} novels with 0 word count that should have had totals.`,
      novelsRecalculated: novelsRecalculated,
      novelsWith0Fixed: novelsWith0WordCount,
      totalNovelsWithChapters: novelsWithChapters.length
    });

  } catch (error) {
    console.error('Error in novel word count fix:', error);
    res.status(500).json({ 
      message: 'Error fixing novel word counts', 
      error: error.message 
    });
  }
});


export default router; 