/**
 * Shared cache utilities for chapter-related caching
 * This module provides cache management functions that can be used across different routes
 * to maintain consistency and avoid circular dependencies.
 */

// Import cache clearing functions
import { clearNovelCaches, notifyAllClients } from './cacheUtils.js';

// Cache maps that will be shared across modules
let commentsCache = null;
let userCache = null;
let chapterInteractionCache = null;
let usernameCache = null;
let userPermissionCache = null;

// Initialize cache references (called from chapters.js)
export const initializeCacheReferences = (caches) => {
  commentsCache = caches.commentsCache;
  userCache = caches.userCache;
  chapterInteractionCache = caches.chapterInteractionCache;
  usernameCache = caches.usernameCache;
  userPermissionCache = caches.userPermissionCache;
};

/**
 * Clear comments cache for a specific chapter
 * @param {string} chapterId - Chapter ID
 * @param {string} novelId - Novel ID (optional)
 */
export const clearChapterCommentsCache = (chapterId, novelId = null) => {
  if (!commentsCache) {
    console.warn('Comments cache not initialized, clearing novel caches instead');
    clearNovelCaches();
    return;
  }
  
  const keysToDelete = [];
  for (const [key, value] of commentsCache.entries()) {
    // Clear all cache entries that contain this chapterId
    if (key.includes(`comments_${chapterId}_`) || 
        (novelId && key.includes(`comments_${chapterId}_${novelId}_`))) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach(key => commentsCache.delete(key));
  
  console.log(`Cleared ${keysToDelete.length} comment cache entries for chapter ${chapterId}`);
  
  // Also clear novel caches to ensure consistency
  clearNovelCaches();
  
  // Notify clients about the cache clear
  notifyAllClients('cache_clear', {
    type: 'chapter_comments',
    chapterId,
    novelId,
    timestamp: new Date().toISOString()
  });
};

/**
 * Clear user-specific comment caches
 * @param {string} userId - User ID
 */
export const clearUserCommentCaches = (userId) => {
  if (!commentsCache) return 0;
  
  let clearedCount = 0;
  const keysToDelete = [];
  
  for (const [key, value] of commentsCache.entries()) {
    if (key.includes(`_${userId}_`) || key.includes(`_anon_`)) {
      keysToDelete.push(key);
    }
  }
  
  keysToDelete.forEach(key => {
    commentsCache.delete(key);
    clearedCount++;
  });
  
  return clearedCount;
};

/**
 * Clear all comment-related caches
 */
export const clearAllCommentCaches = () => {
  if (commentsCache) {
    commentsCache.clear();
    console.log('All comment caches cleared');
  }
  if (userCache) {
    userCache.clear();
    console.log('All user caches cleared');
  }
  if (chapterInteractionCache) {
    chapterInteractionCache.clear();
    console.log('All chapter interaction caches cleared');
  }
  if (usernameCache) {
    usernameCache.clear();
    console.log('All username caches cleared');
  }
  if (userPermissionCache) {
    userPermissionCache.clear();
    console.log('All user permission caches cleared');
  }
  
  clearNovelCaches();
};

/**
 * Extract chapter and novel IDs from comment content
 * @param {Object} comment - Comment object
 * @returns {Object} - Object with chapterId and novelId
 */
export const extractCommentIdentifiers = (comment) => {
  if (!comment || !comment.contentId) {
    return { chapterId: null, novelId: null };
  }
  
  // Handle both old format (chapterId) and new format (novelId-chapterId)
  if (comment.contentId.includes('-')) {
    const [novelId, chapterId] = comment.contentId.split('-');
    return { chapterId, novelId };
  } else {
    return { chapterId: comment.contentId, novelId: null };
  }
};
