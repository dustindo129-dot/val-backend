import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import Chapter from '../models/Chapter.js';

const router = express.Router();

/**
 * Get chapter interaction statistics
 * @route GET /api/userchapterinteractions/stats/:chapterId
 */
router.get('/stats/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    
    // Aggregate interactions data
    const [stats] = await UserChapterInteraction.aggregate([
      {
        $match: { chapterId: new mongoose.Types.ObjectId(chapterId) }
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
    console.error('Error getting chapter interactions:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get user's interaction with a chapter
 * @route GET /api/userchapterinteractions/user/:chapterId
 */
router.get('/user/:chapterId', auth, async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const userId = req.user._id;

    // Get user's interaction
    const interaction = await UserChapterInteraction.findOne({ userId, chapterId });
    
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
 * Toggle like status for a chapter
 * @route POST /api/userchapterinteractions/like
 */
router.post('/like', auth, async (req, res) => {
  try {
    const { chapterId } = req.body;
    const userId = req.user._id;

    if (!chapterId) {
      return res.status(400).json({ message: 'Chapter ID is required' });
    }

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find or create interaction
    let interaction = await UserChapterInteraction.findOne({ 
      userId, 
      chapterId,
      novelId: chapter.novelId 
    });
    
    if (!interaction) {
      // Create new interaction with liked=true
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        liked: true
      });
    } else {
      // Toggle existing interaction
      interaction.liked = !interaction.liked;
    }
    await interaction.save();

    // Get total likes count
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: new mongoose.Types.ObjectId(chapterId), liked: true } },
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
 * Rate a chapter
 * @route POST /api/userchapterinteractions/rate
 */
router.post('/rate', auth, async (req, res) => {
  try {
    const { chapterId, rating } = req.body;
    const userId = req.user._id;

    if (!chapterId) {
      return res.status(400).json({ message: 'Chapter ID is required' });
    }

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find or create interaction
    let interaction = await UserChapterInteraction.findOne({ 
      userId, 
      chapterId,
      novelId: chapter.novelId 
    });
    
    if (!interaction) {
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        rating
      });
    } else {
      interaction.rating = rating;
    }
    await interaction.save();

    // Calculate new rating statistics
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: new mongoose.Types.ObjectId(chapterId), rating: { $exists: true, $ne: null } } },
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
    console.error("Error rating chapter:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Remove rating from a chapter
 * @route DELETE /api/userchapterinteractions/rate/:chapterId
 */
router.delete('/rate/:chapterId', auth, async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    const userId = req.user._id;

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find interaction
    const interaction = await UserChapterInteraction.findOne({ userId, chapterId });
    if (!interaction || !interaction.rating) {
      return res.status(404).json({ message: "No rating found for this chapter" });
    }

    // Remove rating
    interaction.rating = null;
    await interaction.save();

    // Calculate new rating statistics
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: new mongoose.Types.ObjectId(chapterId), rating: { $exists: true, $ne: null } } },
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
 * Bookmark a chapter
 * @route POST /api/userchapterinteractions/bookmark
 */
router.post('/bookmark', auth, async (req, res) => {
  try {
    const { chapterId } = req.body;
    const userId = req.user._id;

    if (!chapterId) {
      return res.status(400).json({ message: 'Chapter ID is required' });
    }

    // Check if chapter exists and get novel ID
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find current interaction to determine state
    let interaction = await UserChapterInteraction.findOne({ 
      userId, 
      chapterId,
      novelId: chapter.novelId 
    });
    
    const currentlyBookmarked = interaction?.bookmarked || false;

    // Only clear other bookmarks if we're setting a new one (not unbookmarking)
    if (!currentlyBookmarked) {
      // Remove any existing bookmarks for this novel
      await UserChapterInteraction.updateMany(
        { 
          userId,
          novelId: chapter.novelId,
          bookmarked: true,
          chapterId: { $ne: chapterId }
        },
        { 
          $set: { bookmarked: false }
        }
      );
    }

    // Update or create interaction for this chapter
    if (!interaction) {
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        bookmarked: true
      });
    } else {
      interaction.bookmarked = !currentlyBookmarked;
    }
    await interaction.save();

    return res.json({ 
      bookmarked: interaction.bookmarked,
      chapterId: interaction.bookmarked ? chapterId : null
    });
  } catch (err) {
    console.error("Error toggling bookmark:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get bookmarked chapter for a novel
 * @route GET /api/userchapterinteractions/bookmark/:novelId
 */
router.get('/bookmark/:novelId', auth, async (req, res) => {
  try {
    const novelId = req.params.novelId;
    const userId = req.user._id;

    const interaction = await UserChapterInteraction.findOne({
      userId,
      novelId,
      bookmarked: true
    }).populate('chapterId', 'title');

    if (!interaction) {
      return res.json({ bookmarkedChapter: null });
    }

    return res.json({
      bookmarkedChapter: {
        id: interaction.chapterId._id,
        title: interaction.chapterId.title
      }
    });
  } catch (err) {
    console.error("Error getting bookmarked chapter:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Record a view for a chapter
 * @route POST /api/userchapterinteractions/view/:chapterId
 */
router.post('/view/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Check if this chapter view should be counted based on 8-hour window
    const viewKey = `chapter_${chapterId}_last_viewed`;
    const lastViewed = req.cookies[viewKey];
    const now = Date.now();
    const eightHours = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
    const shouldCountView = !lastViewed || (now - parseInt(lastViewed, 10)) > eightHours;

    // Only increment views if 8 hours have passed since last view
    if (shouldCountView) {
      // Increment chapter views
      await chapter.incrementViews();
      
      // We're no longer updating novel view counts here
      // This prevents novel views from incrementing on chapter refreshes
      
      // Set a cookie to track this viewing
      res.cookie(viewKey, now.toString(), { 
        maxAge: eightHours,
        httpOnly: true,
        sameSite: 'strict'
      });
    }

    return res.json({ 
      views: chapter.views,
      counted: shouldCountView
    });
  } catch (err) {
    console.error("Error recording view:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 