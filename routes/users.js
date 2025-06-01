import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Novel from '../models/Novel.js';
import admin from '../middleware/admin.js';
import path from 'path';
import fs from 'fs';
import Comment from '../models/Comment.js';
import Chapter from '../models/Chapter.js';
import UserChapterInteraction from '../models/UserChapterInteraction.js';
import { getCachedUserById, getCachedUserByUsername, clearUserCache } from '../utils/userCache.js';

const router = express.Router();

/**
 * Update user's avatar
 * @route POST /api/users/:username/avatar
 */
router.post('/:username/avatar', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { avatar } = req.body;
    if (!avatar) {
      return res.status(400).json({ message: 'No avatar URL provided' });
    }

    // Update user's avatar in database with Cloudinary URL
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { avatar },
      { new: true }
    ).select('-password');

    res.json({ avatar: user.avatar });
  } catch (error) {
    console.error('Avatar update error:', error);
    res.status(500).json({ message: 'Failed to update avatar' });
  }
});

/**
 * Update user's email
 * Requires current password verification
 * @route PUT /api/users/:username/email
 */
router.put('/:username/email', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { email, currentPassword } = req.body;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Get user with password
    const user = await User.findById(req.user._id);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Check if email is already in use
    const emailExists = await User.findOne({ email, _id: { $ne: user._id } });
    if (emailExists) {
      return res.status(400).json({ message: 'Email is already in use' });
    }

    // Update email
    user.email = email;
    await user.save();

    res.json({ email: user.email });
  } catch (error) {
    console.error('Email update error:', error);
    res.status(500).json({ message: 'Failed to update email' });
  }
});

/**
 * Update user's display name
 * Can only be changed once per month
 * @route PUT /api/users/:username/display-name
 */
router.put('/:username/display-name', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { displayName } = req.body;

    // Validate display name
    if (!displayName || displayName.trim().length === 0) {
      return res.status(400).json({ message: 'Display name cannot be empty' });
    }

    if (displayName.trim().length > 50) {
      return res.status(400).json({ message: 'Display name cannot exceed 50 characters' });
    }

    // Get user
    const user = await User.findById(req.user._id);

    // Check if user can change display name (once per month)
    if (user.displayNameLastChanged) {
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      
      if (user.displayNameLastChanged > oneMonthAgo) {
        const nextChangeDate = new Date(user.displayNameLastChanged);
        nextChangeDate.setMonth(nextChangeDate.getMonth() + 1);
        
        return res.status(400).json({ 
          message: 'You can only change your display name once per month',
          nextChangeDate: nextChangeDate.toISOString()
        });
      }
    }

    // Check if display name is already taken by another user (case-insensitive)
    const existingUser = await User.findOne({ 
      displayName: { $regex: new RegExp(`^${escapeRegex(displayName.trim())}$`, 'i') },
      _id: { $ne: user._id }
    });
    
    if (existingUser) {
      return res.status(400).json({ 
        message: 'Tên hiển thị đã tồn tại. Vui lòng chọn tên khác.'
      });
    }

    // Update display name and timestamp
    user.displayName = displayName.trim();
    user.displayNameLastChanged = new Date();
    await user.save();

    res.json({ 
      displayName: user.displayName,
      displayNameLastChanged: user.displayNameLastChanged
    });
  } catch (error) {
    console.error('Display name update error:', error);
    res.status(500).json({ message: 'Failed to update display name' });
  }
});

/**
 * Update user's password
 * Requires current password verification
 * @route PUT /api/users/:username/password
 */
router.put('/:username/password', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { currentPassword, newPassword } = req.body;

    // Validate password strength
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    // Get user with password
    const user = await User.findById(req.user._id);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Update password - let the pre-save middleware handle hashing
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Password update error:', error);
    res.status(500).json({ message: 'Failed to update password' });
  }
});

/**
 * Get user profile (OPTIMIZED)
 * @route GET /api/users/:username/profile
 */
router.get('/:username/profile', auth, async (req, res) => {
  try {
    const username = req.params.username;
    
    // Use cached lookup
    const user = await getCachedUserByUsername(username);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get user statistics in parallel
    const [commentsCount, chaptersReadCount, novelsRatedCount] = await Promise.all([
      Comment.countDocuments({ user: user._id, isDeleted: { $ne: true } }),
      UserChapterInteraction.countDocuments({ userId: user._id }),
      UserNovelInteraction.countDocuments({ userId: user._id, rating: { $ne: null } })
    ]);

    const profile = {
      ...user,
      stats: {
        commentsCount,
        chaptersReadCount,
        novelsRatedCount
      }
    };

    res.json(profile);
  } catch (err) {
    console.error('Error getting user profile:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Check if a novel is bookmarked by user
 * @route GET /api/users/:username/bookmarks/:novelId
 */
router.get('/:username/bookmarks/:novelId', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to view bookmarks' });
    }

    // Validate novelId
    if (!mongoose.Types.ObjectId.isValid(req.params.novelId)) {
      return res.status(400).json({ message: 'Invalid novel ID' });
    }

    // Use UserNovelInteraction instead of User.bookmarks
    const interaction = await UserNovelInteraction.findOne({
      userId: req.user._id,
      novelId: req.params.novelId
    });
    
    const isBookmarked = interaction ? interaction.bookmarked : false;
    
    res.json({ isBookmarked });
  } catch (error) {
    console.error('Bookmark status check error:', error);
    res.status(500).json({ message: 'Failed to check bookmark status' });
  }
});

/**
 * Add/Remove a novel to/from user's bookmarks
 * @route POST /api/users/:username/bookmarks
 */
router.post('/:username/bookmarks', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to add bookmarks' });
    }

    const { novelId } = req.body;
    if (!novelId || !mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: 'Invalid novel ID' });
    }

    // Find existing interaction or create a new one
    let interaction = await UserNovelInteraction.findOne({
      userId: req.user._id,
      novelId: novelId
    });

    if (!interaction) {
      // Create new interaction with bookmarked=true
      interaction = new UserNovelInteraction({
        userId: req.user._id,
        novelId: novelId,
        bookmarked: true,
        updatedAt: new Date()
      });
      await interaction.save();
      
      return res.json({
        message: 'Novel bookmarked successfully',
        isBookmarked: true
      });
    } else {
      // Toggle bookmark status
      interaction.bookmarked = !interaction.bookmarked;
      interaction.updatedAt = new Date();
      await interaction.save();
      
      return res.json({
        message: interaction.bookmarked ? 'Novel bookmarked successfully' : 'Bookmark removed successfully',
        isBookmarked: interaction.bookmarked
      });
    }
  } catch (error) {
    console.error('Bookmark toggle error:', error);
    res.status(500).json({ message: 'Failed to toggle bookmark' });
  }
});

/**
 * Remove a novel from user's bookmarks
 * @route DELETE /api/users/:username/bookmarks/:novelId
 */
router.delete('/:username/bookmarks/:novelId', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to remove bookmarks' });
    }

    // Validate novelId
    if (!mongoose.Types.ObjectId.isValid(req.params.novelId)) {
      return res.status(400).json({ message: 'Invalid novel ID' });
    }

    // Find interaction and set bookmarked to false
    const interaction = await UserNovelInteraction.findOne({
      userId: req.user._id,
      novelId: req.params.novelId
    });

    if (interaction && interaction.bookmarked) {
      interaction.bookmarked = false;
      interaction.updatedAt = new Date();
      await interaction.save();
    }

    res.json({ 
      message: 'Bookmark removed successfully',
      isBookmarked: false 
    });
  } catch (error) {
    console.error('Bookmark remove error:', error);
    res.status(500).json({ message: 'Failed to remove bookmark' });
  }
});

/**
 * Get all bookmarked novels for a user with complete novel details
 * @route GET /api/users/:username/bookmarks
 */
router.get('/:username/bookmarks', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to view bookmarks' });
    }

    // Find all bookmarked interactions for this user
    const bookmarkedInteractions = await UserNovelInteraction.find({
      userId: req.user._id,
      bookmarked: true
    });
    
    if (bookmarkedInteractions.length === 0) {
      return res.json([]);
    }

    // Extract novel IDs
    const novelIds = bookmarkedInteractions.map(interaction => interaction.novelId);
    
    // Find all novels that are bookmarked
    const novels = await mongoose.model('Novel').find(
      { _id: { $in: novelIds } },
      { _id: 1, title: 1, illustration: 1 }
    );
    
    // Then fetch the latest chapter for each novel
    const bookmarksWithDetails = await Promise.all(
      novels.map(async (novel) => {
        // Find the latest module and its latest chapter
        const latestModule = await mongoose.model('Module')
          .findOne({ novelId: novel._id })
          .sort({ order: -1 })
          .populate({
            path: 'chapters',
            select: 'title order',
            options: { sort: { order: -1 }, limit: 1 }
          });

        return {
          _id: novel._id,
          title: novel.title || 'Untitled',
          illustration: novel.illustration || '',
          latestChapter: latestModule?.chapters?.[0] ? {
            title: latestModule.chapters[0].title,
            number: latestModule.chapters[0].order + 1
          } : null
        };
      })
    );

    return res.json(bookmarksWithDetails);
  } catch (error) {
    console.error('Bookmarks fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch bookmarks', error: error.message });
  }
});

/**
 * Block a user
 * @route POST /api/users/:username/block
 */
router.post('/:username/block', auth, async (req, res) => {
  try {
    const { userToBlock } = req.body;
    
    // Cannot block yourself
    if (req.user.username === userToBlock) {
      return res.status(400).json({ message: 'Cannot block yourself' });
    }

    // Find the user to block
    const targetUser = await User.findOne({ username: userToBlock });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get the current user
    const currentUser = await User.findById(req.user._id);
    
    // Check if already blocked
    if (currentUser.blockedUsers.includes(targetUser._id)) {
      return res.status(400).json({ message: 'User is already blocked' });
    }

    // Check block limit
    if (currentUser.blockedUsers.length >= 50) {
      return res.status(400).json({ message: 'Cannot block more than 50 users' });
    }

    // Add to blocked users
    currentUser.blockedUsers.push(targetUser._id);
    await currentUser.save();

    res.json({ message: 'User blocked successfully' });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ message: 'Failed to block user' });
  }
});

/**
 * Unblock a user
 * @route DELETE /api/users/:username/block/:blockedUsername
 */
router.delete('/:username/block/:blockedUsername', auth, async (req, res) => {
  try {
    const { blockedUsername } = req.params;
    
    // Find the blocked user
    const blockedUser = await User.findOne({ username: blockedUsername });
    if (!blockedUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get current user
    const currentUser = await User.findById(req.user._id);
    
    // Remove from blocked users
    currentUser.blockedUsers = currentUser.blockedUsers.filter(
      id => id.toString() !== blockedUser._id.toString()
    );
    await currentUser.save();

    res.json({ message: 'User unblocked successfully' });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ message: 'Failed to unblock user' });
  }
});

/**
 * Get blocked users list
 * @route GET /api/users/:username/blocked
 */
router.get('/:username/blocked', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('blockedUsers', 'username displayName avatar');
    
    res.json(user.blockedUsers);
  } catch (error) {
    console.error('Get blocked users error:', error);
    res.status(500).json({ message: 'Failed to get blocked users' });
  }
});

/**
 * Check if user is banned
 * @route GET /api/users/:username/ban-status
 */
router.get('/:username/ban-status', auth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({ isBanned: user.isBanned || false });
  } catch (error) {
    console.error('Ban status check error:', error);
    res.status(500).json({ message: 'Failed to check ban status' });
  }
});

/**
 * Ban a user (Admin only)
 * @route POST /api/users/ban/:username
 */
router.post('/ban/:username', auth, async (req, res) => {
  try {
    // Check if the requesting user is an admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can ban users' });
    }

    const userToBan = await User.findOne({ username: req.params.username });
    if (!userToBan) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Cannot ban another admin
    if (userToBan.role === 'admin') {
      return res.status(403).json({ message: 'Cannot ban an admin' });
    }

    userToBan.isBanned = true;
    await userToBan.save();

    res.json({ message: 'User banned successfully' });
  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({ message: 'Failed to ban user' });
  }
});

/**
 * Unban a user (Admin only)
 * @route DELETE /api/users/ban/:username
 */
router.delete('/ban/:username', auth, async (req, res) => {
  try {
    // Check if the requesting user is an admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can unban users' });
    }

    const userToUnban = await User.findOne({ username: req.params.username });
    if (!userToUnban) {
      return res.status(404).json({ message: 'User not found' });
    }

    userToUnban.isBanned = false;
    await userToUnban.save();

    res.json({ message: 'User unbanned successfully' });
  } catch (error) {
    console.error('Unban user error:', error);
    res.status(500).json({ message: 'Failed to unban user' });
  }
});

/**
 * Get all banned users (Admin only)
 * @route GET /api/users/banned
 */
router.get('/banned', auth, async (req, res) => {
  try {
    // Check if the requesting user is an admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can view banned users' });
    }

    const bannedUsers = await User.find({ isBanned: true })
      .select('username displayName avatar');

    res.json(bannedUsers);
  } catch (error) {
    console.error('Get banned users error:', error);
    res.status(500).json({ message: 'Failed to get banned users' });
  }
});

/**
 * Search for users
 * @route GET /api/users/search
 */
router.get('/search', auth, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.length < 2) {
      return res.status(400).json({ message: 'Search query must be at least 2 characters' });
    }
    
    // Search for users by username, displayName, or email
    const users = await User.find({
      $or: [
        { username: { $regex: query, $options: 'i' } },
        { displayName: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } }
      ]
    }).select('username displayName avatar balance');
    
    res.json(users);
  } catch (error) {
    console.error('User search failed:', error);
    res.status(500).json({ message: 'Failed to search users' });
  }
});

// Get user by username
router.get('/:username', async (req, res) => {
  try {
    const username = req.params.username;
    
    // Use cached lookup to prevent duplicate queries
    const user = await getCachedUserByUsername(username);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json(user);
  } catch (err) {
    console.error('Error getting user:', err);
    res.status(500).json({ message: err.message });
  }
});

// Update user route with cache invalidation
router.put('/:id', auth, async (req, res) => {
  try {
    // Only allow users to update their own profile or admin to update any
    if (req.user._id.toString() !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const updateData = { ...req.body };
    delete updateData.password; // Don't allow password updates through this route

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Clear user cache when data changes
    clearUserCache(user._id, user.username);

    res.json(user);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Helper function to escape regex special characters
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Search users (admin only)
router.get('/search/:query', [auth, admin], async (req, res) => {
  try {
    const query = escapeRegex(req.params.query);
    const users = await User.find({
      username: { $regex: query, $options: 'i' }
    })
    .select('-password')
    .limit(10);
    
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router; 