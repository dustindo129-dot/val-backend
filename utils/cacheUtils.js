/**
 * Cache and SSE Utilities
 * 
 * Provides functions for cache management and SSE client notifications
 */

import NodeCache from 'node-cache';

// Initialize cache with 10-minute TTL by default
export const cache = new NodeCache({ stdTTL: 600 });

// Set of active SSE clients
export const sseClients = new Set();

/**
 * Clear all novel-related caches
 */
export const clearNovelCaches = () => {
  // Clear hot novels cache
  cache.del('hot_novels');
  // Clear novels list cache (all pages)
  const keys = cache.keys();
  keys.forEach(key => {
    if (key.startsWith('novels_page_') || key.startsWith('novel_') || key.startsWith('chapter_')) {
      cache.del(key);
    }
  });
};

/**
 * Clear chapter-specific caches (for use in chapters.js)
 * @param {string} chapterId - Optional specific chapter ID to clear
 */
export const clearChapterCaches = (chapterId = null) => {
  const keys = cache.keys();
  keys.forEach(key => {
    // Clear all chapter-related caches
    if (key.startsWith('chapter_')) {
      cache.del(key);
    }
    // If specific chapter ID provided, also clear novel caches
    // since chapter changes affect novel data
    if (chapterId && (key.startsWith('novel_') || key.startsWith('novels_page_'))) {
      cache.del(key);
    }
  });
  
  // Also clear hot novels cache as chapter changes can affect rankings
  cache.del('hot_novels');
};

/**
 * Send a notification to all connected SSE clients
 * @param {string} eventName - The name of the event
 * @param {object} data - The data to send
 */
export const notifyAllClients = (eventName, data) => {
  const eventString = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  
  sseClients.forEach(client => {
    try {
      client.write(eventString);
    } catch (error) {
      console.error(`Error sending SSE event to client:`, error);
      // Remove problematic client
      sseClients.delete(client);
    }
  });


};

/**
 * Check if the request should bypass cache
 * @param {string} path - Request path
 * @param {object} query - Query parameters
 * @returns {boolean} - Whether to bypass cache
 */
export const shouldBypassCache = (path, query) => {
  // Bypass cache if explicitly requested via query parameter
  if (query && (query._cb || query.forceRefresh || query.bypass)) {
    return true;
  }

  // Bypass cache for critical paths
  const criticalPaths = ['/hot', '/api/novels/latest'];
  return criticalPaths.some(criticalPath => path.includes(criticalPath));
}; 