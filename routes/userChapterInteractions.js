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

    // Verify the novelId is valid
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: "Invalid novel ID format" });
    }

    // Handle missing user ID
    if (!userId) {
      return res.status(401).json({ message: "User authentication required" });
    }

    // First try to find the interaction without populating to check if it exists
    const interactionExists = await UserChapterInteraction.findOne({
      userId,
      novelId,
      bookmarked: true
    });

    if (!interactionExists) {
      return res.json({ bookmarkedChapter: null });
    }
    
    // If the interaction exists, now try to populate with error handling
    try {
      const interaction = await UserChapterInteraction.findOne({
        userId,
        novelId,
        bookmarked: true
      }).populate('chapterId', 'title');
      
      // Check if chapter reference is valid
      if (!interaction.chapterId || typeof interaction.chapterId === 'string') {
        // The chapter reference is invalid or missing - update the record
        await UserChapterInteraction.findByIdAndUpdate(
          interaction._id,
          { bookmarked: false } // Unmark the bookmark if chapter doesn't exist
        );
        return res.json({ bookmarkedChapter: null });
      }
      
      return res.json({
        bookmarkedChapter: {
          id: interaction.chapterId._id,
          title: interaction.chapterId.title
        }
      });
    } catch (populateErr) {
      console.error("Error populating chapter reference:", populateErr);
      return res.json({ bookmarkedChapter: null });
    }
  } catch (err) {
    console.error("Error getting bookmarked chapter:", err);
    // Return a graceful error instead of 500
    return res.json({ 
      bookmarkedChapter: null,
      error: "Error retrieving bookmark information"
    });
  }
});

/**
 * Record a view for a chapter
 * @route POST /api/userchapterinteractions/view/:chapterId
 */
router.post('/view/:chapterId', async (req, res) => {
  try {
    const chapterId = req.params.chapterId;
    
    // Use a direct atomic update instead of loading the entire chapter first
    // This is much faster and avoids race conditions
    const updateResult = await Chapter.findByIdAndUpdate(
      chapterId,
      { $inc: { views: 1 } },
      { new: true, select: 'views' } // Return just the updated views field
    );
    
    if (!updateResult) {
      return res.status(404).json({ message: "Chapter not found" });
    }
    
    // Return the updated view count
    return res.json({ 
      views: updateResult.views,
      counted: true
    });
  } catch (err) {
    console.error("Error recording view:", err);
    // Still return some data to prevent client-side errors
    res.status(200).json({ 
      views: 0,
      counted: false,
      error: "Error recording view"
    });
  }
});

export default router; 