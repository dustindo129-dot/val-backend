import NodeCache from 'node-cache';

// Initialize cache with 5 minute TTL
// This should match the cache in novels.js
export const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes

// Flag to completely disable homepage caching
export const DISABLE_HOMEPAGE_CACHE = true;

// Keep track of connected SSE clients
export const sseClients = new Set();

/**
 * Helper function to check if caching should be bypassed
 * @param {string} path - The route path
 * @returns {boolean} - Whether to bypass cache
 */
export const shouldBypassCache = (path, query = {}) => {
  // Critical paths that should never be cached
  const criticalPaths = ['/', '/hot'];
  
  // Always bypass for homepage and hot novels
  if (DISABLE_HOMEPAGE_CACHE && criticalPaths.some(p => path.endsWith(p))) {
    return true;
  }
  
  // Bypass if cache busting parameters present
  if (query && (query._cb || query.skipCache || query.refresh)) {
    return true;
  }
  
  return false;
};

/**
 * Helper function to send updates to all connected clients
 * @param {string} eventType - The type of event (update, new_novel, new_chapter)
 * @param {object} data - Data to send with the event
 */
export const notifyAllClients = (eventType = 'update', data = {}) => {
  console.log(`Notifying ${sseClients.size} clients of ${eventType}`);
  sseClients.forEach(client => {
    try {
      client.write(`event: ${eventType}\n`);
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      console.error('Error notifying client, removing from set:', error);
      sseClients.delete(client);
    }
  });
};

/**
 * Helper function to clear all novel-related caches
 * This ensures that after a novel, chapter, or module is updated,
 * users will get fresh data on their next request
 */
export const clearNovelCaches = () => {
  console.log('Clearing novel caches...');
  // Get all cache keys
  const keys = cache.keys();
  
  // Clear any keys related to novels
  let clearedCount = 0;
  keys.forEach(key => {
    if (key.includes('novels_') || key === 'hot_novels') {
      cache.del(key);
      clearedCount++;
    }
  });
  
  console.log(`Cleared ${clearedCount} cache entries`);
  
  // Notify all connected clients about the update
  notifyAllClients('update', { timestamp: new Date().toISOString() });
}; 