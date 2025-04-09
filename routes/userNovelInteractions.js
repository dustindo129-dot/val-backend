import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
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
        bookmarked: false
      });
    }

    return res.json({
      liked: interaction.liked || false,
      rating: interaction.rating || null,
      bookmarked: interaction.bookmarked || false
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
    const { novelId, rating } = req.body;
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
        rating
      });
    } else {
      interaction.rating = rating;
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

export default router; 