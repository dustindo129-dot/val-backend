import express from "express";
import Novel from "../../models/Novel.js";
import { auth } from "../../middleware/auth.js";
import UserNovelInteraction from '../../models/UserNovelInteraction.js';

const router = express.Router();

/**
 * Toggle like status for a novel
 * Increments/decrements the novel's like count based on user action
 * @route POST /api/novels/:id/like
 */
router.post("/:id/like", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find existing interaction or create new one
    let interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      // Create new interaction with liked=true
      interaction = new UserNovelInteraction({
        userId,
        novelId,
        liked: true
      });
      await interaction.save();
      
      // Increment novel likes count
      await Novel.findByIdAndUpdate(novelId, { $inc: { likes: 1 } });
      
      return res.status(200).json({ 
        liked: true, 
        likes: novel.likes + 1 
      });
    } else {
      // Toggle existing interaction
      const newLikedStatus = !interaction.liked;
      interaction.liked = newLikedStatus;
      await interaction.save();
      
      // Update novel likes count accordingly
      const updateVal = newLikedStatus ? 1 : -1;
      const updatedNovel = await Novel.findByIdAndUpdate(
        novelId, 
        { $inc: { likes: updateVal } },
        { new: true }
      );
      
      return res.status(200).json({ 
        liked: newLikedStatus, 
        likes: updatedNovel.likes 
      });
    }
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Rate a novel
 * Updates the novel's rating statistics
 * @route POST /api/novels/:id/rate
 */
router.post("/:id/rate", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;
    const { rating } = req.body;
    
    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find existing interaction or create new one
    let interaction = await UserNovelInteraction.findOne({ userId, novelId });
    let prevRating = 0;
    
    if (!interaction) {
      // Create new interaction with provided rating
      interaction = new UserNovelInteraction({
        userId,
        novelId,
        rating
      });
      
      // Update novel's rating statistics
      await Novel.findByIdAndUpdate(novelId, {
        $inc: {
          'ratings.total': 1,
          'ratings.value': rating
        }
      });
    } else {
      // Get previous rating if exists
      prevRating = interaction.rating || 0;
      
      // Update interaction with new rating
      interaction.rating = rating;
      
      if (prevRating > 0) {
        // Update rating value by removing previous and adding new
        await Novel.findByIdAndUpdate(novelId, {
          $inc: {
            'ratings.value': (rating - prevRating)
          }
        });
      } else {
        // First time rating, increment total and add value
        await Novel.findByIdAndUpdate(novelId, {
          $inc: {
            'ratings.total': 1,
            'ratings.value': rating
          }
        });
      }
    }
    
    await interaction.save();
    
    // Get updated novel to calculate average
    const updatedNovel = await Novel.findById(novelId);
    const averageRating = updatedNovel.ratings.total > 0 
      ? (updatedNovel.ratings.value / updatedNovel.ratings.total).toFixed(1) 
      : '0.0';
    
    return res.status(200).json({
      rating,
      ratingsCount: updatedNovel.ratings.total,
      averageRating
    });
  } catch (err) {
    console.error("Error rating novel:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Remove rating from a novel
 * Updates the novel's rating statistics
 * @route DELETE /api/novels/:id/rate
 */
router.delete("/:id/rate", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find existing interaction
    const interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction || !interaction.rating) {
      return res.status(404).json({ message: "No rating found for this novel" });
    }
    
    const prevRating = interaction.rating;
    
    // Remove rating from interaction
    interaction.rating = null;
    await interaction.save();
    
    // Update novel's rating statistics
    await Novel.findByIdAndUpdate(novelId, {
      $inc: {
        'ratings.total': -1,
        'ratings.value': -prevRating
      }
    });
    
    // Get updated novel to calculate average
    const updatedNovel = await Novel.findById(novelId);
    const averageRating = updatedNovel.ratings.total > 0 
      ? (updatedNovel.ratings.value / updatedNovel.ratings.total).toFixed(1) 
      : '0.0';
    
    return res.status(200).json({
      ratingsCount: updatedNovel.ratings.total,
      averageRating
    });
  } catch (err) {
    console.error("Error removing rating:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get user's interaction with a novel (like status and rating)
 * @route GET /api/novels/:id/interaction
 */
router.get("/:id/interaction", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;

    // Find interaction
    const interaction = await UserNovelInteraction.findOne({ userId, novelId });
    
    if (!interaction) {
      return res.json({ liked: false, rating: null });
    }
    
    return res.json({
      liked: interaction.liked || false,
      rating: interaction.rating || null
    });
  } catch (err) {
    console.error("Error getting user interaction:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 