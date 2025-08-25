import User from '../models/User.js';
import { getCachedUserById, getCachedUserByUsername, setCachedUser, globalUserQueryDedup, getCachedUser } from './userCache.js';

// Batch lookup cache to prevent duplicate requests
const batchLookupCache = new Map();
const BATCH_LOOKUP_TTL = 1000 * 60 * 2; // 2 minutes
const MAX_BATCH_CACHE_SIZE = 100;

// Query deduplication for batch requests
const pendingBatchQueries = new Map();

/**
 * Batch user lookup with caching support
 * Handles mixed ObjectIds, userNumbers, and usernames
 * Uses individual user cache for each user
 */
export const batchGetUsers = async (identifiers, options = {}) => {
  try {
    if (!Array.isArray(identifiers) || identifiers.length === 0) {
      return {};
    }

    // Limit batch size to prevent abuse
    if (identifiers.length > 100) {
      console.warn(`Batch user lookup requested ${identifiers.length} users, limiting to 100`);
      identifiers = identifiers.slice(0, 100);
    }

    // Create cache key for the entire batch
    const sortedIdentifiers = [...identifiers].sort();
    const batchCacheKey = `batch_${sortedIdentifiers.join('_')}`;
    
    // Check batch cache first
    const cached = batchLookupCache.get(batchCacheKey);
    if (cached && Date.now() - cached.timestamp < BATCH_LOOKUP_TTL) {
      return cached.data;
    }

    // Use query deduplication to prevent multiple identical batch requests
    if (pendingBatchQueries.has(batchCacheKey)) {
      return await pendingBatchQueries.get(batchCacheKey);
    }

    const batchQueryPromise = performBatchLookup(identifiers, options);
    pendingBatchQueries.set(batchCacheKey, batchQueryPromise);

    try {
      const result = await batchQueryPromise;
      
      // Cache the batch result
      if (batchLookupCache.size >= MAX_BATCH_CACHE_SIZE) {
        const oldestKey = batchLookupCache.keys().next().value;
        batchLookupCache.delete(oldestKey);
      }
      
      batchLookupCache.set(batchCacheKey, {
        data: result,
        timestamp: Date.now()
      });

      return result;
    } finally {
      pendingBatchQueries.delete(batchCacheKey);
    }
  } catch (error) {
    console.error('Error in batch user lookup:', error);
    return {};
  }
};

/**
 * Performs the actual batch lookup with global deduplication support
 */
const performBatchLookup = async (identifiers, options = {}) => {
  const userMap = {};
  const uncachedObjectIds = [];
  const uncachedUsernames = [];
  const uncachedUserNumbers = [];

  // First pass: Check individual caches and use global deduplication for userNumbers
  const cacheCheckResults = await Promise.all(identifiers.map(async (identifier) => {
    if (!identifier) return { identifier, type: 'invalid' };

    try {
      // Check if it's an ObjectId - check cache directly without triggering new queries
      if (isValidObjectId(identifier)) {
        const cached = getCachedUser(`id:${identifier}`);
        if (cached) {
          if (process.env.NODE_ENV === 'development') {
          }
          return { identifier, type: 'objectId', cached, found: true };
        } else {
          if (process.env.NODE_ENV === 'development') {
          }
          return { identifier, type: 'objectId', found: false };
        }
      }
      // Check if it's a username - check cache directly without triggering new queries
      else if (typeof identifier === 'string' && isNaN(parseInt(identifier))) {
        const cached = getCachedUser(`username:${identifier}`);
        if (cached) {
          return { identifier, type: 'username', cached, found: true };
        } else {
          return { identifier, type: 'username', found: false };
        }
      }
      // Check if it's a userNumber - check cache directly without triggering new queries
      else if (!isNaN(parseInt(identifier))) {
        const userNumber = parseInt(identifier);
        
        // Try to get from individual cache by userNumber first
        const cacheKey = `userNumber:${userNumber}`;
        const cached = getCachedUser(cacheKey);
        if (cached) {
          if (process.env.NODE_ENV === 'development') {
          }
          return { identifier, type: 'userNumber', cached, found: true };
        } else {
          if (process.env.NODE_ENV === 'development') {
          }
          return { identifier, type: 'userNumber', found: false };
        }
      }
      
      return { identifier, type: 'invalid' };
    } catch (error) {
      console.warn(`Error checking cache for identifier ${identifier}:`, error);
      // On error, treat as uncached
      if (isValidObjectId(identifier)) {
        return { identifier, type: 'objectId', found: false };
      } else if (typeof identifier === 'string' && isNaN(parseInt(identifier))) {
        return { identifier, type: 'username', found: false };
      } else if (!isNaN(parseInt(identifier))) {
        return { identifier, type: 'userNumber', found: false };
      }
      return { identifier, type: 'invalid' };
    }
  }));
  
  // Process results and build uncached lists
  for (const result of cacheCheckResults) {
    if (result.type === 'invalid') continue;
    
    if (result.found && result.cached) {
      // Add cached user to result map
      if (result.type === 'objectId') {
        userMap[result.identifier.toString()] = result.cached;
      } else {
        userMap[result.identifier] = result.cached;
      }
    } else {
      // Add to appropriate uncached list
      if (result.type === 'objectId') {
        uncachedObjectIds.push(result.identifier);
      } else if (result.type === 'username') {
        uncachedUsernames.push(result.identifier);
      } else if (result.type === 'userNumber') {
        uncachedUserNumbers.push(parseInt(result.identifier));
      }
    }
  }

  // Second pass: Batch query for uncached users
  const queryConditions = [];
  
  if (uncachedObjectIds.length > 0) {
    queryConditions.push({ _id: { $in: uncachedObjectIds } });
  }
  
  if (uncachedUsernames.length > 0) {
    queryConditions.push({ username: { $in: uncachedUsernames } });
  }
  
  if (uncachedUserNumbers.length > 0) {
    queryConditions.push({ userNumber: { $in: uncachedUserNumbers } });
  }

  // Only query if there are uncached users
  if (queryConditions.length > 0) {
    const projection = options.projection || { 
      displayName: 1, 
      username: 1, 
      userNumber: 1, 
      avatar: 1, 
      role: 1, 
      _id: 1 
    };

    // Deduplicate ObjectIds in the query conditions to avoid duplicate IDs in database queries
    if (queryConditions.length === 1 && queryConditions[0]._id && queryConditions[0]._id.$in) {
      queryConditions[0]._id.$in = [...new Set(queryConditions[0]._id.$in.map(id => id.toString()))];
    }

    // Log batch query for debugging duplicate issues
    if (process.env.NODE_ENV === 'development') {
    }

    const users = await User.find(
      queryConditions.length === 1 ? queryConditions[0] : { $or: queryConditions },
      projection
    ).lean();

    // Cache each user individually and add to result map
    for (const user of users) {
      // Cache by ObjectId
      setCachedUser(`id:${user._id}`, user);
      
      // Cache by username
      if (user.username) {
        setCachedUser(`username:${user.username}`, user);
      }

      if (process.env.NODE_ENV === 'development') {
      }

      // Add to result map using all possible identifiers
      userMap[user._id.toString()] = user;
      if (user.username) {
        userMap[user.username] = user;
      }
      if (user.userNumber) {
        userMap[user.userNumber.toString()] = user;
        userMap[user.userNumber] = user; // Also as number
      }
    }
  } else {  }

  return userMap;
};

/**
 * Helper function to check if a value is a valid MongoDB ObjectId
 */
const isValidObjectId = (id) => {
  if (typeof id === 'object' && id !== null && id._bsontype === 'ObjectId') {
    return true;
  }
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
};

/**
 * Clear batch user cache (call when user data changes)
 */
export const clearBatchUserCache = () => {
  batchLookupCache.clear();
  pendingBatchQueries.clear();
};
