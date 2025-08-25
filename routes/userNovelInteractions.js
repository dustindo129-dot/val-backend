import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import Novel from '../models/Novel.js';
import { validateNovelExists } from '../utils/novelValidation.js';

const router = express.Router();

// Simple in-memory cache for user interaction stats
const userStatsCache = new Map();
const USER_STATS_CACHE_TTL = 1000 * 60 * 5; // 5 minutes
const MAX_USER_STATS_CACHE_SIZE = 100;

// Enhanced caching for novel stats to prevent duplicate aggregations
const novelStatsCache = new Map();
const NOVEL_STATS_CACHE_TTL = 1000 * 60 * 10; // 10 minutes - longer since stats don't change frequently
const MAX_NOVEL_STATS_CACHE_SIZE = 500;

// Query deduplication cache for user interactions
const pendingUserQueries = new Map();

// Cache for user interactions to avoid repeated lookups
const userInteractionCache = new Map();
const USER_INTERACTION_CACHE_TTL = 1000 * 60 * 3; // 3 minutes - balance between freshness and performance
const MAX_USER_INTERACTION_CACHE_SIZE = 200;

// Cache for novel reviews to avoid repeated queries
const reviewsCache = new Map();
const REVIEWS_CACHE_TTL = 1000 * 60 * 5; // 5 minutes - reviews don't change very frequently
const MAX_REVIEWS_CACHE_SIZE = 100;

// Helper function to manage user stats cache
const getCachedUserStats = (userId) => {
  const cached = userStatsCache.get(userId);
  if (cached && Date.now() - cached.timestamp < USER_STATS_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedUserStats = (userId, data) => {
  if (userStatsCache.size >= MAX_USER_STATS_CACHE_SIZE) {
    const oldestKey = userStatsCache.keys().next().value;
    userStatsCache.delete(oldestKey);
  }
  
  userStatsCache.set(userId, {
    data,
    timestamp: Date.now()
  });
};

// Novel stats cache helpers
const getCachedNovelStats = (novelId) => {
  const cached = novelStatsCache.get(novelId);
  if (cached && Date.now() - cached.timestamp < NOVEL_STATS_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedNovelStats = (novelId, data) => {
  if (novelStatsCache.size >= MAX_NOVEL_STATS_CACHE_SIZE) {
    const oldestKey = novelStatsCache.keys().next().value;
    novelStatsCache.delete(oldestKey);
  }
  
  novelStatsCache.set(novelId, {
    data,
    timestamp: Date.now()
  });
};

// Query deduplication helper for user interactions
const dedupUserQuery = async (key, queryFn) => {
  if (pendingUserQueries.has(key)) {
    return await pendingUserQueries.get(key);
  }
  
  const queryPromise = queryFn();
  pendingUserQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    pendingUserQueries.delete(key);
  }
};

// Clear user stats cache
const clearUserStatsCache = (userId = null) => {
  if (userId) {
    userStatsCache.delete(userId);
  } else {
    userStatsCache.clear();
  }
};

// Clear novel stats cache
const clearNovelStatsCache = (novelId = null) => {
  if (novelId) {
    novelStatsCache.delete(novelId);
  } else {
    novelStatsCache.clear();
  }
};

// User interaction cache helpers
const getCachedUserInteraction = (userId, novelId) => {
  const cacheKey = `user_${userId}_novel_${novelId}`;
  const cached = userInteractionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < USER_INTERACTION_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedUserInteraction = (userId, novelId, data) => {
  if (userInteractionCache.size >= MAX_USER_INTERACTION_CACHE_SIZE) {
    const oldestKey = userInteractionCache.keys().next().value;
    userInteractionCache.delete(oldestKey);
  }
  
  const cacheKey = `user_${userId}_novel_${novelId}`;
  userInteractionCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
};

const clearUserInteractionCache = (userId = null, novelId = null) => {
  if (userId && novelId) {
    const cacheKey = `user_${userId}_novel_${novelId}`;
    userInteractionCache.delete(cacheKey);
  } else if (novelId) {
    // Clear all user interactions for a specific novel
    for (const key of userInteractionCache.keys()) {
      if (key.includes(`novel_${novelId}`)) {
        userInteractionCache.delete(key);
      }
    }
  } else {
    userInteractionCache.clear();
  }
};

// Reviews cache helpers
const getCachedReviews = (novelId, page, limit, userId) => {
  const cacheKey = `reviews_${novelId}_${page}_${limit}_${userId || 'anonymous'}`;
  const cached = reviewsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < REVIEWS_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedReviews = (novelId, page, limit, userId, data) => {
  if (reviewsCache.size >= MAX_REVIEWS_CACHE_SIZE) {
    const oldestKey = reviewsCache.keys().next().value;
    reviewsCache.delete(oldestKey);
  }
  
  const cacheKey = `reviews_${novelId}_${page}_${limit}_${userId || 'anonymous'}`;
  reviewsCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
};

const clearReviewsCache = (novelId = null) => {
  if (novelId) {
    // Clear all reviews for a specific novel
    for (const key of reviewsCache.keys()) {
      if (key.includes(`reviews_${novelId}`)) {
        reviewsCache.delete(key);
      }
    }
  } else {
    reviewsCache.clear();
  }
};

/**
 * Get novel interaction statistics
 * @route GET /api/usernovelinteractions/stats/:novelId
 */
router.get('/stats/:novelId', async (req, res) => {
  try {
    const novelId = req.params.novelId;
    
    // First check cache
    const cachedStats = getCachedNovelStats(novelId);
    if (cachedStats) {
      return res.json(cachedStats);
    }
       
    // Use query deduplication to prevent multiple identical requests
    const cacheKey = `novel_stats_${novelId}`;
    
    const stats = await dedupUserQuery(cacheKey, async () => {
      // Aggregate interactions data with optimized pipeline
      const [result] = await UserNovelInteraction.aggregate([
        {
          $match: { novelId: new mongoose.Types.ObjectId(novelId) }
        },
        {
          $group: {
            _id: null,
            totalLikes: {
              $sum: { $cond: [{ $eq: ['$liked', true] }, 1, 0] }
            },
            totalRatings: {
              $sum: { $cond: [{ $ne: ['$rating', null] }, 1, 0] }
            },
            totalBookmarks: {
              $sum: { $cond: [{ $eq: ['$bookmarked', true] }, 1, 0] }
            },
            ratingSum: {
              $sum: { $ifNull: ['$rating', 0] }
            }
          }
        }
      ]);

      // If no interactions exist yet, return default values
      if (!result) {
        return {
          totalLikes: 0,
          totalRatings: 0,
          totalBookmarks: 0,
          averageRating: '0.0'
        };
      }

      const averageRating = result.totalRatings > 0 
        ? (result.ratingSum / result.totalRatings).toFixed(1) 
        : '0.0';

      const statsData = {
        totalLikes: result.totalLikes,
        totalRatings: result.totalRatings,
        totalBookmarks: result.totalBookmarks,
        averageRating
      };

      // Cache the results
      setCachedNovelStats(novelId, statsData);
      
      return statsData;
    });

    res.json(stats);
  } catch (err) {
    console.error('Error getting novel interactions:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get user's interaction with a novel
 * @route GET /api/usernovelinteractions/user/:novelId
 */
router.get('/user/:novelId', auth, async (req, res) => {
  try {
    const novelId = req.params.novelId;
    const userId = req.user._id;

    // First check cache
    const cachedInteraction = getCachedUserInteraction(userId, novelId);
    if (cachedInteraction) {
      return res.json(cachedInteraction);
    }
    
    // Use query deduplication to prevent multiple identical requests
    const cacheKey = `user_interaction_${userId}_${novelId}`;
    
    const interaction = await dedupUserQuery(cacheKey, async () => {
      // Get user's interaction
      const result = await UserNovelInteraction.findOne({ userId, novelId });
      
      const interactionData = !result ? {
        liked: false,
        rating: null,
        review: null,
        bookmarked: false,
        followed: false
      } : {
        liked: result.liked || false,
        rating: result.rating || null,
        review: result.review || null,
        bookmarked: result.bookmarked || false,
        followed: result.followed || false
      };
      
      return interactionData;
    });

    // Cache the result for future requests
    setCachedUserInteraction(userId, novelId, interaction);
    
    res.json(interaction);
  } catch (err) {
    console.error("Error getting user interaction:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Toggle like status for a novel
 * @route POST /api/usernovelinteractions/like
 */
router.post('/like', auth, async (req, res) => {
  try {
    const { novelId } = req.body;
    const userId = req.user._id;

    if (!novelId) {
      return res.status(400).json({ message: 'Novel ID is required' });
    }

    // Check if novel exists using optimized validation
    const novel = await validateNovelExists(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find or create interaction
    let interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      // Create new interaction with liked=true
      interaction = new UserNovelInteraction({
        userId,
        novelId,
        liked: true
      });
    } else {
      // Toggle existing interaction
      interaction.liked = !interaction.liked;
    }
    await interaction.save();

    // Clear caches for this user and novel
    clearUserStatsCache(userId);
    clearNovelStatsCache(novelId); // Clear novel stats cache
    clearUserInteractionCache(userId, novelId); // Clear user interaction cache
    clearReviewsCache(novelId); // Clear reviews cache since a rating/review was added/updated
    pendingUserQueries.delete(`novel_stats_${novelId}`);
    pendingUserQueries.delete(`user_interaction_${userId}_${novelId}`);
    
    // Clear user stats cache from users route
    try {
      const { clearUserStatsCache: clearStats } = await import('./users.js');
      if (clearStats) {
        clearStats(userId.toString());
      }
    } catch (error) {
      console.warn('Could not clear user stats cache:', error.message);
    }

    // Get total likes count
    const [stats] = await UserNovelInteraction.aggregate([
      { $match: { novelId: new mongoose.Types.ObjectId(novelId), liked: true } },
      { $group: { _id: null, totalLikes: { $sum: 1 } } }
    ]);
    
    return res.json({ 
      liked: interaction.liked,
      totalLikes: stats?.totalLikes || 0
    });
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Rate a novel
 * @route POST /api/usernovelinteractions/rate
 */
router.post('/rate', auth, async (req, res) => {
  try {
    const { novelId, rating, review } = req.body;
    const userId = req.user._id;

    if (!novelId) {
      return res.status(400).json({ message: 'Novel ID is required' });
    }

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    // Check if novel exists using optimized validation
    const novel = await validateNovelExists(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find or create interaction
    let interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      interaction = new UserNovelInteraction({
        userId,
        novelId,
        rating,
        review: review || null
      });
    } else {
      const oldRating = interaction.rating;
      const oldReview = interaction.review;
      
      interaction.rating = rating;
      // Only update review if provided
      if (review !== undefined) {
        // Check if review content has changed
        if (oldReview !== null && oldReview !== review) {
          interaction.reviewIsEdited = true;
        }
        interaction.review = review;
      }
      // updatedAt will be automatically updated by Mongoose timestamps
    }
    await interaction.save();

    // Clear caches for this user and novel
    clearUserStatsCache(userId);
    clearNovelStatsCache(novelId); // Clear novel stats cache
    clearUserInteractionCache(userId, novelId); // Clear user interaction cache
    clearReviewsCache(novelId); // Clear reviews cache since a rating/review was added/updated
    pendingUserQueries.delete(`novel_stats_${novelId}`);
    pendingUserQueries.delete(`user_interaction_${userId}_${novelId}`);
    
    // Clear user stats cache from users route
    try {
      const { clearUserStatsCache: clearStats } = await import('./users.js');
      if (clearStats) {
        clearStats(userId.toString());
      }
    } catch (error) {
      console.warn('Could not clear user stats cache:', error.message);
    }

    // Calculate new rating statistics
    const [stats] = await UserNovelInteraction.aggregate([
      { $match: { novelId: new mongoose.Types.ObjectId(novelId), rating: { $exists: true, $ne: null } } },
      { 
        $group: { 
          _id: null, 
          totalRatings: { $sum: 1 },
          ratingSum: { $sum: "$rating" }
        } 
      }
    ]);

    const totalRatings = stats?.totalRatings || 0;
    const averageRating = totalRatings > 0 
      ? (stats.ratingSum / totalRatings).toFixed(1) 
      : '0.0';

    return res.json({
      rating,
      review: interaction.review,
      totalRatings,
      averageRating
    });
  } catch (err) {
    console.error("Error rating novel:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Remove rating from a novel
 * @route DELETE /api/usernovelinteractions/rate/:novelId
 */
router.delete('/rate/:novelId', auth, async (req, res) => {
  try {
    const novelId = req.params.novelId;
    const userId = req.user._id;

    // Check if novel exists using optimized validation
    const novel = await validateNovelExists(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find interaction
    const interaction = await UserNovelInteraction.findOne({ userId, novelId });
    if (!interaction || !interaction.rating) {
      return res.status(404).json({ message: "No rating found for this novel" });
    }

    // Remove rating
    interaction.rating = null;
    await interaction.save();

    // Clear caches for this user and novel
    clearUserStatsCache(userId);
    clearNovelStatsCache(novelId); // Clear novel stats cache
    clearUserInteractionCache(userId, novelId); // Clear user interaction cache
    clearReviewsCache(novelId); // Clear reviews cache since a rating/review was added/updated
    pendingUserQueries.delete(`novel_stats_${novelId}`);
    pendingUserQueries.delete(`user_interaction_${userId}_${novelId}`);
    
    // Clear user stats cache from users route
    try {
      const { clearUserStatsCache: clearStats } = await import('./users.js');
      if (clearStats) {
        clearStats(userId.toString());
      }
    } catch (error) {
      console.warn('Could not clear user stats cache:', error.message);
    }

    // Calculate new rating statistics
    const [stats] = await UserNovelInteraction.aggregate([
      { $match: { novelId: new mongoose.Types.ObjectId(novelId), rating: { $exists: true, $ne: null } } },
      { 
        $group: { 
          _id: null, 
          totalRatings: { $sum: 1 },
          ratingSum: { $sum: "$rating" }
        } 
      }
    ]);

    const totalRatings = stats?.totalRatings || 0;
    const averageRating = totalRatings > 0 
      ? (stats.ratingSum / totalRatings).toFixed(1) 
      : '0.0';

    return res.json({
      totalRatings,
      averageRating
    });
  } catch (err) {
    console.error("Error removing rating:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Bookmark a novel
 * @route POST /api/usernovelinteractions/bookmark
 */
router.post('/bookmark', auth, async (req, res) => {
  try {
    const { novelId } = req.body;
    const userId = req.user._id;

    if (!novelId) {
      return res.status(400).json({ message: 'Novel ID is required' });
    }

    // Check if novel exists using optimized validation
    const novel = await validateNovelExists(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find or create interaction
    let interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      // Create new interaction with bookmarked=true
      interaction = new UserNovelInteraction({
        userId,
        novelId,
        bookmarked: true
      });
    } else {
      // Toggle existing interaction
      interaction.bookmarked = !interaction.bookmarked;
    }
    await interaction.save();

    // Clear caches for this user and novel
    clearUserStatsCache(userId);
    clearNovelStatsCache(novelId); // Clear novel stats cache
    clearUserInteractionCache(userId, novelId); // Clear user interaction cache
    clearReviewsCache(novelId); // Clear reviews cache since a rating/review was added/updated
    pendingUserQueries.delete(`novel_stats_${novelId}`);
    pendingUserQueries.delete(`user_interaction_${userId}_${novelId}`);
    
    // Clear user stats cache from users route
    try {
      const { clearUserStatsCache: clearStats } = await import('./users.js');
      if (clearStats) {
        clearStats(userId.toString());
      }
    } catch (error) {
      console.warn('Could not clear user stats cache:', error.message);
    }

    return res.json({ 
      bookmarked: interaction.bookmarked
    });
  } catch (err) {
    console.error("Error toggling bookmark:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get count of novels the user is following
 * @route GET /api/usernovelinteractions/following/count/:userId
 */
router.get('/following/count/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    
    const count = await UserNovelInteraction.countDocuments({ 
      userId: mongoose.Types.ObjectId.createFromHexString(userId),
      followed: true 
    });
    
    res.json({ count });
  } catch (err) {
    console.error('Error counting followed novels:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get all bookmarked novels for the user
 * @route GET /api/usernovelinteractions/bookmarks
 */
router.get('/bookmarks', auth, async (req, res) => {
  try {
    const userId = req.user._id;

    // Use aggregation pipeline to reduce database queries
    const bookmarkedNovels = await UserNovelInteraction.aggregate([
      // Match bookmarked interactions for this user
      { 
        $match: { 
          userId: userId,
          bookmarked: true 
        } 
      },
      // Lookup novel details
      {
        $lookup: {
          from: 'novels',
          localField: 'novelId',
          foreignField: '_id',
          as: 'novel',
          pipeline: [
            {
              $project: {
                title: 1,
                illustration: 1,
                status: 1,
                updatedAt: 1,
                createdAt: 1
              }
            }
          ]
        }
      },
      // Unwind the novel array
      { $unwind: '$novel' },
      // Lookup chapter count
      {
        $lookup: {
          from: 'chapters',
          localField: 'novelId',
          foreignField: 'novelId',
          as: 'chapters'
        }
      },
      // Lookup latest chapter
      {
        $lookup: {
          from: 'chapters',
          let: { novelId: '$novelId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$novelId', '$$novelId'] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
            { $project: { _id: 1, title: 1, order: 1, createdAt: 1 } }
          ],
          as: 'latestChapter'
        }
      },
      // Lookup bookmarked chapter
      {
        $lookup: {
          from: 'userchapterinteractions',
          let: { userId: '$userId', novelId: '$novelId' },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $and: [
                    { $eq: ['$userId', '$$userId'] },
                    { $eq: ['$novelId', '$$novelId'] },
                    { $eq: ['$bookmarked', true] }
                  ]
                }
              }
            },
            {
              $lookup: {
                from: 'chapters',
                localField: 'chapterId',
                foreignField: '_id',
                as: 'chapter',
                pipeline: [
                  { $project: { _id: 1, title: 1, order: 1 } }
                ]
              }
            },
            { $unwind: '$chapter' },
            { $project: { chapter: 1 } }
          ],
          as: 'bookmarkedChapter'
        }
      },
      // Project final structure
      {
        $project: {
          _id: '$novel._id',
          title: '$novel.title',
          illustration: '$novel.illustration',
          status: '$novel.status',
          updatedAt: '$novel.updatedAt',
          createdAt: '$novel.createdAt',
          totalChapters: { $size: '$chapters' },
          latestChapter: {
            $cond: {
              if: { $gt: [{ $size: '$latestChapter' }, 0] },
              then: {
                _id: { $arrayElemAt: ['$latestChapter._id', 0] },
                title: { $arrayElemAt: ['$latestChapter.title', 0] },
                number: { $arrayElemAt: ['$latestChapter.order', 0] },
                createdAt: { $arrayElemAt: ['$latestChapter.createdAt', 0] }
              },
              else: null
            }
          },
          bookmarkedChapter: {
            $cond: {
              if: { $gt: [{ $size: '$bookmarkedChapter' }, 0] },
              then: {
                _id: { $arrayElemAt: ['$bookmarkedChapter.chapter._id', 0] },
                title: { $arrayElemAt: ['$bookmarkedChapter.chapter.title', 0] },
                number: { $arrayElemAt: ['$bookmarkedChapter.chapter.order', 0] }
              },
              else: null
            }
          }
        }
      }
    ]);
    
    res.json(bookmarkedNovels);
  } catch (err) {
    console.error("Error fetching bookmarks:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get reviews for a novel
 * @route GET /api/usernovelinteractions/reviews/:novelId
 */
router.get('/reviews/:novelId', async (req, res) => {
  try {
    const novelId = req.params.novelId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const userId = req.user?._id;

    // First check cache
    const cachedReviews = getCachedReviews(novelId, page, limit, userId);
    if (cachedReviews) {
      return res.json(cachedReviews);
    }
    
    // Check if novel exists using optimized validation
    const novel = await validateNovelExists(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Get reviews with user information
    const reviews = await UserNovelInteraction.find({
      novelId,
      review: { $exists: true, $ne: null }
    })
    .populate('userId', 'username displayName avatar') // Get user information
    .sort({ updatedAt: -1 }) // Newest first
    .skip(skip)
    .limit(limit);

    // Get total count for pagination
    const totalReviews = await UserNovelInteraction.countDocuments({
      novelId,
      review: { $exists: true, $ne: null }
    });

    // Add like information for authenticated users
    const reviewsWithLikes = reviews.map(review => ({
      id: review._id,
      user: review.userId,
      rating: review.rating,
      review: review.review,
      date: review.updatedAt,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      reviewIsEdited: review.reviewIsEdited || false,
      reviewLikes: review.reviewLikes || [],
      likesCount: (review.reviewLikes || []).length,
      isLikedByCurrentUser: req.user ? (review.reviewLikes || []).includes(req.user._id) : false
    }));

    const reviewsResponse = {
      reviews: reviewsWithLikes,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalReviews / limit),
        totalItems: totalReviews
      }
    };
    
    // Cache the result for future requests
    setCachedReviews(novelId, page, limit, userId, reviewsResponse);
    
    return res.json(reviewsResponse);
  } catch (err) {
    console.error("Error getting reviews:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Like/unlike a review
 * @route POST /api/usernovelinteractions/reviews/:reviewId/like
 */
router.post('/reviews/:reviewId/like', auth, async (req, res) => {
  try {
    const reviewId = req.params.reviewId;
    const userId = req.user._id;

    // Find the review (UserNovelInteraction)
    const reviewInteraction = await UserNovelInteraction.findById(reviewId);
    if (!reviewInteraction) {
      return res.status(404).json({ message: 'Review not found' });
    }

    if (!reviewInteraction.review) {
      return res.status(400).json({ message: 'This interaction does not contain a review' });
    }

    // Check if user already liked this review
    const reviewLikes = reviewInteraction.reviewLikes || [];
    const isCurrentlyLiked = reviewLikes.some(id => id.toString() === userId.toString());

    // Toggle like status using direct MongoDB update to avoid updating updatedAt
    let updateOperation;
    if (isCurrentlyLiked) {
      // Remove like
      updateOperation = {
        $pull: { reviewLikes: userId }
      };
    } else {
      // Add like
      updateOperation = {
        $addToSet: { reviewLikes: userId }
      };
    }

    // Use updateOne to avoid triggering updatedAt timestamp
    await UserNovelInteraction.updateOne(
      { _id: reviewId },
      updateOperation
    );

    // Get updated count for response
    const updatedReview = await UserNovelInteraction.findById(reviewId, 'reviewLikes');
    const finalLikesCount = (updatedReview.reviewLikes || []).length;

    res.json({
      liked: !isCurrentlyLiked,
      likesCount: finalLikesCount
    });
  } catch (err) {
    console.error('Error liking review:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 