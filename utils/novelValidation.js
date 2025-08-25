import Novel from '../models/Novel.js';

// Cache for novel existence validation
const novelExistsCache = new Map();
const NOVEL_EXISTS_CACHE_TTL = 1000 * 60 * 10; // 10 minutes
const MAX_NOVEL_EXISTS_CACHE_SIZE = 1000;

// Query deduplication for novel existence checks
const pendingNovelQueries = new Map();

/**
 * Optimized novel existence check with caching and query deduplication
 * @param {string} novelId - The novel ID to check
 * @param {Object} options - Additional options for the query
 * @returns {Promise<Object|null>} The novel object or null if not found
 */
export const validateNovelExists = async (novelId, options = {}) => {
  if (!novelId) {
    return null;
  }

  const cacheKey = `novel_exists_${novelId}`;
  
  // Check cache first
  const cached = novelExistsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < NOVEL_EXISTS_CACHE_TTL) {
    return cached.data;
  }

  // Use query deduplication to prevent multiple identical requests
  if (pendingNovelQueries.has(cacheKey)) {
    return await pendingNovelQueries.get(cacheKey);
  }

  // Start new query
  const queryPromise = performNovelValidation(novelId, options);
  pendingNovelQueries.set(cacheKey, queryPromise);

  try {
    const result = await queryPromise;
    
    // Cache the result
    if (novelExistsCache.size >= MAX_NOVEL_EXISTS_CACHE_SIZE) {
      const oldestKey = novelExistsCache.keys().next().value;
      novelExistsCache.delete(oldestKey);
    }
    
    novelExistsCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    return result;
  } finally {
    // Clean up pending query
    pendingNovelQueries.delete(cacheKey);
  }
};

/**
 * Performs the actual novel validation query
 */
const performNovelValidation = async (novelId, options = {}) => {
  try {
    // Default projection for novel existence validation
    const projection = options.projection || { 
      _id: 1, 
      title: 1, 
      active: 1, 
      inactive: 1 
    };

    const novel = await Novel.findById(novelId, projection).lean();
    return novel;
  } catch (error) {
    console.error('Error validating novel existence:', error);
    return null;
  }
};

/**
 * Batch validate multiple novels
 * @param {string[]} novelIds - Array of novel IDs to validate
 * @param {Object} options - Additional options for the query
 * @returns {Promise<Object>} Map of novelId -> novel object (or null if not found)
 */
export const batchValidateNovels = async (novelIds, options = {}) => {
  if (!Array.isArray(novelIds) || novelIds.length === 0) {
    return {};
  }

  // Limit batch size
  if (novelIds.length > 50) {
    console.warn(`Batch novel validation requested ${novelIds.length} novels, limiting to 50`);
    novelIds = novelIds.slice(0, 50);
  }

  const results = {};
  const uncachedIds = [];

  // First pass: Check cache
  for (const novelId of novelIds) {
    if (!novelId) continue;
    
    const cacheKey = `novel_exists_${novelId}`;
    const cached = novelExistsCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < NOVEL_EXISTS_CACHE_TTL) {
      results[novelId] = cached.data;
    } else {
      uncachedIds.push(novelId);
    }
  }

  // Second pass: Batch query uncached novels
  if (uncachedIds.length > 0) {
    try {
      const projection = options.projection || { 
        _id: 1, 
        title: 1, 
        active: 1, 
        inactive: 1 
      };

      const novels = await Novel.find(
        { _id: { $in: uncachedIds } },
        projection
      ).lean();

      // Cache results and add to response
      for (const novel of novels) {
        const novelId = novel._id.toString();
        results[novelId] = novel;
        
        // Cache individual result
        const cacheKey = `novel_exists_${novelId}`;
        if (novelExistsCache.size >= MAX_NOVEL_EXISTS_CACHE_SIZE) {
          const oldestKey = novelExistsCache.keys().next().value;
          novelExistsCache.delete(oldestKey);
        }
        
        novelExistsCache.set(cacheKey, {
          data: novel,
          timestamp: Date.now()
        });
      }

      // Add null for novels that don't exist
      for (const novelId of uncachedIds) {
        if (!results[novelId]) {
          results[novelId] = null;
          
          // Cache null result (shorter TTL)
          const cacheKey = `novel_exists_${novelId}`;
          novelExistsCache.set(cacheKey, {
            data: null,
            timestamp: Date.now()
          });
        }
      }
    } catch (error) {
      console.error('Error in batch novel validation:', error);
      // Add null for all uncached novels on error
      for (const novelId of uncachedIds) {
        if (!results[novelId]) {
          results[novelId] = null;
        }
      }
    }
  }

  return results;
};

/**
 * Clear novel existence cache
 * @param {string} novelId - Specific novel ID to clear, or null to clear all
 */
export const clearNovelExistsCache = (novelId = null) => {
  if (novelId) {
    novelExistsCache.delete(`novel_exists_${novelId}`);
    pendingNovelQueries.delete(`novel_exists_${novelId}`);
  } else {
    novelExistsCache.clear();
    pendingNovelQueries.clear();
  }
};

/**
 * Express middleware to validate novel existence
 * Usage: router.get('/route/:novelId', validateNovelMiddleware, handlerFunction)
 */
export const validateNovelMiddleware = async (req, res, next) => {
  try {
    const novelId = req.params.novelId || req.params.id;
    
    if (!novelId) {
      return res.status(400).json({ message: 'Novel ID is required' });
    }

    const novel = await validateNovelExists(novelId);
    
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    // Attach novel to request object for use in route handlers
    req.validatedNovel = novel;
    next();
  } catch (error) {
    console.error('Error in novel validation middleware:', error);
    res.status(500).json({ message: 'Error validating novel' });
  }
};
