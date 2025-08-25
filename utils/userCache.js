import User from '../models/User.js';

// Global user cache with enhanced caching for frequently accessed users
const globalUserCache = new Map();
const USER_CACHE_TTL = 1000 * 60 * 5; // 5 minutes
const ADMIN_CACHE_TTL = 1000 * 60 * 10; // 10 minutes for admin user
const MAX_USER_CACHE_SIZE = 500;

// Query deduplication cache to prevent multiple identical requests
const pendingUserQueries = new Map();

// Global user identifier resolution cache (userNumber -> ObjectId)
const userIdResolutionCache = new Map();
const USER_ID_RESOLUTION_CACHE_TTL = 1000 * 60 * 30; // 30 minutes (longer TTL since userNumbers rarely change)

// Global user query deduplication by actual user ObjectId (works across individual and batch queries)
const globalUserQueryDeduplication = new Map();

// Helper function to get cache TTL based on user type
const getCacheTTL = (username, role) => {
  if (username === 'admin' || role === 'admin') {
    return ADMIN_CACHE_TTL;
  }
  return USER_CACHE_TTL;
};

// Enhanced user cache management
export const getCachedUser = (key) => {
  const cached = globalUserCache.get(key);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.data;
  }
  return null;
};

export const setCachedUser = (key, data, customTTL = null) => {
  // Remove oldest entries if cache is too large
  if (globalUserCache.size >= MAX_USER_CACHE_SIZE) {
    const oldestKey = globalUserCache.keys().next().value;
    globalUserCache.delete(oldestKey);
  }
  
  const ttl = customTTL || getCacheTTL(data.username, data.role);
  
  globalUserCache.set(key, {
    data,
    timestamp: Date.now(),
    ttl
  });
  
  // Also cache by all identifiers to prevent duplicate queries
  if (data._id && key !== `id:${data._id}`) {
    globalUserCache.set(`id:${data._id}`, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }
  
  if (data.username && key !== `username:${data.username}`) {
    globalUserCache.set(`username:${data.username}`, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }
  
  if (data.userNumber && key !== `userNumber:${data.userNumber}`) {
    globalUserCache.set(`userNumber:${data.userNumber}`, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }
};

// Helper to resolve any user identifier to ObjectId
const resolveUserIdentifierToObjectId = async (identifier) => {
  // If it's already an ObjectId, return it
  if (typeof identifier === 'object' && identifier !== null && identifier._bsontype === 'ObjectId') {
    return identifier.toString();
  }
  if (typeof identifier === 'string' && /^[0-9a-fA-F]{24}$/.test(identifier)) {
    return identifier;
  }
  
  // If it's a userNumber, check resolution cache first
  if (!isNaN(parseInt(identifier))) {
    const userNumber = parseInt(identifier);
    const cached = userIdResolutionCache.get(userNumber);
    if (cached && Date.now() - cached.timestamp < USER_ID_RESOLUTION_CACHE_TTL) {
      return cached.objectId;
    }
    
    // Query database to resolve userNumber to ObjectId
    const user = await User.findOne({ userNumber }, '_id').lean();
    if (user) {
      const objectId = user._id.toString();
      userIdResolutionCache.set(userNumber, {
        objectId,
        timestamp: Date.now()
      });
      return objectId;
    }
  }
  
  // If it's a username, try to resolve via cache or database
  if (typeof identifier === 'string' && isNaN(parseInt(identifier))) {
    const user = await User.findOne({ username: identifier }, '_id').lean();
    if (user) {
      return user._id.toString();
    }
  }
  
  return null;
};

// Global user query deduplication by actual ObjectId (works across all query types)
const globalUserQueryDedup = async (identifier, queryFn) => {
  try {
    // Resolve identifier to canonical ObjectId for deduplication
    const objectId = await resolveUserIdentifierToObjectId(identifier);
    if (!objectId) {
      // If we can't resolve the identifier, just run the query
      return await queryFn();
    }
    
    const globalKey = `global_user_${objectId}`;
    
    // If query is already pending globally, wait for it
    if (globalUserQueryDeduplication.has(globalKey)) {
      if (process.env.NODE_ENV === 'development') {
      }
      return await globalUserQueryDeduplication.get(globalKey);
    }
    
    // Start new global query
    const queryPromise = queryFn();
    globalUserQueryDeduplication.set(globalKey, queryPromise);
    
    if (process.env.NODE_ENV === 'development') {
    }
    
    try {
      const result = await queryPromise;
      return result;
    } finally {
      // Clean up pending query
      globalUserQueryDeduplication.delete(globalKey);
    }
  } catch (error) {
    console.warn(`Error in global user query deduplication:`, error);
    // Fallback to regular query
    return await queryFn();
  }
};

// Query deduplication helper for user lookups
const dedupUserQuery = async (key, queryFn) => {
  // If query is already pending, wait for it
  if (pendingUserQueries.has(key)) {
    return await pendingUserQueries.get(key);
  }
  
  // Start new query
  const queryPromise = queryFn();
  pendingUserQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    // Clean up pending query
    pendingUserQueries.delete(key);
  }
};

// Enhanced user lookup function with caching and global deduplication
export const getCachedUserById = async (userId) => {
  const cacheKey = `id:${userId}`;
  
  // Check cache first
  const cached = getCachedUser(cacheKey);
  if (cached) {
    if (process.env.NODE_ENV === 'development') {
    }
    return cached;
  }
  
  if (process.env.NODE_ENV === 'development') {
    // Log what keys are in cache for debugging
    const cacheKeys = Array.from(globalUserCache.keys()).slice(0, 5); // Show first 5 keys
  }
  
  // Use global deduplication to prevent multiple identical requests across all systems
  return await globalUserQueryDedup(userId, async () => {
    // Log individual query for debugging duplicate issues
    if (process.env.NODE_ENV === 'development') {
    }
    
    const user = await User.findById(userId).select('-password').lean();
    if (user) {
      // Cache by both ID and username
      setCachedUser(cacheKey, user);
      setCachedUser(`username:${user.username}`, user);
      
      // Also cache in userNumber resolution cache
      if (user.userNumber) {
        userIdResolutionCache.set(user.userNumber, {
          objectId: user._id.toString(),
          timestamp: Date.now()
        });
      }
      
      if (process.env.NODE_ENV === 'development') {
      }
    }
    return user;
  });
};

// Enhanced user lookup by username with caching and global deduplication
export const getCachedUserByUsername = async (username) => {
  const cacheKey = `username:${username}`;
  
  // Check cache first
  const cached = getCachedUser(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Use global deduplication to prevent multiple identical requests across all systems
  return await globalUserQueryDedup(username, async () => {
    // Log individual query for debugging duplicate issues
    if (process.env.NODE_ENV === 'development') {
    }
    
    const user = await User.findOne({ username }).select('-password').lean();
    if (user) {
      // Cache by both username and ID
      setCachedUser(cacheKey, user);
      setCachedUser(`id:${user._id}`, user);
      
      // Also cache in userNumber resolution cache
      if (user.userNumber) {
        userIdResolutionCache.set(user.userNumber, {
          objectId: user._id.toString(),
          timestamp: Date.now()
        });
      }
    }
    return user;
  });
};

// Export global user query deduplication for use by batch system
export { globalUserQueryDedup };

// Clear user cache (call this when user data changes)
export const clearUserCache = (userId = null, username = null, userNumber = null) => {
  if (userId) {
    globalUserCache.delete(`id:${userId}`);
    // Also clear global deduplication for this user
    globalUserQueryDeduplication.delete(`global_user_${userId}`);
  }
  if (username) {
    globalUserCache.delete(`username:${username}`);
  }
  if (userNumber) {
    globalUserCache.delete(`userNumber:${userNumber}`);
  }
  if (!userId && !username && !userNumber) {
    // Clear all user cache
    globalUserCache.clear();
    userIdResolutionCache.clear();
    globalUserQueryDeduplication.clear();
  }
};

// Comprehensive cache clearing for user data changes
export const clearAllUserCaches = (user) => {
  if (!user) return;
  
  // Clear individual user cache
  clearUserCache(user._id, user.username, user.userNumber);
  
  // Clear batch user cache
  import('./batchUserCache.js').then(({ clearBatchUserCache }) => {
    clearBatchUserCache();
  }).catch(err => {
    console.error('Failed to clear batch user cache:', err);
  });
  
  // Clear user stats cache if available
  try {
    import('../routes/users.js').then(({ clearUserStatsCache, clearUserResolutionCache }) => {
      if (clearUserStatsCache) {
        clearUserStatsCache(user._id?.toString());
        if (user.userNumber) {
          clearUserStatsCache(`complete_profile_${user.userNumber}`);
        }
      }
      if (clearUserResolutionCache) {
        clearUserResolutionCache(user._id);
      }
    }).catch(err => {
      console.error('Failed to clear user stats cache:', err);
    });
  } catch (error) {
    // Ignore if not available
  }
  
};

// Pre-warm admin user cache at startup
export const preWarmAdminCache = async () => {
  try {
    console.log('Pre-warming admin user cache...');
    await getCachedUserByUsername('admin');
    console.log('Admin user cache pre-warmed successfully');
  } catch (error) {
    console.warn('Failed to pre-warm admin cache:', error.message);
  }
}; 