import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import Novel from '../models/Novel.js';

const router = express.Router();

/**
 * Get novel interaction statistics
 * @route GET /api/usernovelinteractions/stats/:novelId
 */
router.get('/stats/:novelId', async (req, res) => {
  try {
    const novelId = req.params.novelId;
    
    // Aggregate interactions data
    const [stats] = await UserNovelInteraction.aggregate([
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
          ratingSum: {
            $sum: { $ifNull: ['$rating', 0] }
          }
        }
      }
    ]);

    // If no interactions exist yet, return default values
    if (!stats) {
      return res.json({
        totalLikes: 0,
        totalRatings: 0,
        averageRating: '0.0'
      });
    }

    const averageRating = stats.totalRatings > 0 
      ? (stats.ratingSum / stats.totalRatings).toFixed(1) 
      : '0.0';

    res.json({
      totalLikes: stats.totalLikes,
      totalRatings: stats.totalRatings,
      averageRating
    });
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

    // Get user's interaction
    const interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      return res.json({
        liked: false,
        rating: null,
        review: null,
        bookmarked: false,
        followed: false
      });
    }

    return res.json({
      liked: interaction.liked || false,
      rating: interaction.rating || null,
      review: interaction.review || null,
      bookmarked: interaction.bookmarked || false,
      followed: interaction.followed || false
    });
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

    // Check if novel exists
    const novel = await Novel.findById(novelId);
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

    // Check if novel exists
    const novel = await Novel.findById(novelId);
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
      interaction.rating = rating;
      // Only update review if provided
      if (review !== undefined) {
        interaction.review = review;
      }
    }
    await interaction.save();

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

    // Check if novel exists
    const novel = await Novel.findById(novelId);
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

    // Check if novel exists
    const novel = await Novel.findById(novelId);
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

    return res.json({ 
      bookmarked: interaction.bookmarked
    });
  } catch (err) {
    console.error("Error toggling bookmark:", err);
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

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Get reviews with user information
    const reviews = await UserNovelInteraction.find({
      novelId,
      review: { $exists: true, $ne: null }
    })
    .populate('userId', 'username avatar') // Get user information
    .sort({ updatedAt: -1 }) // Newest first
    .skip(skip)
    .limit(limit);

    // Get total count for pagination
    const totalReviews = await UserNovelInteraction.countDocuments({
      novelId,
      review: { $exists: true, $ne: null }
    });

    return res.json({
      reviews: reviews.map(review => ({
        id: review._id,
        user: review.userId,
        rating: review.rating,
        review: review.review,
        date: review.updatedAt
      })),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalReviews / limit),
        totalItems: totalReviews
      }
    });
  } catch (err) {
    console.error("Error getting reviews:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 