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
import { calculateAndUpdateModuleRentBalance, conditionallyRecalculateRentBalance } from './modules.js';

// Import the novel cache clearing function
import { clearNovelCaches, clearChapterCaches, notifyAllClients } from '../utils/cacheUtils.js';
import { createNewChapterNotifications } from '../services/notificationService.js';
import { populateStaffNames } from '../utils/populateStaffNames.js';
import { getCachedUserByUsername } from '../utils/userCache.js';
import { initializeCacheReferences } from '../utils/chapterCacheUtils.js';
import { createUniqueSlug } from '../utils/slugUtils.js';

const router = express.Router();

// Route to clear user-specific caches (called after login)
router.post('/clear-user-cache/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Only allow users to clear their own cache or allow admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const clearedCount = clearUserCaches(userId);
    
    res.json({ 
      message: 'User caches cleared successfully',
      clearedCount 
    });
  } catch (error) {
    console.error('Error clearing user caches:', error);
    res.status(500).json({ message: 'Failed to clear caches' });
  }
});

// Simple in-memory cache for slug lookups to avoid repeated DB queries
const slugCache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes
const MAX_CACHE_SIZE = 1000;

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

// Result cache for storing query results
const resultCache = new Map();
const RESULT_CACHE_TTL = 1000 * 45; // 45 seconds for main chapter queries

// User lookup cache to prevent duplicate user queries
const userCache = new Map();
const USER_CACHE_TTL = 1000 * 60 * 10; // 10 minutes for user data

// Comments cache to prevent duplicate comment queries
const commentsCache = new Map();
const COMMENTS_CACHE_TTL = 1000 * 60 * 2; // 2 minutes
const MAX_COMMENTS_CACHE_SIZE = 500;

// Chapter interaction cache for view tracking
const chapterInteractionCache = new Map();
const INTERACTION_CACHE_TTL = 1000 * 60 * 5; // 5 minutes

// Username lookup cache for frequent username queries
const usernameCache = new Map();
const USERNAME_CACHE_TTL = 1000 * 60 * 10; // 10 minutes

// User permission cache for frequent permission checks
const userPermissionCache = new Map();
const USER_PERMISSION_CACHE_TTL = 1000 * 60 * 15; // 15 minutes for permission data

// Initialize cache references for shared utilities
initializeCacheReferences({
  commentsCache,
  userCache,
  chapterInteractionCache,
  usernameCache,
  userPermissionCache
});

// Optimized user lookup with caching and deduplication
const getCachedUsers = async (userIds) => {
  if (!userIds || userIds.length === 0) return [];
  
  // Normalize user IDs to strings and remove duplicates
  const normalizedIds = [...new Set(userIds.map(id => typeof id === 'object' ? id.toString() : id))];
  
  const results = [];
  const uncachedIds = [];
  
  // Check cache first
  for (const userId of normalizedIds) {
    const cached = userCache.get(userId);
    if (cached && Date.now() - cached.timestamp < USER_CACHE_TTL) {
      results.push(cached.data);
    } else {
      uncachedIds.push(userId);
    }
  }
  
  // Deduplicate database queries using the same pattern as chapter queries
  if (uncachedIds.length > 0) {
    const cacheKey = `users:${uncachedIds.sort().join(',')}`;
    const freshUsers = await dedupQuery(cacheKey, async () => {
      const User = mongoose.model('User');
      return await User.find({
        _id: { $in: uncachedIds.map(id => mongoose.Types.ObjectId.createFromHexString(id)) }
      }).select('displayName username userNumber avatar role').lean();
    });
    
    // Cache the fresh results
    for (const user of freshUsers) {
      userCache.set(user._id.toString(), {
        data: user,
        timestamp: Date.now()
      });
      results.push(user);
    }
    
    // Clean up cache periodically
    if (userCache.size > 1000) {
      const cutoff = Date.now() - (USER_CACHE_TTL * 2);
      for (const [key, value] of userCache.entries()) {
        if (value.timestamp < cutoff) {
          userCache.delete(key);
        }
      }
    }
  }
  
  return results;
};

// Optimized comments lookup with caching
const getCachedComments = async (chapterId, novelId, userId = null, page = 1, limit = 10) => {
  const cacheKey = `comments_${chapterId}_${novelId}_${userId || 'anon'}_${page}_${limit}`;
  
  // Check cache first
  const cached = commentsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < COMMENTS_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    // Import Comment model dynamically to avoid circular dependency
    const Comment = mongoose.model('Comment');
    
    // Try both contentId formats for backward compatibility
    const contentIds = [
      `${novelId}-${chapterId}`, // New format: novelId-chapterId
      chapterId // Old format: just chapterId
    ];
    
    // OPTIMIZATION 1: Use $facet to combine root comments and count queries
    const facetResults = await Comment.aggregate([
      {
        $match: {
          contentType: 'chapters',
          contentId: { $in: contentIds },
          adminDeleted: { $ne: true }
        }
      },
      {
        $facet: {
          // Get total count of root comments
          totalCount: [
            { $match: { parentId: null } },
            { $count: 'total' }
          ],
          // Get paginated root comments
          rootComments: [
            { $match: { parentId: null } },
            {
              $addFields: {
                likesCount: { $size: '$likes' },
                isPinnedSort: { $ifNull: ['$isPinned', false] }
              }
            },
            { $sort: { isPinnedSort: -1, createdAt: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                text: 1,
                contentType: 1,
                contentId: 1,
                parentId: 1,
                createdAt: 1,
                isDeleted: 1,
                adminDeleted: 1,
                likes: 1,
                likesCount: 1,
                isPinned: 1,
                isEdited: 1,
                user: 1
              }
            }
          ],
          // OPTIMIZATION 2: Get all replies in single query instead of recursive calls
          allReplies: [
            { $match: { parentId: { $ne: null } } },
            {
              $addFields: {
                likesCount: { $size: '$likes' }
              }
            },
            { $sort: { createdAt: 1 } }, // Replies sorted by oldest first
            {
              $project: {
                _id: 1,
                text: 1,
                contentType: 1,
                contentId: 1,
                parentId: 1,
                createdAt: 1,
                isDeleted: 1,
                adminDeleted: 1,
                likes: 1,
                likesCount: 1,
                isPinned: 1,
                isEdited: 1,
                user: 1
              }
            }
          ]
        }
      }
    ]);

    const totalComments = facetResults[0].totalCount[0]?.total || 0;
    const rootComments = facetResults[0].rootComments || [];
    const allReplies = facetResults[0].allReplies || [];

    if (rootComments.length === 0) {
      const result = {
        comments: [],
        total: totalComments,
        page,
        limit,
        hasMore: false
      };
      
      setCachedComments(cacheKey, result);
      return result;
    }

    // Filter replies to only those belonging to current page's root comments
    const rootCommentIds = rootComments.map(comment => comment._id.toString());
    const rootCommentIdsSet = new Set(rootCommentIds);
    
    // OPTIMIZATION 3: Build reply tree more efficiently
    const relevantReplies = [];
    const replyMap = new Map();
    
    // First pass: collect all relevant replies and build a lookup map
    allReplies.forEach(reply => {
      replyMap.set(reply._id.toString(), reply);
    });
    
    // Second pass: find replies that belong to current page's comments (recursively)
    const findRelevantReplies = (commentId) => {
      const relevant = [];
      allReplies.forEach(reply => {
        if (reply.parentId.toString() === commentId) {
          relevant.push(reply);
          // Recursively find replies to this reply
          relevant.push(...findRelevantReplies(reply._id.toString()));
        }
      });
      return relevant;
    };
    
    rootCommentIds.forEach(rootId => {
      relevantReplies.push(...findRelevantReplies(rootId));
    });

    // OPTIMIZATION 4: Batch user lookups for all comments at once
    const allComments = [...rootComments, ...relevantReplies];
    const userIds = [...new Set(allComments.map(comment => comment.user))];
    
    const User = mongoose.model('User');
    const users = await User.find(
      { _id: { $in: userIds } },
      { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 }
    ).lean();

    const usersMap = {};
    users.forEach(user => {
      usersMap[user._id.toString()] = user;
    });

    // Build nested reply structure
    const repliesByParent = new Map();
    const allCommentsById = new Map();
    
    // Process all comments with user info
    const processCommentUser = (comment) => {
      const userIdStr = comment.user.toString();
      const userInfo = usersMap[userIdStr];
      
      return {
        ...comment,
        user: userInfo,
        replies: []
      };
    };
    
    // Index all comments by ID with user info
    rootComments.forEach(comment => {
      const processedComment = processCommentUser(comment);
      allCommentsById.set(comment._id.toString(), processedComment);
    });
    relevantReplies.forEach(reply => {
      const processedReply = processCommentUser(reply);
      allCommentsById.set(reply._id.toString(), processedReply);
    });
    
    // Group replies by parent
    relevantReplies.forEach(reply => {
      const parentId = reply.parentId.toString();
      if (!repliesByParent.has(parentId)) {
        repliesByParent.set(parentId, []);
      }
      repliesByParent.get(parentId).push(allCommentsById.get(reply._id.toString()));
    });
    
    // Recursively attach replies to their parents
    const attachReplies = (comment) => {
      const commentId = comment._id.toString();
      const directReplies = repliesByParent.get(commentId) || [];
      
      comment.replies = directReplies.map(reply => {
        return attachReplies(reply);
      });
      
      return comment;
    };
    
    // Build the final organized structure
    const organizedComments = rootComments.map(comment => {
      const processedComment = allCommentsById.get(comment._id.toString());
      return attachReplies(processedComment);
    });

    const result = {
      comments: organizedComments,
      total: totalComments,
      page,
      limit,
      hasMore: (page * limit) < totalComments
    };
    
    // Cache the result
    setCachedComments(cacheKey, result);
    
    return result;
    
  } catch (error) {
    console.error('Error fetching cached comments:', error);
    return {
      comments: [],
      total: 0,
      page,
      limit,
      hasMore: false
    };
  }
};

const setCachedComments = (cacheKey, data) => {
  // Remove oldest entries if cache is too large
  if (commentsCache.size >= MAX_COMMENTS_CACHE_SIZE) {
    const oldestKey = commentsCache.keys().next().value;
    commentsCache.delete(oldestKey);
  }
  
  commentsCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
};

// Clear comments cache for a specific chapter
const clearCommentsCache = (chapterId, novelId = null) => {
  const keysToDelete = [];
  for (const [key, value] of commentsCache.entries()) {
    // Clear all cache entries that contain this chapterId
    if (key.includes(`comments_${chapterId}_`) || 
        (novelId && key.includes(`comments_${chapterId}_${novelId}_`))) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach(key => commentsCache.delete(key));
  
};

// Cache chapter interaction to reduce duplicate queries
const getCachedChapterInteraction = async (userId, chapterId) => {
  if (!userId || !chapterId) return null;
  
  const cacheKey = `interaction_${userId}_${chapterId}`;
  const cached = chapterInteractionCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < INTERACTION_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const UserChapterInteraction = mongoose.model('UserChapterInteraction');
    const interaction = await UserChapterInteraction.findOne({
      userId: mongoose.Types.ObjectId.createFromHexString(userId),
      chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId)
    }).lean();
    
    // Cache the result (including null)
    chapterInteractionCache.set(cacheKey, {
      data: interaction,
      timestamp: Date.now()
    });
    
    return interaction;
  } catch (error) {
    console.error('Error fetching chapter interaction:', error);
    return null;
  }
};

// Clear interaction cache for a user-chapter pair
const clearChapterInteractionCache = (userId, chapterId) => {
  const cacheKey = `interaction_${userId}_${chapterId}`;
  chapterInteractionCache.delete(cacheKey);
};

// Use global user cache for permission checks instead of local cache
const getCachedUserPermissions = async (username) => {
  if (!username) return null;
  
  try {
    // Use the global user cache system instead of local cache
    const userData = await getCachedUserByUsername(username);
    return userData;
  } catch (error) {
    console.error('Error fetching user permissions:', error);
    return null;
  }
};

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

// Query deduplication and caching helper
const dedupQuery = async (key, queryFn, ttl = RESULT_CACHE_TTL) => {
  // Check if we have a cached result first
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.data;
  }
  
  // If query is already pending, wait for it
  if (pendingQueries.has(key)) {
    return await pendingQueries.get(key);
  }
  
  // Start new query
  const queryPromise = queryFn();
  pendingQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    
    // Cache the result
    resultCache.set(key, {
      data: result,
      timestamp: Date.now()
    });
    
    // Clean up old cache entries periodically
    if (resultCache.size > 100) {
      const cutoff = Date.now() - (ttl * 2);
      for (const [cacheKey, value] of resultCache.entries()) {
        if (value.timestamp < cutoff) {
          resultCache.delete(cacheKey);
        }
      }
    }
    
    return result;
  } finally {
    // Clean up pending query
    pendingQueries.delete(key);
  }
};

// Helper function to clear user-specific caches
const clearUserCaches = (userId) => {
  let clearedCount = 0;
  
  // Clear pending queries for this user AND anonymous queries (critical for login transition)
  for (const [key, promise] of pendingQueries.entries()) {
    if (key.includes(`:user:${userId}`) || key.includes(`:user:anonymous`)) {
      pendingQueries.delete(key);
      clearedCount++;
    }
  }
  
  // Clear result cache for this user
  for (const [key, value] of resultCache.entries()) {
    if (key.includes(`:user:${userId}`) || key.includes(`:user:anonymous`)) {
      resultCache.delete(key);
      clearedCount++;
    }
  }
  
  // Clear user cache
  if (userCache.has(userId)) {
    userCache.delete(userId);
    clearedCount++;
  }
  
  // Clear username cache (in case user changes username)
  for (const [key, value] of usernameCache.entries()) {
    if (value.data && value.data._id && value.data._id.toString() === userId) {
      usernameCache.delete(key);
      clearedCount++;
    }
  }
  
  // Clear user permission cache for this user
  for (const [key, value] of userPermissionCache.entries()) {
    if (key.includes(`user:${userId}:`)) {
      userPermissionCache.delete(key);
      clearedCount++;
    }
  }
  
  // Clear comments cache for this user
  const commentKeysToDelete = [];
  for (const [key, value] of commentsCache.entries()) {
    if (key.includes(`_${userId}_`) || key.includes(`_anon_`)) {
      commentKeysToDelete.push(key);
    }
  }
  commentKeysToDelete.forEach(key => {
    commentsCache.delete(key);
    clearedCount++;
  });
  
  // Clear interaction cache for this user
  const interactionKeysToDelete = [];
  for (const [key, value] of chapterInteractionCache.entries()) {
    if (key.includes(`interaction_${userId}_`)) {
      interactionKeysToDelete.push(key);
    }
  }
  interactionKeysToDelete.forEach(key => {
    chapterInteractionCache.delete(key);
    clearedCount++;
  });
  
  return clearedCount;
};

// Comprehensive cache clearing for chapter operations
const clearChapterRelatedCaches = (chapterId, novelId = null, userId = null) => {
  let clearedCount = 0;
  
  // Clear chapter-specific caches
  clearChapterCaches(chapterId);
  
  // Clear comments cache for this chapter
  clearCommentsCache(chapterId, novelId);
  
  // Clear interaction cache if user specified
  if (userId) {
    clearChapterInteractionCache(userId, chapterId);
  }
  
  // Clear relevant query deduplication cache
  for (const [key, promise] of pendingQueries.entries()) {
    if (key.includes(`chapter:${chapterId}`) || 
        key.includes(`chapter_full_optimized:${chapterId}`) ||
        (novelId && key.includes(`comments_${novelId}`))) {
      pendingQueries.delete(key);
      clearedCount++;
    }
  }
  
  // Clear result cache for this chapter
  for (const [key, value] of resultCache.entries()) {
    if (key.includes(`chapter:${chapterId}`) || 
        key.includes(`chapter_full_optimized:${chapterId}`) ||
        (novelId && key.includes(`comments_${novelId}`))) {
      resultCache.delete(key);
      clearedCount++;
    }
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

    
    // OPTIMIZATION: Enhanced deduplication with user context and 2-minute caching for frequently accessed chapters
    const userId = req.user?._id?.toString() || 'anonymous';
    const chapterData = await dedupQuery(`chapter:${req.params.id}:user:${userId}`, async () => {
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
              { $project: { mode: 1, moduleBalance: 1, rentBalance: 1, recalculateRentOnUnlock: 1 } }
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
              { $project: { title: 1, mode: 1, moduleBalance: 1, rentBalance: 1, recalculateRentOnUnlock: 1 } }
            ],
            as: 'module'
          }
        },
        
      // Lookup the user who created this chapter (avoid post-processing populate)
      {
        $lookup: {
          from: 'users',
          localField: 'createdBy',
          foreignField: '_id',
          pipeline: [
            { $project: { displayName: 1, username: 1, userNumber: 1 } }
          ],
          as: 'createdByUser'
        }
      },
      // Staff resolution via $lookup
      {
        $lookup: {
          from: 'users',
          let: { staffVal: '$translator' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ['$_id', '$$staffVal'] },
                    { $eq: [{ $toString: '$_id' }, '$$staffVal'] },
                    { $eq: ['$username', '$$staffVal'] },
                    { $eq: ['$userNumber', '$$staffVal'] }
                  ]
                }
              }
            },
            { $project: { displayName: 1, username: 1, userNumber: 1 } }
          ],
          as: 'translatorUser'
        }
      },
      {
        $lookup: {
          from: 'users',
          let: { staffVal: '$editor' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ['$_id', '$$staffVal'] },
                    { $eq: [{ $toString: '$_id' }, '$$staffVal'] },
                    { $eq: ['$username', '$$staffVal'] },
                    { $eq: ['$userNumber', '$$staffVal'] }
                  ]
                }
              }
            },
            { $project: { displayName: 1, username: 1, userNumber: 1 } }
          ],
          as: 'editorUser'
        }
      },
      {
        $lookup: {
          from: 'users',
          let: { staffVal: '$proofreader' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ['$_id', '$$staffVal'] },
                    { $eq: [{ $toString: '$_id' }, '$$staffVal'] },
                    { $eq: ['$username', '$$staffVal'] },
                    { $eq: ['$userNumber', '$$staffVal'] }
                  ]
                }
              }
            },
            { $project: { displayName: 1, username: 1, userNumber: 1 } }
          ],
          as: 'proofreaderUser'
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
        
        // Map staff users and include only necessary fields
        {
          $addFields: {
            translator: { $ifNull: [ { $arrayElemAt: ['$translatorUser', 0] }, '$translator' ] },
            editor: { $ifNull: [ { $arrayElemAt: ['$editorUser', 0] }, '$editor' ] },
            proofreader: { $ifNull: [ { $arrayElemAt: ['$proofreaderUser', 0] }, '$proofreader' ] },
            createdByUser: { $arrayElemAt: ['$createdByUser', 0] }
          }
        },
        {
          $project: {
            _id: 1,
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
    }, 1000 * 30); // Cache for 30 seconds - now with actual result caching!

    if (!chapterData) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

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
    
    // CRITICAL FIX: Check module-level access FIRST before individual chapter access
    // If module is paid, user must have rental access regardless of individual chapter mode
    if (!hasAccess && chapterData.module?.mode === 'paid') {
      if (user && chapterData.moduleId) {
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
      // If module is paid and user doesn't have rental access, deny access regardless of chapter mode
      // This prevents published chapters in paid modules from being accessible without payment
    }
    
    // Check mode-based access for regular users ONLY if module is not paid OR user has module access
    if (!hasAccess && chapterData.module?.mode !== 'paid') {
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
          // Individual paid chapters in non-paid modules
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



    // If user doesn't have access, return limited chapter info
    if (!hasAccess) {
      // Populate staff ObjectIds with user display names for metadata
      const populatedChapter = await populateStaffNames(chapterData);
      
      // Return chapter without content
      const { content, ...chapterWithoutContent } = populatedChapter;
      
      const response = { 
        chapter: {
          ...chapterWithoutContent,
          accessDenied: true,
          accessMessage: getAccessMessage(chapterData, user)
        }
      };
      

      return res.json(response);
    }



      // Chapter is already populated via aggregation above
      const populatedChapter = chapterData;

    // Handle view counting asynchronously (fire-and-forget) with cooldown
    // Count views for all users (both authenticated and anonymous) but with 4-hour cooldown
    setImmediate(async () => {
      try {
        let shouldIncrementView = false;
        
        if (req.user) {
          // For view tracking, we need fresh data to avoid stale aggregation results
          // Use cached interaction lookup to get the most recent lastReadAt
          const existingInteraction = await getCachedChapterInteraction(req.user._id.toString(), req.params.id);
          
          if (!existingInteraction || !existingInteraction.lastReadAt) {
            // First time viewing this chapter
            shouldIncrementView = true;
          } else {
            // Check if last view was more than 4 hours ago
            const fourHours = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
            const timeSinceLastView = Date.now() - existingInteraction.lastReadAt.getTime();
            shouldIncrementView = timeSinceLastView > fourHours;
          }
          
          // Only update interaction if significant time has passed or it's first view
          const shouldUpdateInteraction = !existingInteraction || shouldIncrementView;
          
          if (shouldUpdateInteraction) {
            // Update user interaction only when necessary
            await UserChapterInteraction.findOneAndUpdate(
              { userId: req.user._id, chapterId: req.params.id, novelId: chapterData.novelId },
              {
                $setOnInsert: {
                  userId: req.user._id,
                  chapterId: req.params.id,
                  novelId: chapterData.novelId,
                  createdAt: new Date(),
                  liked: false,
                  bookmarked: false
                },
                $set: {
                  lastReadAt: new Date(),
                  updatedAt: new Date()
                }
              },
              { upsert: true }
            );
            
            // Clear the interaction cache since we just updated it
            clearChapterInteractionCache(req.user._id.toString(), req.params.id);
          }
        } else {
          // For anonymous users, implement server-side rate limiting using IP address
          // This prevents anonymous users from spamming views
          const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
          const ipViewKey = `ip_view_${clientIP}_${req.params.id}`;
          
          // Check if this IP has viewed this chapter recently (using a simple in-memory cache)
          if (!global.viewIPCache) {
            global.viewIPCache = new Map();
          }
          
          const lastViewTime = global.viewIPCache.get(ipViewKey);
          const now = Date.now();
          const fourHours = 4 * 60 * 60 * 1000; // 4 hours cooldown for anonymous users
          
          if (!lastViewTime || (now - lastViewTime) > fourHours) {
            shouldIncrementView = true;
            global.viewIPCache.set(ipViewKey, now);
            
            // Clean up old entries every 100 views to prevent memory leaks
            if (global.viewIPCache.size > 1000) {
              const cutoffTime = now - (24 * 60 * 60 * 1000); // 24 hours ago
              for (const [key, timestamp] of global.viewIPCache.entries()) {
                if (timestamp < cutoffTime) {
                  global.viewIPCache.delete(key);
                }
              }
            }
          }
        }
        
        // Only increment view count if cooldown has passed
        if (shouldIncrementView) {
          await Chapter.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
        }
      } catch (error) {
        console.error('Error updating view count and recently read:', error);
      }
    });

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
      originallyDraft: (mode === 'draft'), // Track if originally created as draft
      views: 0,
      footnotes: footnotes || [],
      chapterBalance: mode === 'paid' ? (chapterBalance || 0) : 0,
      wordCount: calculatedWordCount
    });

    // Save the chapter
    const newChapter = await chapter.save();

    // Check if this is a draft chapter - draft chapters should not update novel timestamp or send notifications
    const isDraftChapter = (mode === 'draft');

    // Prepare update operations - conditionally include novel timestamp update
    const updateOperations = [
      // Update the module's chapters array
      Module.findByIdAndUpdate(
        moduleId,
        { $addToSet: { chapters: newChapter._id } },
        { maxTimeMS: 5000 }
      ),
      
      // Recalculate novel word count with the new chapter (has built-in retry logic)
      recalculateNovelWordCount(novelId),
      
      // Clear novel caches
      clearNovelCaches()
    ];

    // Only update novel timestamp if this is NOT a draft chapter
    if (!isDraftChapter) {
      updateOperations.splice(1, 0, // Insert at index 1
        Novel.findByIdAndUpdate(
          novelId,
          { updatedAt: new Date() },
          { maxTimeMS: 5000 }
        )
      );
    }

    // Add rent balance calculation if this is a paid chapter
    if (mode === 'paid' && chapterBalance > 0) {
      updateOperations.push(calculateAndUpdateModuleRentBalance(moduleId));
    }

    // Perform multiple updates in parallel with timeout protection
    // Use Promise.allSettled to ensure one failing operation doesn't fail the entire request
    const updateResults = await Promise.allSettled(updateOperations);

    // Log any failed operations but don't fail the entire request
    updateResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const operationNames = isDraftChapter 
          ? ['module update', 'word count recalculation', 'cache clearing', 'rent balance calculation']
          : ['module update', 'novel timestamp update', 'word count recalculation', 'cache clearing', 'rent balance calculation'];
        console.error(`Post-creation operation failed (${operationNames[index]}):`, result.reason);
      }
    });

    // Get novel info for the notification
    const novel = await Novel.findById(novelId).select('title');

    // Always notify clients about new chapters (both draft and published)
    // But only create user notifications for non-draft chapters
    if (!isDraftChapter) {
      // Create notifications for users who bookmarked this novel (only for published chapters)
      await createNewChapterNotifications(
        novelId.toString(),
        newChapter._id.toString(),
        newChapter.title
      );
    }

    // Always notify all clients about the new chapter (including drafts)
    // This ensures the novel detail page updates immediately
    notifyAllClients('new_chapter', {
      chapterId: newChapter._id,
      chapterTitle: newChapter.title,
      novelId: novelId,
      novelTitle: novel?.title || 'Unknown Novel',
      isDraft: isDraftChapter, // Add flag to distinguish draft chapters
      timestamp: new Date().toISOString()
    });

    // Check for auto-unlock if a paid chapter was created
    if (mode === 'paid') {
      try {
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
        
        // Also clear the full-optimized endpoint cache
        pendingQueries.delete(`chapter_full_optimized:${newChapter._id}:user:anonymous`);
      } catch (unlockError) {
        console.error('Error during auto-unlock after paid chapter creation:', unlockError);
        // Don't fail the chapter creation if auto-unlock fails
        // The chapter was successfully created, auto-unlock is just a bonus feature
      }
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
    let transactionCommitted = false;
    
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

      // Check if chapter mode is changing from draft to any other mode (for timestamp update)
      const isDraftModeChanging = existingChapter.mode === 'draft' && 
        mode && mode !== 'draft';

      // Only update chapter timestamp when switching from draft to any other mode
      // This ensures the chapter shows the correct "published" date rather than creation date
      // For all other updates, preserve the existing timestamp
      
      // Log timestamp update for tracking
      if (isDraftModeChanging) {
        console.log(`Updating chapter timestamp for "${existingChapter.title}" due to mode change from draft to ${mode}`);
      }

      // Check if title changed to generate new slug
      let titleChanged = false;
      if (title && title !== existingChapter.title) {
        titleChanged = true;
      }

      // Build update object conditionally
      const updateFields = {
        ...(title && { title }),
        ...(content && { content }),
        ...(translator !== undefined && { translator }),
        ...(editor !== undefined && { editor }),
        ...(proofreader !== undefined && { proofreader }),
        ...(mode && { mode }),
        chapterBalance: finalChapterBalance,
        footnotes,
        wordCount: finalWordCount, // Use calculated or provided word count
        // ONLY update timestamp if mode is changing from draft to another mode
        ...(isDraftModeChanging && { updatedAt: new Date() })
      };

      // Update the chapter
      const updatedChapter = await Chapter.findByIdAndUpdate(
        chapterId,
        updateFields,
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

      // Check if chapter is being switched from draft to any public mode
      // This should also update the novel timestamp and send notifications
      // BUT ONLY if the chapter was originally created in draft mode to prevent abuse
      const isDraftBecomingPublic = existingChapter.mode === 'draft' && 
        mode && (mode === 'published' || mode === 'protected' || mode === 'paid') &&
        existingChapter.originallyDraft === true; // Only for chapters originally created as drafts

      // Only update novel's timestamp for significant changes that should affect "latest updates"
      // Don't update for simple content edits, administrative balance changes, etc.
      // Novel timestamp will be updated automatically when paid content is unlocked via contributions
      // Exceptions: 
      // 1. When manually switching a chapter from paid to published/protected
      // 2. When switching a chapter from draft to any public mode (but ONLY if originally created as draft)
      const shouldUpdateNovelTimestamp = isUnlockingPaidContent || isDraftBecomingPublic;

      if (shouldUpdateNovelTimestamp) {
        await Novel.findByIdAndUpdate(
          existingChapter.novelId,
          { updatedAt: new Date() },
          { session }
        );
      }

      await session.commitTransaction();
      transactionCommitted = true;

      // Generate new slug if title changed (for frontend URL update)
      let newSlug = null;
      if (titleChanged && novel) {
        newSlug = createUniqueSlug(updatedChapter.title, updatedChapter._id);
      }

      // Clear novel caches
      clearNovelCaches();
      
      // Clear all chapter-related caches comprehensively
      clearChapterRelatedCaches(updatedChapter._id.toString(), existingChapter.novelId.toString(), req.user._id.toString());
      
      // Clear slug cache entries for this chapter to prevent stale data
      const chapterIdString = updatedChapter._id.toString();
      const keysToDelete = [];
      for (const [key, value] of slugCache.entries()) {
        if (value.data && value.data.id && value.data.id.toString() === chapterIdString) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => slugCache.delete(key));

      // Send notifications and SSE updates for draft chapters becoming public
      if (isDraftBecomingPublic) {
        try {
          // Get novel info for notifications
          const novel = await Novel.findById(existingChapter.novelId).select('title');
          
          // Create notifications for users who bookmarked this novel
          await createNewChapterNotifications(
            existingChapter.novelId.toString(),
            updatedChapter._id.toString(),
            updatedChapter.title
          );

          // Notify all clients about the chapter becoming public
          notifyAllClients('new_chapter', {
            chapterId: updatedChapter._id,
            chapterTitle: updatedChapter.title,
            novelId: existingChapter.novelId,
            novelTitle: novel?.title || 'Unknown Novel',
            timestamp: new Date().toISOString()
          });
        } catch (notificationError) {
          console.error('Error sending notifications for draft chapter becoming public:', notificationError);
          // Don't fail the chapter update if notifications fail
        }
      }

      // Check if chapterBalance changed and trigger auto-unlock if needed
      const chapterBalanceChanged = req.user.role === 'admin' && 
        finalChapterBalance !== existingChapter.chapterBalance;
        
      // Check if we need to recalculate module rent balance
      const modeChanged = mode && mode !== existingChapter.mode;
      const shouldRecalculateRentBalance = modeChanged || chapterBalanceChanged;
      
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
      
      // Also clear the full-optimized endpoint cache
      pendingQueries.delete(`chapter_full_optimized:${updatedChapter._id}:user:anonymous`);
      if (req.user && req.user._id) {
        pendingQueries.delete(`chapter_full_optimized:${updatedChapter._id}:user:${req.user._id}`);
      }
        } catch (unlockError) {
          console.error('Error during auto-unlock after chapterBalance change:', unlockError);
          // Don't fail the chapter update if auto-unlock fails
        }
      }
      
      // Recalculate module rent balance if mode or balance changed
      if (shouldRecalculateRentBalance) {
        try {
          // If chapter is being switched from paid to another mode, use conditional recalculation
          // to respect the recalculateRentOnUnlock flag
          if (existingChapter.mode === 'paid' && mode && mode !== 'paid') {
            await conditionallyRecalculateRentBalance(existingChapter.moduleId);
          } else {
            // For other changes (like adding/removing paid chapters), always recalculate
            await calculateAndUpdateModuleRentBalance(existingChapter.moduleId);
          }
        } catch (rentBalanceError) {
          console.error('Error recalculating module rent balance:', rentBalanceError);
          // Don't fail the chapter update if rent balance calculation fails
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
      
      // Add new slug to response if title changed
      const response = populatedChapter;
      if (newSlug) {
        response.newSlug = newSlug;
      }
      
      return res.json(response);

    } catch (err) {
      // Only abort transaction if it hasn't been committed yet
      if (!transactionCommitted) {
        await session.abortTransaction();
      }
      
      attempt++;
      
      // Check if this is a transient error that can be retried
      const isRetryableError = err.errorLabels?.includes('TransientTransactionError') ||
                              err.code === 112 || // WriteConflict
                              err.code === 11000 || // DuplicateKey
                              err.code === 16500; // InterruptedAtShutdown
      
      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Retrying chapter update (attempt ${attempt}/${maxRetries}) for chapter ${req.params.id}:`, err.message);
        
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
    let transactionCommitted = false;
    
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
      const { novelId, moduleId, order: deletedOrder } = chapter;
      const wasPaidChapter = chapter.mode === 'paid' && chapter.chapterBalance > 0;

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

      // Reorder remaining chapters in the same module
      // Decrement order by 1 for all chapters with order > deletedOrder
      await Chapter.updateMany(
        { 
          moduleId: moduleId,
          order: { $gt: deletedOrder }
        },
        { 
          $inc: { order: -1 }
        },
        { session, maxTimeMS: 10000 }
      );

      // Delete all user interactions for this chapter
      await UserChapterInteraction.deleteMany(
        { chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId) },
        { session }
      );

      // Recalculate novel word count with retry logic
      await recalculateNovelWordCount(novelId, session);
      
      // Recalculate module rent balance if this was a paid chapter
      if (wasPaidChapter) {
        await calculateAndUpdateModuleRentBalance(moduleId, session);
      }

      // Don't update novel's timestamp when deleting chapters
      // Chapter deletion is a management action, not new content

      await session.commitTransaction();
      transactionCommitted = true;

      // Clear novel caches
      clearNovelCaches();
      
      // Clear all chapter-related caches comprehensively
      clearChapterRelatedCaches(chapterId, novelId.toString());
      
      // Clear slug cache entries for this chapter
      const keysToDelete = [];
      for (const [key, value] of slugCache.entries()) {
        if (value.data && value.data.id && value.data.id.toString() === chapterId) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => slugCache.delete(key));

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
      // Only abort transaction if it hasn't been committed yet
      if (!transactionCommitted) {
        await session.abortTransaction();
      }
      
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
            pipeline: [ { '$project': { title: 1, mode: 1, moduleBalance: 1, rentBalance: 1, recalculateRentOnUnlock: 1 } } ], 
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
    
    // Log successful chapter fetch
    console.log(`Fetched chapter: "${chapter.title}" (ID: ${chapter._id})`);
    
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
    
    // CRITICAL FIX: Check module-level access FIRST before individual chapter access
    // If module is paid, user must have rental access regardless of individual chapter mode
    if (!hasAccess && chapter.module?.mode === 'paid') {
      if (user && chapter.moduleId) {
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
      // If module is paid and user doesn't have rental access, deny access regardless of chapter mode
      // This prevents published chapters in paid modules from being accessible without payment
    }
    
    // Check mode-based access for regular users ONLY if module is not paid OR user has module access
    if (!hasAccess && chapter.module?.mode !== 'paid') {
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
          // Individual paid chapters in non-paid modules
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

    // OPTIMIZATION: Use cached user lookup for staff names
    const staffIds = [];
    ['translator','editor','proofreader'].forEach(k => {
      if (chapter[k] && mongoose.Types.ObjectId.isValid(chapter[k])) {
        staffIds.push(chapter[k].toString());
      }
    });
    
    let populatedChapter = chapter;
    if (staffIds.length > 0) {
      const users = await getCachedUsers(staffIds);
      const staffMap = {};
      users.forEach(u => {
        staffMap[u._id.toString()] = u;
      });
      
      populatedChapter = {
        ...chapter,
        translator: chapter.translator && staffMap[chapter.translator] ? staffMap[chapter.translator] : chapter.translator,
        editor: chapter.editor && staffMap[chapter.editor] ? staffMap[chapter.editor] : chapter.editor,
        proofreader: chapter.proofreader && staffMap[chapter.proofreader] ? staffMap[chapter.proofreader] : chapter.proofreader
      };
    }

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



    // Build interaction response
    const interactions = {
      totalLikes: stats?.totalLikes || 0,
      userInteraction: {
        liked: userInteraction?.liked || false,
        bookmarked: userInteraction?.bookmarked || false
      }
    };

    // OPTIMIZATION: Handle very long content more efficiently
    const isVeryLongContent = populatedChapter.content && populatedChapter.content.length > 300000;
    
    if (isVeryLongContent) {
      // Set appropriate headers for large content
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes cache for long content
    }

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
                update: { $set: { wordCount: wordCount } }
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

/**
 * Get chapter with all related data (optimized single query) - INCLUDES ALL NAVIGATION AND MODULE CHAPTERS
 * @route GET /api/chapters/:chapterId/full-optimized
 */
router.get('/:chapterId/full-optimized', optionalAuth, async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const userId = req.user?._id;
    
    // Auth debug info for protected chapters
    if (req.headers['user-agent']?.toLowerCase().includes('mobile') || 
        req.headers['user-agent']?.toLowerCase().includes('android') || 
        req.headers['user-agent']?.toLowerCase().includes('iphone')) {
    }
    
    // OPTIMIZATION: Use deduplication for the complex chapter query
    // For authenticated users, ensure we're not using stale anonymous cache
    const cacheKey = `chapter_full_optimized:${chapterId}:user:${userId || 'anonymous'}`;
    
    // If user just logged in, clear any anonymous cache for this chapter
    if (userId && pendingQueries.has(`chapter_full_optimized:${chapterId}:user:anonymous`)) {
      pendingQueries.delete(`chapter_full_optimized:${chapterId}:user:anonymous`);
    }
    
    const chapterData = await dedupQuery(cacheKey, async () => {
      // Single aggregation pipeline that gets everything INCLUDING all module chapters
      const pipeline = [
      {
        $match: { _id: new mongoose.Types.ObjectId(chapterId) }
      },
      // Lookup novel data
      {
        $lookup: {
          from: 'novels',
          localField: 'novelId',
          foreignField: '_id',
          pipeline: [
            { $project: { title: 1, illustration: 1, active: 1, author: 1, status: 1, genres: 1 } }
          ],
          as: 'novel'
        }
      },
      // Lookup module data
      {
        $lookup: {
          from: 'modules',
          localField: 'moduleId',
          foreignField: '_id',
          pipeline: [
            { $project: { title: 1, mode: 1, moduleBalance: 1, rentBalance: 1, recalculateRentOnUnlock: 1 } }
          ],
          as: 'module'
        }
      },
      // Lookup user who created this chapter
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
      // Lookup ALL chapters in the module for navigation and dropdown
      {
        $lookup: {
          from: 'chapters',
          let: { moduleId: '$moduleId', currentOrder: '$order', chapterId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$moduleId', '$$moduleId'] }
              }
            },
            { $project: { _id: 1, title: 1, order: 1, mode: 1, chapterBalance: 1 } },
            { $sort: { order: 1 } }
          ],
          as: 'allModuleChapters'
        }
      },
      // Lookup user interactions if authenticated
      ...(userId ? [{
        $lookup: {
          from: 'userchapterinteractions',
          let: { chapterId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$chapterId', '$$chapterId'] },
                    { $eq: ['$userId', userId] }
                  ]
                }
              }
            },
            { $project: { liked: 1, bookmarked: 1, _id: 0 } }
          ],
          as: 'userInteraction'
        }
      }] : []),
      // Lookup active module rental for authenticated users
      ...(userId ? [{
        $lookup: {
          from: 'modulerentals',
          let: { moduleId: '$moduleId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$moduleId', '$$moduleId'] },
                    { $eq: ['$userId', userId] },
                    { $eq: ['$isActive', true] },
                    { $gt: ['$endTime', new Date()] }
                  ]
                }
              }
            },
            { $project: { _id: 1, endTime: 1, amountPaid: 1 } },
            { $limit: 1 }
          ],
          as: 'activeRental'
        }
      }] : []),
      // Lookup chapter statistics
      {
        $lookup: {
          from: 'userchapterinteractions',
          let: { chapterId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$chapterId', '$$chapterId'] }
              }
            },
            {
              $group: {
                _id: null,
                totalLikes: {
                  $sum: { $cond: [{ $eq: ['$liked', true] }, 1, 0] }
                }
              }
            }
          ],
          as: 'chapterStats'
        }
      },
      // Process the results and compute navigation
      {
        $addFields: {
          novel: { $arrayElemAt: ['$novel', 0] },
          module: { $arrayElemAt: ['$module', 0] },
          createdByUser: { $arrayElemAt: ['$createdByUser', 0] },
          userInteraction: { $arrayElemAt: ['$userInteraction', 0] },
          chapterStats: { $arrayElemAt: ['$chapterStats', 0] },
          // Compute previous chapter more robustly
          prevChapter: {
            $let: {
              vars: {
                prevChapters: {
                  $filter: {
                    input: '$allModuleChapters',
                    as: 'chapter',
                    cond: { 
                      $and: [
                        { $lt: ['$$chapter.order', '$order'] },
                        { $ne: ['$$chapter._id', '$_id'] }
                      ]
                    }
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
          // Compute next chapter more robustly  
          nextChapter: {
            $let: {
              vars: {
                nextChapters: {
                  $filter: {
                    input: '$allModuleChapters',
                    as: 'chapter',
                    cond: { 
                      $and: [
                        { $gt: ['$$chapter.order', '$order'] },
                        { $ne: ['$$chapter._id', '$_id'] }
                      ]
                    }
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
      // Final projection (include all fields we need)
      {
        $project: {
          _id: 1,
          title: 1,
          content: 1,
          footnotes: 1,
          mode: 1,
          chapterBalance: 1,
          order: 1,
          views: 1,
          wordCount: 1,
          createdAt: 1,
          updatedAt: 1,
          translator: 1,
          editor: 1,
          proofreader: 1,
          moduleId: 1,
          novelId: 1,
          novel: 1,
          module: 1,
          createdByUser: 1,
          prevChapter: 1,
          nextChapter: 1,
          userInteraction: 1,
          chapterStats: 1,
          allModuleChapters: 1, // Include all module chapters for dropdown
          activeRental: 1 // Include active rental information
        }
      }
    ];

      const [result] = await Chapter.aggregate(pipeline);
      return result;
    }, 1000 * 45); // Cache for 45 seconds - now with actual result caching!
    
    if (!chapterData) {
      console.log(`Chapter not found (ID: ${chapterId})`);
      return res.status(404).json({ message: 'Chapter not found' });
    }
    

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
    else if (user && user.role === 'pj_user' && chapterData.novel?.active?.pj_user) {
      const isAuthorized = chapterData.novel.active.pj_user.includes(user._id.toString()) || 
                          chapterData.novel.active.pj_user.includes(user.username);
      if (isAuthorized) {
        hasAccess = true;
        accessReason = 'pj_user';
      }
    }
    
    // CRITICAL FIX: Check module-level access FIRST before individual chapter access
    // If module is paid, user must have rental access regardless of individual chapter mode
    if (!hasAccess && chapterData.module?.mode === 'paid') {
      if (user && chapterData.moduleId) {
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
      // If module is paid and user doesn't have rental access, deny access regardless of chapter mode
      // This prevents published chapters in paid modules from being accessible without payment
    }
    
    // Check mode-based access for regular users ONLY if module is not paid OR user has module access
    if (!hasAccess && chapterData.module?.mode !== 'paid') {
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
          // Individual paid chapters in non-paid modules
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

    // Helper function to check if user can see draft chapters
    const canUserSeeDraftChapters = (user, novel) => {
      if (!user) return false;
      
      // Admin and moderator can see all draft chapters
      if (user.role === 'admin' || user.role === 'moderator') {
        return true;
      }
      
      // pj_user can see draft chapters for their assigned novels
      if (user.role === 'pj_user' && novel?.active?.pj_user) {
        const isAuthorized = novel.active.pj_user.includes(user._id.toString()) || 
                            novel.active.pj_user.includes(user.username);
        return isAuthorized;
      }
      
      return false;
    };
    
    // Filter function for draft chapters
    const shouldShowChapter = (chapter) => {
      if (chapter.mode !== 'draft') {
        return true; // Show non-draft chapters to everyone
      }
      return canUserSeeDraftChapters(user, chapterData.novel);
    };

    // Filter draft chapters from allModuleChapters based on user permissions
    if (chapterData.allModuleChapters && chapterData.allModuleChapters.length > 0) {
      chapterData.allModuleChapters = chapterData.allModuleChapters.filter(shouldShowChapter);
    }
    
    // Filter draft chapters from navigation (prev/next chapters)
    if (chapterData.prevChapter && chapterData.prevChapter.mode === 'draft' && !shouldShowChapter(chapterData.prevChapter)) {
      // Find the previous non-draft chapter that user can see
      const availableChapters = chapterData.allModuleChapters || [];
      const currentOrder = chapterData.order;
      const prevChapters = availableChapters
        .filter(ch => ch.order < currentOrder)
        .sort((a, b) => b.order - a.order); // Sort descending to get the closest previous
      
      chapterData.prevChapter = prevChapters[0] || null;
    }
    
    if (chapterData.nextChapter && chapterData.nextChapter.mode === 'draft' && !shouldShowChapter(chapterData.nextChapter)) {
      // Find the next non-draft chapter that user can see
      const availableChapters = chapterData.allModuleChapters || [];
      const currentOrder = chapterData.order;
      const nextChapters = availableChapters
        .filter(ch => ch.order > currentOrder)
        .sort((a, b) => a.order - b.order); // Sort ascending to get the closest next
      
      chapterData.nextChapter = nextChapters[0] || null;
    }

    // Populate staff ObjectIds with user display names for both chapter and nested novel data
    const populatedChapter = await populateStaffNames(chapterData);
    
    // Also populate the nested novel data if it exists
    if (populatedChapter.novel) {
      populatedChapter.novel = await populateStaffNames(populatedChapter.novel);
    }

    // Add rental information to the chapter if user has active rental
    if (chapterData.activeRental && chapterData.activeRental.length > 0) {
      populatedChapter.rentalInfo = {
        hasActiveRental: true,
        rental: chapterData.activeRental[0]
      };
    } else {
      populatedChapter.rentalInfo = {
        hasActiveRental: false
      };
    }

    // If user doesn't have access, return limited chapter info
    if (!hasAccess) {
      // Return chapter without content
      const { content, ...chapterWithoutContent } = populatedChapter;
      
      // Build interaction response
      const interactions = {
        totalLikes: chapterData.chapterStats?.totalLikes || 0,
        userInteraction: chapterData.userInteraction || { liked: false, bookmarked: false }
      };
      
      const response = {
        chapter: {
          ...chapterWithoutContent,
          accessDenied: true,
          accessMessage: getAccessMessage(chapterData, user)
        },
        interactions,
        moduleChapters: chapterData.allModuleChapters || []
      };
      
      return res.json(response);
    }

    // Format the response to match existing structure
    const response = {
      chapter: populatedChapter,
      interactions: {
        totalLikes: chapterData.chapterStats?.totalLikes || 0,
        userInteraction: chapterData.userInteraction || { liked: false, bookmarked: false }
      },
      // Include module chapters to eliminate the need for separate query
      moduleChapters: chapterData.allModuleChapters || []
    };

    // Handle view counting asynchronously (fire-and-forget) with cooldown
    // Count views for all users (both authenticated and anonymous) but with 4-hour cooldown
    setImmediate(async () => {
      try {
        let shouldIncrementView = false;
        
        if (userId) {
          // For view tracking, we need fresh data to avoid stale aggregation results
          // Use cached interaction lookup to get the most recent lastReadAt
          const existingInteraction = await getCachedChapterInteraction(userId.toString(), chapterId);
          
          if (!existingInteraction || !existingInteraction.lastReadAt) {
            // First time viewing this chapter
            shouldIncrementView = true;
          } else {
            // Check if last view was more than 4 hours ago
            const fourHours = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
            const timeSinceLastView = Date.now() - existingInteraction.lastReadAt.getTime();
            shouldIncrementView = timeSinceLastView > fourHours;
          }
          
          // Only update interaction if significant time has passed or it's first view
          const shouldUpdateInteraction = !existingInteraction || shouldIncrementView;
          
          if (shouldUpdateInteraction) {
            // Update user interaction only when necessary
            await UserChapterInteraction.findOneAndUpdate(
              { userId, chapterId, novelId: chapterData.novel._id },
              {
                $setOnInsert: {
                  userId,
                  chapterId,
                  novelId: chapterData.novel._id,
                  createdAt: new Date(),
                  liked: false,
                  bookmarked: false
                },
                $set: {
                  lastReadAt: new Date(),
                  updatedAt: new Date()
                }
              },
              { upsert: true }
            );
            
            // Clear the interaction cache since we just updated it
            clearChapterInteractionCache(userId.toString(), chapterId);
          }
        } else {
          // For anonymous users, implement server-side rate limiting using IP address
          // This prevents anonymous users from spamming views
          const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
          const ipViewKey = `ip_view_${clientIP}_${chapterId}`;
          
          // Check if this IP has viewed this chapter recently (using a simple in-memory cache)
          if (!global.viewIPCache) {
            global.viewIPCache = new Map();
          }
          
          const lastViewTime = global.viewIPCache.get(ipViewKey);
          const now = Date.now();
          const fourHours = 4 * 60 * 60 * 1000; // 4 hours cooldown for anonymous users
          
          if (!lastViewTime || (now - lastViewTime) > fourHours) {
            shouldIncrementView = true;
            global.viewIPCache.set(ipViewKey, now);
            
            // Clean up old entries every 100 views to prevent memory leaks
            if (global.viewIPCache.size > 1000) {
              const cutoffTime = now - (24 * 60 * 60 * 1000); // 24 hours ago
              for (const [key, timestamp] of global.viewIPCache.entries()) {
                if (timestamp < cutoffTime) {
                  global.viewIPCache.delete(key);
                }
              }
            }
          }
        }
        
        // Only increment view count if cooldown has passed
        if (shouldIncrementView) {
          await Chapter.findByIdAndUpdate(chapterId, { $inc: { views: 1 } });
        }
      } catch (error) {
        console.error('Error updating view count and recently read:', error);
      }
    });

    res.json(response);
  } catch (error) {
    console.error('Error fetching chapter data:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Get cached comments for a chapter
 * @route GET /api/chapters/:chapterId/comments
 */
router.get('/:chapterId/comments', optionalAuth, async (req, res) => {
  try {
    const { chapterId } = req.params;
    const { page = 1, limit = 10, novelId } = req.query;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(chapterId)) {
      return res.status(400).json({ message: 'Invalid chapter ID format' });
    }
    
    let chapterNovelId = novelId;
    
    // If novelId is provided as query parameter, use it to avoid database lookup
    if (novelId && mongoose.Types.ObjectId.isValid(novelId)) {
      chapterNovelId = novelId;
    } else {
      // Fallback: Get chapter to extract novelId
      console.log(`Making database lookup for novelId, chapterId: ${chapterId}`);
      const chapter = await Chapter.findById(chapterId).select('novelId').lean();
      if (!chapter) {
        return res.status(404).json({ message: 'Chapter not found' });
      }
      chapterNovelId = chapter.novelId.toString();
    }
    
    const userId = req.user?._id?.toString();
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, Math.min(50, parseInt(limit))); // Cap at 50 comments per page
    
    // Use cached comments function
    const commentsData = await getCachedComments(
      chapterId, 
      chapterNovelId, 
      userId, 
      pageNum, 
      limitNum
    );
    
    res.json(commentsData);
  } catch (error) {
    console.error('Error fetching chapter comments:', error);
    res.status(500).json({ message: 'Failed to fetch comments' });
  }
});

/**
 * Clear all caches (admin only) - useful for debugging
 * @route POST /api/chapters/admin/clear-cache
 */
router.post('/admin/clear-cache', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  
  try {
    // Clear all caches
    slugCache.clear();
    userCache.clear();
    commentsCache.clear();
    chapterInteractionCache.clear();
    usernameCache.clear();
    userPermissionCache.clear();
    pendingQueries.clear();
    resultCache.clear();
    
    // Clear global view cache if it exists
    if (global.viewIPCache) {
      global.viewIPCache.clear();
    }
    
    console.log('All chapter-related caches cleared by admin');
    res.json({ 
      message: 'All caches cleared successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error clearing caches:', error);
    res.status(500).json({ message: 'Failed to clear caches' });
  }
});

/**
 * Get cached user permission data for privilege checks
 * @route GET /api/chapters/user-permissions/:username
 */
router.get('/user-permissions/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ message: 'Username is required' });
    }
    
    // Use cached user permission lookup
    const userData = await getCachedUserPermissions(username);
    
    if (!userData) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Return only the necessary permission data (no sensitive info)
    const permissionData = {
      _id: userData._id,
      username: userData.username,
      displayName: userData.displayName,
      role: userData.role,
      userNumber: userData.userNumber,
      avatar: userData.avatar
    };
    
    res.json(permissionData);
  } catch (error) {
    console.error('Error fetching user permissions:', error);
    res.status(500).json({ message: 'Failed to fetch user permissions' });
  }
});

export default router; 