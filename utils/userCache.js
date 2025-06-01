import User from '../models/User.js';

// Global user cache with enhanced caching for frequently accessed users
const globalUserCache = new Map();
const USER_CACHE_TTL = 1000 * 60 * 5; // 5 minutes
const ADMIN_CACHE_TTL = 1000 * 60 * 10; // 10 minutes for admin user
const MAX_USER_CACHE_SIZE = 500;

// Query deduplication cache to prevent multiple identical requests
const pendingUserQueries = new Map();

// Helper function to get cache TTL based on user type
const getCacheTTL = (username, role) => {
  if (username === 'admin' || role === 'admin') {
    return ADMIN_CACHE_TTL;
  }
  return USER_CACHE_TTL;
};

// Enhanced user cache management
const getCachedUser = (key) => {
  const cached = globalUserCache.get(key);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.data;
  }
  return null;
};

const setCachedUser = (key, data, customTTL = null) => {
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

// Enhanced user lookup function with caching and deduplication
export const getCachedUserById = async (userId) => {
  const cacheKey = `id:${userId}`;
  
  // Check cache first
  const cached = getCachedUser(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Use deduplication to prevent multiple identical requests
  return await dedupUserQuery(cacheKey, async () => {
    const user = await User.findById(userId).select('-password').lean();
    if (user) {
      // Cache by both ID and username
      setCachedUser(cacheKey, user);
      setCachedUser(`username:${user.username}`, user);
    }
    return user;
  });
};

// Enhanced user lookup by username with caching
export const getCachedUserByUsername = async (username) => {
  const cacheKey = `username:${username}`;
  
  // Check cache first
  const cached = getCachedUser(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Use deduplication to prevent multiple identical requests
  return await dedupUserQuery(cacheKey, async () => {
    const user = await User.findOne({ username }).select('-password').lean();
    if (user) {
      // Cache by both username and ID
      setCachedUser(cacheKey, user);
      setCachedUser(`id:${user._id}`, user);
    }
    return user;
  });
};

// Clear user cache (call this when user data changes)
export const clearUserCache = (userId = null, username = null) => {
  if (userId) {
    globalUserCache.delete(`id:${userId}`);
  }
  if (username) {
    globalUserCache.delete(`username:${username}`);
  }
  if (!userId && !username) {
    // Clear all user cache
    globalUserCache.clear();
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