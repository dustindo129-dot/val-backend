import User from '../models/User.js';

/**
 * Simple DataLoader-like utility for batching user queries
 * This helps reduce the number of individual user lookups by batching them
 */
class UserBatcher {
  constructor() {
    this.batchSize = 50; // Maximum batch size
    this.batchDelay = 10; // 10ms delay to collect requests
    this.pendingRequests = new Map(); // userId -> array of resolve functions
    this.batchTimeout = null;
  }

  /**
   * Load a single user by ID
   * @param {string} userId - User ID to load
   * @param {Object} projection - MongoDB projection object
   * @returns {Promise<Object>} User object
   */
  async loadUser(userId, projection = { username: 1, displayName: 1, avatar: 1 }) {
    if (!userId) return null;

    return new Promise((resolve, reject) => {
      const key = `${userId}_${JSON.stringify(projection)}`;
      
      if (!this.pendingRequests.has(key)) {
        this.pendingRequests.set(key, []);
      }
      
      this.pendingRequests.get(key).push({ resolve, reject, userId, projection });
      
      // Schedule batch processing if not already scheduled
      if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => {
          this.processBatch();
        }, this.batchDelay);
      }
    });
  }

  /**
   * Load multiple users by IDs
   * @param {Array<string>} userIds - Array of user IDs
   * @param {Object} projection - MongoDB projection object
   * @returns {Promise<Array<Object>>} Array of user objects
   */
  async loadUsers(userIds, projection = { username: 1, displayName: 1, avatar: 1 }) {
    if (!userIds || userIds.length === 0) return [];
    
    const uniqueIds = [...new Set(userIds.filter(id => id))];
    const userPromises = uniqueIds.map(id => this.loadUser(id, projection));
    const users = await Promise.all(userPromises);
    
    // Create a map for quick lookup
    const userMap = {};
    users.forEach(user => {
      if (user) {
        userMap[user._id.toString()] = user;
      }
    });
    
    // Return users in the original order, with nulls for missing users
    return userIds.map(id => userMap[id] || null);
  }

  /**
   * Process all pending requests in batches
   */
  async processBatch() {
    this.batchTimeout = null;
    
    if (this.pendingRequests.size === 0) return;
    
    // Group requests by projection
    const projectionGroups = new Map();
    
    for (const [key, requests] of this.pendingRequests.entries()) {
      const firstRequest = requests[0];
      const projectionKey = JSON.stringify(firstRequest.projection);
      
      if (!projectionGroups.has(projectionKey)) {
        projectionGroups.set(projectionKey, {
          projection: firstRequest.projection,
          requests: []
        });
      }
      
      projectionGroups.get(projectionKey).requests.push(...requests);
    }
    
    // Clear pending requests
    this.pendingRequests.clear();
    
    // Process each projection group
    for (const { projection, requests } of projectionGroups.values()) {
      try {
        // Extract unique user IDs
        const userIds = [...new Set(requests.map(req => req.userId))];
        
        // Batch fetch users
        const users = await User.find(
          { _id: { $in: userIds } },
          projection
        ).lean();
        
        // Create user lookup map
        const userMap = {};
        users.forEach(user => {
          userMap[user._id.toString()] = user;
        });
        
        // Resolve all requests
        requests.forEach(({ resolve, userId }) => {
          resolve(userMap[userId] || null);
        });
        
      } catch (error) {
        // Reject all requests in this group
        requests.forEach(({ reject }) => {
          reject(error);
        });
      }
    }
  }

  /**
   * Clear any pending batches (useful for testing or cleanup)
   */
  clear() {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    
    // Reject all pending requests
    for (const requests of this.pendingRequests.values()) {
      requests.forEach(({ reject }) => {
        reject(new Error('UserBatcher cleared'));
      });
    }
    
    this.pendingRequests.clear();
  }
}

// Create a singleton instance
const userBatcher = new UserBatcher();

export default userBatcher;
