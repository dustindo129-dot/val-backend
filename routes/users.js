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
import { getCachedUserById, getCachedUserByUsername, clearUserCache, clearAllUserCaches } from '../utils/userCache.js';
import { batchGetUsers } from '../utils/batchUserCache.js';
import ForumPost from '../models/ForumPost.js';
import Report from '../models/Report.js';

const router = express.Router();

/**
 * Get comprehensive user statistics
 * @route GET /api/users/:userId/stats
 */
router.get('/:userId/stats', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Only allow users to view their own stats or admins to view any stats
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to view these stats' });
    }

    // Use query deduplication and caching
    const cacheKey = `user_stats_${userId}`;
    
    const stats = await dedupUserStatsQuery(cacheKey, async () => {
      // Check cache first
      const cachedStats = getCachedUserStats(userId);
      if (cachedStats) {
        return cachedStats;
      }

      // Use estimated counts for better performance (much faster than exact counts)
      const [
        commentsCount,
        chapterInteractionsCount,
        novelRatingsCount,
        notificationsCount
      ] = await Promise.all([
        // Use estimatedDocumentCount with match for better performance
        Comment.aggregate([
          { $match: { user: new mongoose.Types.ObjectId(userId), isDeleted: { $ne: true } } },
          { $count: "total" }
        ]).then(result => result[0]?.total || 0),
        
        UserChapterInteraction.aggregate([
          { $match: { userId: new mongoose.Types.ObjectId(userId) } },
          { $count: "total" }
        ]).then(result => result[0]?.total || 0),
        
        UserNovelInteraction.aggregate([
          { $match: { userId: new mongoose.Types.ObjectId(userId), rating: { $ne: null } } },
          { $count: "total" }
        ]).then(result => result[0]?.total || 0),
        
        // Only fetch notification count if it's the requesting user
        req.user._id.toString() === userId 
          ? (await import('../models/Notification.js')).default.aggregate([
              { $match: { userId: new mongoose.Types.ObjectId(userId), isRead: false } },
              { $count: "total" }
            ]).then(result => result[0]?.total || 0)
          : 0
      ]);

      const userStats = {
        commentsCount,
        chapterInteractionsCount,
        novelRatingsCount,
        unreadNotificationsCount: notificationsCount
      };

      // Cache the results
      setCachedUserStats(userId, userStats);
      
      return userStats;
    });

    res.json(stats);
  } catch (err) {
    console.error('Error fetching user stats:', err);
    res.status(500).json({ message: err.message });
  }
});

// Simple in-memory cache for user stats
const userStatsCache = new Map();
const USER_STATS_CACHE_TTL = 1000 * 60 * 15; // 15 minutes (increased from 5)
const MAX_USER_STATS_CACHE_SIZE = 200;

// Query deduplication cache for user stats
const pendingUserStatsQueries = new Map();

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

// Query deduplication helper for user stats
const dedupUserStatsQuery = async (key, queryFn) => {
  if (pendingUserStatsQueries.has(key)) {
    return await pendingUserStatsQueries.get(key);
  }
  
  const queryPromise = queryFn();
  pendingUserStatsQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    pendingUserStatsQueries.delete(key);
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

/**
 * Update user's avatar
 * @route POST /api/users/:username/avatar
 */
router.post('/:displayNameSlug/avatar', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
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

    // Clear all user caches after avatar update
    clearAllUserCaches(user);

    res.json({ avatar: user.avatar });
  } catch (error) {
    console.error('Avatar update error:', error);
    res.status(500).json({ message: 'Failed to update avatar' });
  }
});

/**
 * Request email change
 * Sends confirmation email to current email address
 * @route PUT /api/users/:username/email
 */
router.put('/:displayNameSlug/email', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { email, currentPassword } = req.body;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Check if new email is the same as current email
    if (email.toLowerCase() === req.user.email.toLowerCase()) {
      return res.status(400).json({ message: 'New email must be different from current email' });
    }

    // Check if email is already in use BEFORE password verification
    const emailExists = await User.findOne({ email, _id: { $ne: req.user._id } });
    if (emailExists) {
      return res.status(400).json({ message: 'Email is already in use' });
    }

    // Get user with password
    const user = await User.findById(req.user._id);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Generate confirmation token
    const crypto = await import('crypto');
    const confirmationToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Store pending email change
    user.pendingEmailChange = {
      newEmail: email,
      token: confirmationToken,
      expires: expires
    };
    await user.save();

    // Send confirmation email to current email
    const { sendEmailChangeConfirmation } = await import('../services/emailService.js');
    await sendEmailChangeConfirmation(user.email, email, confirmationToken);

    res.json({ 
      message: 'Email change confirmation sent to your current email address',
      requiresConfirmation: true
    });
  } catch (error) {
    console.error('Email change request error:', error);
    res.status(500).json({ message: 'Failed to send email change confirmation' });
  }
});

/**
 * Confirm email change
 * Processes the email change after user clicks confirmation link
 * @route POST /api/users/confirm-email-change/:token
 */
router.post('/confirm-email-change/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ message: 'Confirmation token is required' });
    }

    // Find user with pending email change token
    const user = await User.findOne({
      'pendingEmailChange.token': token,
      'pendingEmailChange.expires': { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ 
        message: 'Invalid or expired confirmation token',
        expired: true
      });
    }

    // Check if the new email is still available
    const emailExists = await User.findOne({ 
      email: user.pendingEmailChange.newEmail, 
      _id: { $ne: user._id } 
    });
    
    if (emailExists) {
      // Clear the pending change
      user.pendingEmailChange = undefined;
      await user.save();
      
      return res.status(400).json({ 
        message: 'Email is no longer available. Please try with a different email.',
        emailTaken: true
      });
    }

    // Update email and clear pending change
    user.email = user.pendingEmailChange.newEmail;
    user.pendingEmailChange = undefined;
    await user.save();

    res.json({ 
      message: 'Email successfully updated',
      newEmail: user.email
    });
  } catch (error) {
    console.error('Email confirmation error:', error);
    res.status(500).json({ message: 'Failed to confirm email change' });
  }
});

/**
 * Update user's introduction
 * @route PUT /api/users/:username/intro
 */
router.put('/:displayNameSlug/intro', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { intro } = req.body;

    // Validate intro length
    if (intro && intro.length > 10000) {
      return res.status(400).json({ message: 'Introduction cannot exceed 10000 characters' });
    }

    // Get user
    const user = await User.findById(req.user._id);

    // Update introduction
    user.intro = intro || '';
    await user.save();

    // Clear user resolution cache since user data changed
    clearUserResolutionCache(req.user._id);

    res.json({ 
      intro: user.intro
    });
  } catch (error) {
    console.error('Introduction update error:', error);
    res.status(500).json({ message: 'Failed to update introduction' });
  }
});

/**
 * Update user's display name
 * Can only be changed once per month
 * @route PUT /api/users/:username/display-name
 */
router.put('/:displayNameSlug/display-name', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
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

    // Validate display name format (no special characters or spaces for new display names)
    if (!/^[a-zA-Z0-9_]{1,50}$/.test(displayName.trim())) {
      return res.status(400).json({ 
        message: 'Tên hiển thị chỉ được chứa chữ cái, số và dấu gạch dưới (_), không được có khoảng trắng hoặc ký tự đặc biệt.'
      });
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
router.put('/:displayNameSlug/password', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
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
router.get('/:displayNameSlug/profile', auth, async (req, res) => {
  try {
    const displayNameSlug = req.params.displayNameSlug;
    
    // Resolve user by display name slug
    const user = await resolveUserByDisplayName(displayNameSlug);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (user.username !== req.user.username) {
      return res.status(403).json({ message: 'Not authorized to view this profile' });
    }

    // Get user statistics in parallel (optimized with aggregation)
    const [commentsCount, chaptersReadCount, novelsRatedCount] = await Promise.all([
      Comment.aggregate([
        { $match: { user: req.user._id, isDeleted: { $ne: true } } },
        { $count: "total" }
      ]).then(result => result[0]?.total || 0),
      
      UserChapterInteraction.aggregate([
        { $match: { userId: req.user._id } },
        { $count: "total" }
      ]).then(result => result[0]?.total || 0),
      
      UserNovelInteraction.aggregate([
        { $match: { userId: req.user._id, rating: { $ne: null } } },
        { $count: "total" }
      ]).then(result => result[0]?.total || 0)
    ]);

    const profile = {
      ...req.user,
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
 * Get display name change eligibility (LIGHTWEIGHT)
 * @route GET /api/users/:username/display-name-eligibility
 */
router.get('/:displayNameSlug/display-name-eligibility', auth, async (req, res) => {
  try {
    const displayNameSlug = req.params.displayNameSlug;
    
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to view this information' });
    }

    // Get user with only the fields we need for display name eligibility
    const user = await User.findById(req.user._id)
      .select('displayNameLastChanged')
      .lean();

    // Calculate eligibility
    let canChangeDisplayName = true;
    let nextDisplayNameChange = null;

    if (user.displayNameLastChanged) {
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      
      if (user.displayNameLastChanged > oneMonthAgo) {
        canChangeDisplayName = false;
        const nextChangeDate = new Date(user.displayNameLastChanged);
        nextChangeDate.setMonth(nextChangeDate.getMonth() + 1);
        nextDisplayNameChange = nextChangeDate;
      }
    }

    res.json({
      canChangeDisplayName,
      nextDisplayNameChange,
      displayNameLastChanged: user.displayNameLastChanged
    });
  } catch (error) {
    console.error('Display name eligibility check error:', error);
    res.status(500).json({ message: 'Failed to check display name eligibility' });
  }
});

/**
 * Check if a novel is bookmarked by user
 * @route GET /api/users/:username/bookmarks/:novelId
 */
router.get('/:displayNameSlug/bookmarks/:novelId', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const user = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== user.username) {
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
router.post('/:displayNameSlug/bookmarks', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const user = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== user.username) {
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
router.delete('/:displayNameSlug/bookmarks/:novelId', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const user = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== user.username) {
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
router.get('/:displayNameSlug/bookmarks', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const user = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== user.username) {
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
 * Check if a novel is followed by user
 * @route GET /api/users/:username/follows/:novelId
 */
router.get('/:username/follows/:novelId', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to view follows' });
    }

    // Validate novelId
    if (!mongoose.Types.ObjectId.isValid(req.params.novelId)) {
      return res.status(400).json({ message: 'Invalid novel ID' });
    }

    // Use UserNovelInteraction to check follow status
    const interaction = await UserNovelInteraction.findOne({
      userId: req.user._id,
      novelId: req.params.novelId
    });
    
    const isFollowed = interaction ? interaction.followed : false;
    
    res.json({ isFollowed });
  } catch (error) {
    console.error('Follow status check error:', error);
    res.status(500).json({ message: 'Failed to check follow status' });
  }
});

/**
 * Follow/Unfollow a novel
 * @route POST /api/users/:username/follows
 */
router.post('/:username/follows', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to follow novels' });
    }

    const { novelId } = req.body;
    if (!novelId || !mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: 'Invalid novel ID' });
    }

    // Use findOneAndUpdate with upsert for atomic operation
    const result = await UserNovelInteraction.findOneAndUpdate(
      { userId: req.user._id, novelId: novelId },
      [
        {
          // Use aggregation pipeline for atomic toggle
          $set: {
            followed: { $not: ['$followed'] }, // Toggle the current value
            updatedAt: new Date()
          }
        }
      ],
      { 
        new: true, // Return updated document
        upsert: true, // Create if doesn't exist
        setDefaultsOnInsert: true // Set defaults for new documents
      }
    );

    // CRITICAL: Clear caches immediately
    const userIdString = req.user._id.toString();
    
    // Clear novel caches
    try {
      const { clearNovelCaches } = await import('../utils/cacheUtils.js');
      if (clearNovelCaches) {
        await clearNovelCaches();
      }
    } catch (error) {
      console.warn('Could not clear novel caches:', error.message);
    }

    // Clear specific cache entries
    try {
      const { clearSpecificNovelCache } = await import('./novels.js');
      if (clearSpecificNovelCache) {
        // Clear both logged-in user and guest cache entries
        await Promise.all([
          clearSpecificNovelCache(`novel-complete:${novelId}:${userIdString}`),
          clearSpecificNovelCache(`novel-complete:${novelId}:guest`),
          clearSpecificNovelCache(`novel-complete:${novelId}:${req.user._id}`)
        ]);
      }
    } catch (error) {
      console.warn('Could not clear specific novel caches:', error.message);
    }

    return res.json({
      message: result.followed ? 'Novel followed successfully' : 'Novel unfollowed successfully',
      isFollowed: result.followed
    });
  } catch (error) {
    console.error('Follow toggle error:', error);
    res.status(500).json({ message: 'Failed to toggle follow' });
  }
});

/**
 * Unfollow a novel
 * @route DELETE /api/users/:username/follows/:novelId
 */
router.delete('/:username/follows/:novelId', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to unfollow novels' });
    }

    // Validate novelId
    if (!mongoose.Types.ObjectId.isValid(req.params.novelId)) {
      return res.status(400).json({ message: 'Invalid novel ID' });
    }

    // Find interaction and set followed to false
    const interaction = await UserNovelInteraction.findOne({
      userId: req.user._id,
      novelId: req.params.novelId
    });

    if (interaction && interaction.followed) {
      interaction.followed = false;
      interaction.updatedAt = new Date();
      await interaction.save();
      
      // CRITICAL: Clear complete novel cache to ensure fresh user interaction data (same as like/bookmark)
      try {
        const { clearNovelCaches } = await import('../utils/cacheUtils.js');
        if (clearNovelCaches) {
          clearNovelCaches();
        }
        
        // Also clear specific user cache entries from novels route
        const { clearSpecificNovelCache } = await import('./novels.js');
        if (clearSpecificNovelCache) {
          // Clear both logged-in user and guest cache entries (ensure proper string format)
          const userIdString = req.user._id.toString();
          clearSpecificNovelCache(`novel-complete:${req.params.novelId}:${userIdString}`);
          clearSpecificNovelCache(`novel-complete:${req.params.novelId}:guest`);
          
          // Also clear any variations
          clearSpecificNovelCache(`novel-complete:${req.params.novelId}:${req.user._id}`); // ObjectId version
        }
      } catch (error) {
        console.warn('Could not clear novel caches:', error.message);
      }
    }

    res.json({ 
      message: 'Novel unfollowed successfully',
      isFollowed: false 
    });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ message: 'Failed to unfollow novel' });
  }
});

/**
 * Get all followed novels for a user
 * @route GET /api/users/:username/follows
 */
router.get('/:username/follows', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to view follows' });
    }

    // Find all followed interactions for this user
    const followedInteractions = await UserNovelInteraction.find({
      userId: req.user._id,
      followed: true
    });
    
    if (followedInteractions.length === 0) {
      return res.json([]);
    }

    // Extract novel IDs
    const novelIds = followedInteractions.map(interaction => interaction.novelId);
    
    // Find all novels that are followed
    const novels = await mongoose.model('Novel').find(
      { _id: { $in: novelIds } },
      { _id: 1, title: 1, illustration: 1 }
    );
    
    // Then fetch the latest chapter for each novel
    const followsWithDetails = await Promise.all(
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

    return res.json(followsWithDetails);
  } catch (error) {
    console.error('Follows fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch follows', error: error.message });
  }
});

/**
 * Block a user
 * @route POST /api/users/:username/block
 */
router.post('/:displayNameSlug/block', auth, async (req, res) => {
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
router.delete('/:displayNameSlug/block/:blockedUsername', auth, async (req, res) => {
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
router.get('/:displayNameSlug/blocked', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to view blocked users' });
    }
    
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
    const user = await getCachedUserByUsername(req.params.username);
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

/**
 * Get user by ObjectId (Admin/Moderator/Project User only)
 * @route GET /api/users/id/:userId
 */
router.get('/id/:userId', auth, async (req, res) => {
  try {
    // Check if user has admin, moderator, or pj_user privileges
    if (req.user.role !== 'admin' && req.user.role !== 'moderator' && req.user.role !== 'pj_user') {
      return res.status(403).json({ message: 'Access denied. Admin, moderator, or project user privileges required.' });
    }

    const { userId } = req.params;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    
    // Find user by ObjectId
    const user = await User.findById(userId)
      .select('username displayName avatar balance role');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user by ID error:', error);
    res.status(500).json({ message: 'Failed to get user' });
  }
});

/**
 * Get user's public profile (no authentication required)
 * @route GET /api/users/:displayNameSlug/public-profile
 */
router.get('/:displayNameSlug/public-profile', async (req, res) => {
  try {
    const displayNameSlug = req.params.displayNameSlug;
    
    // Resolve user by display name slug
    const user = await resolveUserByDisplayName(displayNameSlug);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Return only public information
    const publicProfile = {
      _id: user._id,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      role: user.role,
      intro: user.intro || '',
      interests: user.interests || [],
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      isVerified: user.isVerified || false,
      visitors: user.visitors || { total: 0 }
    };
    
    res.json(publicProfile);

    // Increment visitor count after sending response (non-blocking)
    // Skip visitor tracking if requested (similar to novel view tracking)
    if (req.query.skipVisitorTracking !== 'true') {
      // Find the full document (not lean) and use the model method
      User.findById(user._id)
        .then(fullUser => {
          if (fullUser) {
            return fullUser.incrementVisitors();
          }
        })
        .catch(err => console.error('Error updating visitor count:', err));
    }
  } catch (err) {
    console.error('Error getting user public profile:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * @route GET /api/users/admin-task-count
 * @desc Get count of pending admin tasks (pending posts + pending reports)
 * @access Private/Admin/Moderator
 */
router.get('/admin-task-count', auth, async (req, res) => {
  try {
    // Check if user is admin or moderator
    if (!['admin', 'moderator'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied. Admin/Moderator only.' });
    }

    // Count pending forum posts and pending reports in parallel
    const [pendingPostsCount, pendingReportsCount] = await Promise.all([
      ForumPost.countDocuments({ isPending: true }),
      Report.countDocuments({ status: 'pending' })
    ]);

    const totalCount = pendingPostsCount + pendingReportsCount;

    res.json({
      totalCount,
      pendingPosts: pendingPostsCount,
      pendingReports: pendingReportsCount
    });
  } catch (error) {
    console.error('Error fetching admin task count:', error);
    res.status(500).json({ message: 'Server error' });
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

    // Clear all user caches when data changes
    clearAllUserCaches(user);

    res.json(user);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Helper function to escape regex special characters
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Helper function to normalize text by removing diacritics/accents
const normalizeText = (text) => {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
};

// User resolution cache to prevent duplicate queries
const userResolutionCache = new Map();
const allUsersCache = { data: null, timestamp: 0 };
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const ALL_USERS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes for all users query

// Clear expired cache entries
const clearExpiredUserCache = () => {
  const now = Date.now();
  for (const [key, value] of userResolutionCache.entries()) {
    if (now - value.timestamp > USER_CACHE_TTL) {
      userResolutionCache.delete(key);
    }
  }
};

// Get all users with caching
const getAllUsersBasicInfo = async () => {
  const now = Date.now();
  
  // Check if cached data is still valid
  if (allUsersCache.data && (now - allUsersCache.timestamp) < ALL_USERS_CACHE_TTL) {
    return allUsersCache.data;
  }
  
  // Fetch fresh data
  const users = await User.find({}).select('username displayName').lean();
  
  // Update cache
  allUsersCache.data = users;
  allUsersCache.timestamp = now;
  
  return users;
};

// Helper function to resolve display name slug to user with caching
const resolveUserByDisplayName = async (displayNameSlug) => {
  // Check cache first
  const cacheKey = `user_${displayNameSlug.toLowerCase()}`;
  const cached = userResolutionCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < USER_CACHE_TTL) {
    return cached.user;
  }

  // Clear expired entries periodically
  if (userResolutionCache.size > 100) {
    clearExpiredUserCache();
  }

  // Convert URL slug back to potential display name variations
  const potentialDisplayNames = [
    displayNameSlug,
    displayNameSlug.replace(/-/g, ' '), // Replace hyphens with spaces
    displayNameSlug.replace(/-/g, ''),  // Remove hyphens entirely
  ];
  
  // First try exact matches (original behavior)
  for (const displayName of potentialDisplayNames) {
    const user = await User.findOne({ 
      displayName: { $regex: new RegExp(`^${escapeRegex(displayName)}$`, 'i') }
    }).select('-password');
    
    if (user) {
      // Cache the result
      userResolutionCache.set(cacheKey, {
        user,
        timestamp: Date.now()
      });
      return user;
    }
  }
  
  // If no exact match, try normalized search (without diacritics)
  const normalizedSlug = normalizeText(displayNameSlug);
  
  // Get all users and check normalized versions of their displayNames (using cached version)
  const allUsers = await getAllUsersBasicInfo();
  
  for (const user of allUsers) {
    if (user.displayName && normalizeText(user.displayName) === normalizedSlug) {
      // Return the full user object without password
      const fullUser = await User.findById(user._id).select('-password');
      // Cache the result
      userResolutionCache.set(cacheKey, {
        user: fullUser,
        timestamp: Date.now()
      });
      return fullUser;
    }
    if (user.username && normalizeText(user.username) === normalizedSlug) {
      // Return the full user object without password
      const fullUser = await User.findById(user._id).select('-password');
      // Cache the result
      userResolutionCache.set(cacheKey, {
        user: fullUser,
        timestamp: Date.now()
      });
      return fullUser;
    }
  }
  
  // Cache null result to prevent repeated lookups
  userResolutionCache.set(cacheKey, {
    user: null,
    timestamp: Date.now()
  });
  
  return null;
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

/**
 * Get user's ongoing modules
 * @route GET /api/users/:displayNameSlug/ongoing-modules
 */
router.get('/:displayNameSlug/ongoing-modules', async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get user's ongoing modules (publicly viewable)
    const user = await User.findById(targetUser._id)
      .populate({
        path: 'ongoingModules.moduleId',
        populate: {
          path: 'novelId',
          select: 'title illustration'
        }
      });

    const ongoingModules = user.ongoingModules || [];
    res.json(ongoingModules);
  } catch (error) {
    console.error('Error fetching ongoing modules:', error);
    res.status(500).json({ message: 'Failed to fetch ongoing modules' });
  }
});

/**
 * Get user's completed modules
 * @route GET /api/users/:displayNameSlug/completed-modules
 */
router.get('/:displayNameSlug/completed-modules', async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get user's completed modules (publicly viewable)
    const user = await User.findById(targetUser._id)
      .populate({
        path: 'completedModules.moduleId',
        populate: {
          path: 'novelId',
          select: 'title illustration'
        }
      });

    const completedModules = user.completedModules || [];
    res.json(completedModules);
  } catch (error) {
    console.error('Error fetching completed modules:', error);
    res.status(500).json({ message: 'Failed to fetch completed modules' });
  }
});

/**
 * Add module to ongoing
 * @route POST /api/users/:displayNameSlug/ongoing-modules
 */
router.post('/:displayNameSlug/ongoing-modules', auth, async (req, res) => {
  try {
    // Resolve user by display name slug and get user data in one query
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to add ongoing modules' });
    }

    const { moduleId } = req.body;
    
    // Validate moduleId
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: 'Invalid module ID' });
    }

    // Get user with current modules and check if module exists in one aggregation
    const [userWithModules, moduleExists] = await Promise.all([
      User.findById(req.user._id).lean(),
      mongoose.model('Module').exists({ _id: moduleId })
    ]);

    if (!moduleExists) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Check if module is already in ongoing list
    const isAlreadyOngoing = userWithModules.ongoingModules?.some(
      item => item.moduleId.toString() === moduleId
    );

    if (isAlreadyOngoing) {
      return res.json({ 
        message: 'Module is already in ongoing list',
        alreadyExists: true 
      });
    }

    // Add to user's ongoing modules and remove from completed if it exists there
    await User.findByIdAndUpdate(
      req.user._id,
      {
        $push: {
          ongoingModules: {
            $each: [{
              moduleId: moduleId,
              addedAt: new Date()
            }],
            $position: 0
          }
        },
        // Remove from completed if it exists there
        $pull: {
          completedModules: { moduleId: moduleId }
        }
      }
    );

    res.json({ message: 'Module added to ongoing successfully' });
  } catch (error) {
    console.error('Error adding ongoing module:', error);
    res.status(500).json({ message: 'Failed to add ongoing module' });
  }
});

/**
 * Add module to completed
 * @route POST /api/users/:displayNameSlug/completed-modules
 */
router.post('/:displayNameSlug/completed-modules', auth, async (req, res) => {
  try {
    // Resolve user by display name slug and get user data in one query
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to add completed modules' });
    }

    const { moduleId } = req.body;
    
    // Validate moduleId
    if (!mongoose.Types.ObjectId.isValid(moduleId)) {
      return res.status(400).json({ message: 'Invalid module ID' });
    }

    // Get user with current modules and check if module exists in one aggregation
    const [userWithModules, moduleExists] = await Promise.all([
      User.findById(req.user._id).lean(),
      mongoose.model('Module').exists({ _id: moduleId })
    ]);

    if (!moduleExists) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Check if module is already in completed list
    const isAlreadyCompleted = userWithModules.completedModules?.some(
      item => item.moduleId.toString() === moduleId
    );

    if (isAlreadyCompleted) {
      return res.json({ 
        message: 'Module is already in completed list',
        alreadyExists: true 
      });
    }

    // Add to user's completed modules and remove from ongoing if it exists there
    await User.findByIdAndUpdate(
      req.user._id,
      {
        $push: {
          completedModules: {
            $each: [{
              moduleId: moduleId,
              addedAt: new Date()
            }],
            $position: 0
          }
        },
        // Remove from ongoing if it exists there
        $pull: {
          ongoingModules: { moduleId: moduleId }
        }
      }
    );

    res.json({ message: 'Module added to completed successfully' });
  } catch (error) {
    console.error('Error adding completed module:', error);
    res.status(500).json({ message: 'Failed to add completed module' });
  }
});

/**
 * Remove module from ongoing (updated endpoint)
 * @route DELETE /api/users/id/:userId/ongoing-modules/:moduleId
 */
router.delete('/id/:userId/ongoing-modules/:moduleId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const moduleId = req.params.moduleId;
    
    // Only allow users to manage their own modules or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to manage modules' });
    }

    await User.findByIdAndUpdate(userId, {
      $pull: { ongoingModules: { moduleId: moduleId } }
    });

    // Clear user stats cache since module data changed
    clearUserStatsCache(userId);

    res.json({ message: 'Module removed from ongoing successfully' });
  } catch (error) {
    console.error('Error removing ongoing module:', error);
    res.status(500).json({ message: 'Failed to remove ongoing module' });
  }
});

/**
 * Remove module from completed (updated endpoint)
 * @route DELETE /api/users/id/:userId/completed-modules/:moduleId
 */
router.delete('/id/:userId/completed-modules/:moduleId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const moduleId = req.params.moduleId;
    
    // Only allow users to manage their own modules or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to manage modules' });
    }

    await User.findByIdAndUpdate(userId, {
      $pull: { completedModules: { moduleId: moduleId } }
    });

    // Clear user stats cache since module data changed
    clearUserStatsCache(userId);

    res.json({ message: 'Module removed from completed successfully' });
  } catch (error) {
    console.error('Error removing completed module:', error);
    res.status(500).json({ message: 'Failed to remove completed module' });
  }
});

/**
 * Reorder ongoing modules
 * @route PUT /api/users/:displayNameSlug/ongoing-modules/reorder
 */
router.put('/:displayNameSlug/ongoing-modules/reorder', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to reorder ongoing modules' });
    }

    const { moduleIds } = req.body;
    
    if (!Array.isArray(moduleIds)) {
      return res.status(400).json({ message: 'Module IDs must be an array' });
    }

    // Get current user with modules
    const user = await User.findById(req.user._id);
    
    // Reorder the ongoing modules based on the new order
    const reorderedModules = moduleIds.map(moduleId => {
      const existingModule = user.ongoingModules.find(
        item => item.moduleId.toString() === moduleId
      );
      return existingModule;
    }).filter(Boolean);

    // Update user's ongoing modules with new order
    await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          ongoingModules: reorderedModules
        }
      }
    );

    res.json({ message: 'Ongoing modules reordered successfully' });
  } catch (error) {
    console.error('Error reordering ongoing modules:', error);
    res.status(500).json({ message: 'Failed to reorder ongoing modules' });
  }
});

/**
 * Reorder completed modules
 * @route PUT /api/users/:displayNameSlug/completed-modules/reorder
 */
router.put('/:displayNameSlug/completed-modules/reorder', auth, async (req, res) => {
  try {
    // Resolve user by display name slug
    const targetUser = await resolveUserByDisplayName(req.params.displayNameSlug);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the resolved user matches the authenticated user
    if (req.user.username !== targetUser.username) {
      return res.status(403).json({ message: 'Not authorized to reorder completed modules' });
    }

    const { moduleIds } = req.body;
    
    if (!Array.isArray(moduleIds)) {
      return res.status(400).json({ message: 'Module IDs must be an array' });
    }

    // Get current user with modules
    const user = await User.findById(req.user._id);
    
    // Reorder the completed modules based on the new order
    const reorderedModules = moduleIds.map(moduleId => {
      const existingModule = user.completedModules.find(
        item => item.moduleId.toString() === moduleId
      );
      return existingModule;
    }).filter(Boolean);

    // Update user's completed modules with new order
    await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          completedModules: reorderedModules
        }
      }
    );

    res.json({ message: 'Completed modules reordered successfully' });
  } catch (error) {
    console.error('Error reordering completed modules:', error);
    res.status(500).json({ message: 'Failed to reorder completed modules' });
  }
});

/**
 * Check if user has novel-specific roles (translator, editor, proofreader)
 * @route GET /api/users/id/:userId/novel-roles
 */
router.get('/id/:userId/novel-roles', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Only allow users to check their own novel roles or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to view novel roles' });
    }

    // Check if user has any novel-specific roles
    const novels = await Novel.find({
      $or: [
        { 'active.translator': userId },
        { 'active.editor': userId },
        { 'active.proofreader': userId }
      ]
    }).select('_id').lean();

    const hasNovelRoles = novels.length > 0;
    
    res.json({ hasNovelRoles });
  } catch (error) {
    console.error('Error checking novel roles:', error);
    res.status(500).json({ message: 'Failed to check novel roles' });
  }
});

/**
 * Check if user has novel-specific roles - public endpoint for verification badges
 * @route GET /api/users/id/:userId/novel-roles-public
 */
router.get('/id/:userId/novel-roles-public', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    // Check if user has any novel-specific roles
    const novels = await Novel.find({
      $or: [
        { 'active.translator': userId },
        { 'active.editor': userId },
        { 'active.proofreader': userId }
      ]
    }).select('_id').lean();

    const hasNovelRoles = novels.length > 0;
    
    res.json({ hasNovelRoles });
  } catch (error) {
    console.error('Error checking novel roles:', error);
    res.status(500).json({ message: 'Failed to check novel roles' });
  }
});

/**
 * Get user's role-based modules (auto-populated based on novel roles + user preferences)
 * 
 * PERFORMANCE OPTIMIZATION NOTES:
 * This endpoint uses a single aggregation pipeline to minimize database queries.
 * Ensure these indexes exist for optimal performance:
 * 
 * Novel collection:
 * - db.novels.createIndex({ "active.pj_user": 1 })
 * - db.novels.createIndex({ "active.translator": 1 })
 * - db.novels.createIndex({ "active.editor": 1 })
 * - db.novels.createIndex({ "active.proofreader": 1 })
 * 
 * Module collection:
 * - db.modules.createIndex({ "novelId": 1 })
 * 
 * User collection:
 * - db.users.createIndex({ "_id": 1 })
 * - db.users.createIndex({ "ongoingModules.moduleId": 1 })
 * - db.users.createIndex({ "completedModules.moduleId": 1 })
 * 
 * @route GET /api/users/id/:userId/role-modules
 * @query {boolean} autoAddNew - Whether to auto-add new modules to ongoing (default: false)
 */
router.get('/id/:userId/role-modules', async (req, res) => {
  try {
    const userId = req.params.userId;
    const autoAddNew = req.query.autoAddNew === 'true';
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    // Use aggregation pipeline to get all data in one query
    const result = await User.aggregate([
      // Match the specific user
      { $match: { _id: new mongoose.Types.ObjectId(userId) } },
      
      // Add a field to perform the novel lookup
      { $addFields: { userId: { $toString: "$_id" } } },
      
      // Lookup novels where user has roles
      {
        $lookup: {
          from: 'novels',
          let: { userId: '$userId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $in: ['$$userId', '$active.pj_user'] },
                    { $in: ['$$userId', '$active.translator'] },
                    { $in: ['$$userId', '$active.editor'] },
                    { $in: ['$$userId', '$active.proofreader'] }
                  ]
                }
              }
            },
            { $project: { _id: 1 } }
          ],
          as: 'userNovels'
        }
      },
      
      // Lookup all modules from user's novels
      {
        $lookup: {
          from: 'modules',
          let: { novelIds: '$userNovels._id' },
          pipeline: [
            { $match: { $expr: { $in: ['$novelId', '$$novelIds'] } } },
            {
              $lookup: {
                from: 'novels',
                localField: 'novelId',
                foreignField: '_id',
                as: 'novelId',
                pipeline: [{ $project: { title: 1, illustration: 1 } }]
              }
            },
            { $unwind: '$novelId' }
          ],
          as: 'roleModules'
        }
      },
      
      // Lookup existing ongoing modules with novel data
      {
        $lookup: {
          from: 'modules',
          let: { moduleIds: '$ongoingModules.moduleId' },
          pipeline: [
            { $match: { $expr: { $in: ['$_id', '$$moduleIds'] } } },
            {
              $lookup: {
                from: 'novels',
                localField: 'novelId',
                foreignField: '_id',
                as: 'novelId',
                pipeline: [{ $project: { title: 1, illustration: 1 } }]
              }
            },
            { $unwind: '$novelId' }
          ],
          as: 'existingOngoingModules'
        }
      },
      
      // Lookup existing completed modules with novel data
      {
        $lookup: {
          from: 'modules',
          let: { moduleIds: '$completedModules.moduleId' },
          pipeline: [
            { $match: { $expr: { $in: ['$_id', '$$moduleIds'] } } },
            {
              $lookup: {
                from: 'novels',
                localField: 'novelId',
                foreignField: '_id',
                as: 'novelId',
                pipeline: [{ $project: { title: 1, illustration: 1 } }]
              }
            },
            { $unwind: '$novelId' }
          ],
          as: 'existingCompletedModules'
        }
      },
      
      // Project final result
      {
        $project: {
          _id: 1,
          ongoingModules: {
            $map: {
              input: '$ongoingModules',
              as: 'ongoing',
              in: {
                moduleId: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: '$existingOngoingModules',
                        cond: { $eq: ['$$this._id', '$$ongoing.moduleId'] }
                      }
                    },
                    0
                  ]
                },
                addedAt: '$$ongoing.addedAt'
              }
            }
          },
          completedModules: {
            $map: {
              input: '$completedModules',
              as: 'completed',
              in: {
                moduleId: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: '$existingCompletedModules',
                        cond: { $eq: ['$$this._id', '$$completed.moduleId'] }
                      }
                    },
                    0
                  ]
                },
                addedAt: '$$completed.addedAt'
              }
            }
          },
          newModules: {
            $filter: {
              input: '$roleModules',
              cond: {
                $not: {
                  $in: [
                    '$$this._id',
                    {
                      $concatArrays: [
                        { $ifNull: ['$ongoingModules.moduleId', []] },
                        { $ifNull: ['$completedModules.moduleId', []] }
                      ]
                    }
                  ]
                }
              }
            }
          }
        }
      }
    ]);

    if (!result || result.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = result[0];
    
    // Filter out null modules from existing lists
    const existingOngoingModules = userData.ongoingModules.filter(item => item.moduleId);
    const existingCompletedModules = userData.completedModules.filter(item => item.moduleId);

    // If autoAddNew is true, we need to persist the new modules to the database
    if (autoAddNew && userData.newModules.length > 0) {
      const newModulesToAdd = userData.newModules.map(module => ({
        moduleId: module._id,
        addedAt: new Date()
      }));

      // Add new modules to the user's ongoing modules in the database
      await User.findByIdAndUpdate(userId, {
        $push: {
          ongoingModules: { 
            $each: newModulesToAdd,
            $position: 0
          }
        }
      });

      // Clear user stats cache since module data changed
      clearUserStatsCache(userId);
      
      // Also clear complete profile cache
      const user = await User.findById(userId).select('userNumber');
      if (user) {
        clearUserStatsCache(`complete_profile_${user.userNumber}`);
      }

      // Re-run the aggregation to get the updated data including the newly added modules
      const updatedResult = await User.aggregate([
        // Match the specific user
        { $match: { _id: new mongoose.Types.ObjectId(userId) } },
        
        // Add a field to perform the novel lookup
        { $addFields: { userId: { $toString: "$_id" } } },
        
        // Lookup existing ongoing modules with novel data
        {
          $lookup: {
            from: 'modules',
            let: { moduleIds: '$ongoingModules.moduleId' },
            pipeline: [
              { $match: { $expr: { $in: ['$_id', '$$moduleIds'] } } },
              {
                $lookup: {
                  from: 'novels',
                  localField: 'novelId',
                  foreignField: '_id',
                  as: 'novelId',
                  pipeline: [{ $project: { title: 1, illustration: 1 } }]
                }
              },
              { $unwind: '$novelId' }
            ],
            as: 'existingOngoingModules'
          }
        },
        
        // Lookup existing completed modules with novel data
        {
          $lookup: {
            from: 'modules',
            let: { moduleIds: '$completedModules.moduleId' },
            pipeline: [
              { $match: { $expr: { $in: ['$_id', '$$moduleIds'] } } },
              {
                $lookup: {
                  from: 'novels',
                  localField: 'novelId',
                  foreignField: '_id',
                  as: 'novelId',
                  pipeline: [{ $project: { title: 1, illustration: 1 } }]
                }
              },
              { $unwind: '$novelId' }
            ],
            as: 'existingCompletedModules'
          }
        },
        
        // Project final result
        {
          $project: {
            _id: 1,
            ongoingModules: {
              $map: {
                input: '$ongoingModules',
                as: 'ongoing',
                in: {
                  moduleId: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: '$existingOngoingModules',
                          cond: { $eq: ['$$this._id', '$$ongoing.moduleId'] }
                        }
                      },
                      0
                    ]
                  },
                  addedAt: '$$ongoing.addedAt'
                }
              }
            },
            completedModules: {
              $map: {
                input: '$completedModules',
                as: 'completed',
                in: {
                  moduleId: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: '$existingCompletedModules',
                          cond: { $eq: ['$$this._id', '$$completed.moduleId'] }
                        }
                      },
                      0
                    ]
                  },
                  addedAt: '$$completed.addedAt'
                }
              }
            }
          }
        }
      ]);

      if (updatedResult && updatedResult.length > 0) {
        const updatedUserData = updatedResult[0];
        
        // Filter out null modules from updated lists
        const updatedOngoingModules = updatedUserData.ongoingModules.filter(item => item.moduleId);
        const updatedCompletedModules = updatedUserData.completedModules.filter(item => item.moduleId);

        res.json({
          ongoingModules: updatedOngoingModules,
          completedModules: updatedCompletedModules,
          newModulesCount: userData.newModules.length
        });
      } else {
        // Fallback if the updated aggregation fails
        res.json({
          ongoingModules: existingOngoingModules,
          completedModules: existingCompletedModules,
          newModulesCount: userData.newModules.length
        });
      }
    } else {
      // Normal case - just return existing modules without adding new ones
      res.json({
        ongoingModules: existingOngoingModules,
        completedModules: existingCompletedModules,
        newModulesCount: userData.newModules.length // Include count for refresh button
      });
    }

  } catch (error) {
    console.error('Error fetching role-based modules:', error);
    res.status(500).json({ message: 'Failed to fetch role-based modules' });
  }
});

/**
 * Move module from ongoing to completed
 * @route POST /api/users/id/:userId/move-module-to-completed
 */
router.post('/id/:userId/move-module-to-completed', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { moduleId } = req.body;
    
    // Only allow users to manage their own modules or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to manage modules' });
    }

    await User.findByIdAndUpdate(userId, {
      $pull: { ongoingModules: { moduleId: moduleId } },
      $push: { 
        completedModules: { 
          $each: [{ 
            moduleId: moduleId, 
            addedAt: new Date() 
          }],
          $position: 0
        } 
      }
    });

    // Clear user stats cache since module data changed
    clearUserStatsCache(userId);
    
    // Also clear complete profile cache
    const user = await User.findById(userId).select('userNumber');
    if (user) {
      clearUserStatsCache(`complete_profile_${user.userNumber}`);
    }

    res.json({ message: 'Module moved to completed successfully' });
  } catch (error) {
    console.error('Error moving module to completed:', error);
    res.status(500).json({ message: 'Failed to move module to completed' });
  }
});

/**
 * Move module from completed to ongoing
 * @route POST /api/users/id/:userId/move-module-to-ongoing
 */
router.post('/id/:userId/move-module-to-ongoing', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { moduleId } = req.body;
    
    // Only allow users to manage their own modules or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to manage modules' });
    }

    await User.findByIdAndUpdate(userId, {
      $pull: { completedModules: { moduleId: moduleId } },
      $push: { 
        ongoingModules: { 
          $each: [{ 
            moduleId: moduleId, 
            addedAt: new Date() 
          }],
          $position: 0
        } 
      }
    });

    // Clear user stats cache since module data changed
    clearUserStatsCache(userId);
    
    // Also clear complete profile cache
    const user = await User.findById(userId).select('userNumber');
    if (user) {
      clearUserStatsCache(`complete_profile_${user.userNumber}`);
    }

    res.json({ message: 'Module moved to ongoing successfully' });
  } catch (error) {
    console.error('Error moving module to ongoing:', error);
    res.status(500).json({ message: 'Failed to move module to ongoing' });
  }
});

/**
 * Reorder ongoing modules
 * @route PUT /api/users/id/:userId/reorder-ongoing-modules
 */
router.put('/id/:userId/reorder-ongoing-modules', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { moduleIds } = req.body;
    
    // Only allow users to manage their own modules or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to manage modules' });
    }

    // Get current user
    const user = await User.findById(userId);
    
    // Reorder based on moduleIds array
    const reorderedModules = moduleIds.map(moduleId => {
      const existingModule = user.ongoingModules.find(
        item => item.moduleId.toString() === moduleId
      );
      return existingModule;
    }).filter(Boolean);

    await User.findByIdAndUpdate(userId, {
      $set: { ongoingModules: reorderedModules }
    });

    // Clear user stats cache since module order changed
    clearUserStatsCache(userId);

    res.json({ message: 'Ongoing modules reordered successfully' });
  } catch (error) {
    console.error('Error reordering ongoing modules:', error);
    res.status(500).json({ message: 'Failed to reorder ongoing modules' });
  }
});

/**
 * Reorder completed modules
 * @route PUT /api/users/id/:userId/reorder-completed-modules
 */
router.put('/id/:userId/reorder-completed-modules', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { moduleIds } = req.body;
    
    // Only allow users to manage their own modules or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to manage modules' });
    }

    // Get current user
    const user = await User.findById(userId);
    
    // Reorder based on moduleIds array
    const reorderedModules = moduleIds.map(moduleId => {
      const existingModule = user.completedModules.find(
        item => item.moduleId.toString() === moduleId
      );
      return existingModule;
    }).filter(Boolean);

    await User.findByIdAndUpdate(userId, {
      $set: { completedModules: reorderedModules }
    });

    // Clear user stats cache since module order changed
    clearUserStatsCache(userId);

    res.json({ message: 'Completed modules reordered successfully' });
  } catch (error) {
    console.error('Error reordering completed modules:', error);
    res.status(500).json({ message: 'Failed to reorder completed modules' });
  }
});

/**
 * Update user interests
 * @route PUT /api/users/id/:userId/interests
 */
router.put('/id/:userId/interests', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { interests } = req.body;
    
    // Only allow users to update their own interests or admins
    if (req.user._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update interests' });
    }

    // Validate interests array
    if (!Array.isArray(interests)) {
      return res.status(400).json({ message: 'Interests must be an array' });
    }

    if (interests.length > 20) {
      return res.status(400).json({ message: 'Cannot have more than 20 interests' });
    }

    // Validate each interest
    for (const interest of interests) {
      if (typeof interest !== 'string' || interest.trim().length === 0) {
        return res.status(400).json({ message: 'Each interest must be a non-empty string' });
      }
      if (interest.length > 40) {
        return res.status(400).json({ message: 'Each interest must be 40 characters or less' });
      }
    }

    // Remove duplicates and trim whitespace
    const cleanedInterests = [...new Set(interests.map(interest => interest.trim()))];

    await User.findByIdAndUpdate(userId, {
      interests: cleanedInterests
    });

    // Clear user resolution cache since user data changed
    clearUserResolutionCache(userId);
    
    // Also clear complete profile cache
    const user = await User.findById(userId).select('userNumber');
    if (user) {
      clearUserStatsCache(`complete_profile_${user.userNumber}`);
    }

    res.json({ 
      message: 'Interests updated successfully',
      interests: cleanedInterests
    });
  } catch (error) {
    console.error('Error updating interests:', error);
    res.status(500).json({ message: 'Failed to update interests' });
  }
});

// Clear user resolution cache when user data changes
const clearUserResolutionCache = (userId = null) => {
  if (userId) {
    // Clear specific user entries - we need to iterate since cache keys are by displayName/username
    for (const [key, value] of userResolutionCache.entries()) {
      if (value.user && value.user._id.toString() === userId.toString()) {
        userResolutionCache.delete(key);
      }
    }
  } else {
    // Clear all entries
    userResolutionCache.clear();
  }
  
  // Also clear the all users cache since user data changed
  allUsersCache.data = null;
  allUsersCache.timestamp = 0;
};

// Export cache clearing function for use by other routes
export { clearUserStatsCache, clearUserResolutionCache };

/**
 * Get consolidated user settings data (optimized single query)
 * @route GET /api/users/number/:userNumber/settings-data
 */
router.get('/number/:userNumber/settings-data', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }

    // Check if user has admin/moderator role for reports access
    const isAdminOrMod = req.user.role === 'admin' || req.user.role === 'moderator';
    
    // Use aggregation to get all required data in one query
    const [userData] = await User.aggregate([
      // Match the user by userNumber
      { $match: { userNumber } },
      
      // Add fields for notifications count
      {
        $lookup: {
          from: 'notifications',
          let: { userId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$userId'] },
                    { $eq: ['$isRead', false] }
                  ]
                }
              }
            },
            { $count: 'unreadCount' }
          ],
          as: 'notificationsCount'
        }
      },
      
      // Add banned users lookup if user is admin
      ...(req.user.role === 'admin' ? [{
        $lookup: {
          from: 'users',
          pipeline: [
            { $match: { isBanned: true } },
            { $project: { username: 1, displayName: 1, avatar: 1 } }
          ],
          as: 'bannedUsers'
        }
      }] : []),
      
      // Add pending reports lookup if admin/moderator
      ...(isAdminOrMod ? [{
        $lookup: {
          from: 'reports',
          pipeline: [
            { $match: { status: 'pending' } },
            { $sort: { createdAt: -1 } }
          ],
          as: 'pendingReports'
        }
      }] : []),
      
      // Add blocked users lookup
      {
        $lookup: {
          from: 'users',
          let: { blockedUserIds: '$blockedUsers' },
          pipeline: [
            { $match: { $expr: { $in: ['$_id', '$$blockedUserIds'] } } },
            { $project: { username: 1, displayName: 1, avatar: 1 } }
          ],
          as: 'blockedUsers'
        }
      },
      
      // Project only needed fields
      {
        $project: {
          _id: 1,
          username: 1,
          displayName: 1,
          email: 1,
          avatar: 1,
          displayNameLastChanged: 1,
          role: 1,
          unreadNotifications: { 
            $arrayElemAt: ['$notificationsCount.unreadCount', 0] 
          },
          bannedUsers: req.user.role === 'admin' ? '$bannedUsers' : '$$REMOVE',
          pendingReports: isAdminOrMod ? '$pendingReports' : '$$REMOVE',
          blockedUsers: '$blockedUsers'
        }
      }
    ]);

    if (!userData) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== userData._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to view these settings' });
    }

    res.json(userData);
  } catch (error) {
    console.error('Error fetching settings data:', error);
    res.status(500).json({ message: 'Failed to fetch settings data' });
  }
});

/**
 * Get user's public profile by userNumber (no authentication required)
 * @route GET /api/users/number/:userNumber/public-profile
 */
router.get('/number/:userNumber/public-profile', async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const user = await User.findOne({ userNumber }).select('-password');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Return only public information
    const publicProfile = {
      _id: user._id,
      username: user.username,
      displayName: user.displayName,
      userNumber: user.userNumber,
      avatar: user.avatar,
      role: user.role,
      intro: user.intro || '',
      interests: user.interests || [],
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      isVerified: user.isVerified || false,
      visitors: user.visitors || { total: 0 }
    };
    
    res.json(publicProfile);

    // Increment visitor count after sending response (non-blocking)
    // Skip visitor tracking if requested (similar to novel view tracking)
    if (req.query.skipVisitorTracking !== 'true') {
      // Find the full document (not lean) and use the model method
      User.findById(user._id)
        .then(fullUser => {
          if (fullUser) {
            return fullUser.incrementVisitors();
          }
        })
        .catch(err => console.error('Error updating visitor count:', err));
    }
  } catch (err) {
    console.error('Error getting user public profile:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get user's complete profile with stats by userNumber (optimized single call)
 * @route GET /api/users/number/:userNumber/public-profile-complete
 */
router.get('/number/:userNumber/public-profile-complete', async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Check cache first (5 minute cache for profile data)
    const cacheKey = `complete_profile_${userNumber}`;
    const cachedProfile = getCachedUserStats(cacheKey);
    if (cachedProfile) {
      return res.json(cachedProfile);
    }
    
    // Find user by userNumber
    const user = await User.findOne({ userNumber }).select('-password');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Execute all queries in parallel for maximum performance
    const [
      userModulesResult,
      chaptersParticipated,
      followingCount,
      commentsCount
    ] = await Promise.all([
      // Get user modules using direct population (more reliable than complex aggregation)
      User.findById(user._id)
        .populate({
          path: 'ongoingModules.moduleId',
          populate: {
            path: 'novelId',
            select: 'title illustration'
          }
        })
        .populate({
          path: 'completedModules.moduleId',
          populate: {
            path: 'novelId',
            select: 'title illustration'
          }
        })
        .then(populatedUser => {
          if (!populatedUser) {
            return { ongoingModules: [], completedModules: [] };
          }
          
          return {
            ongoingModules: populatedUser.ongoingModules || [],
            completedModules: populatedUser.completedModules || []
          };
        }),
      
      // Get chapters participated count
      Chapter.countDocuments({
        $or: [
          { translator: { $in: [user._id.toString(), user.username, user.displayName] } },
          { editor: { $in: [user._id.toString(), user.username, user.displayName] } },
          { proofreader: { $in: [user._id.toString(), user.username, user.displayName] } }
        ]
      }),
      
      // Get following count
      UserNovelInteraction.countDocuments({ 
        userId: user._id, 
        followed: true 
      }),
      
      // Get comments count
      Comment.countDocuments({ 
        user: user._id, 
        isDeleted: { $ne: true }, 
        adminDeleted: { $ne: true }
      })
    ]);

    // Process modules data (now comes directly from populate, not aggregation)
    const moduleData = userModulesResult || { ongoingModules: [], completedModules: [] };
    const ongoingModules = moduleData.ongoingModules.filter(item => item.moduleId);
    const completedModules = moduleData.completedModules.filter(item => item.moduleId);

    // Return complete profile with all stats
    const completeProfile = {
      // User basic info
      _id: user._id,
      username: user.username,
      displayName: user.displayName,
      userNumber: user.userNumber,
      avatar: user.avatar,
      role: user.role,
      intro: user.intro || '',
      interests: user.interests || [],
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      isVerified: user.isVerified || false,
      visitors: user.visitors || { total: 0 },
      
      // User stats
      stats: {
        chaptersParticipated: chaptersParticipated || 0,
        followingCount: followingCount || 0,
        commentsCount: commentsCount || 0,
        ongoingModules: ongoingModules,
        completedModules: completedModules
      }
    };
    
    // Cache the result for 5 minutes
    setCachedUserStats(cacheKey, completeProfile);
    
    res.json(completeProfile);

    // Increment visitor count after sending response (non-blocking)
    if (req.query.skipVisitorTracking !== 'true') {
      User.findById(user._id)
        .then(fullUser => {
          if (fullUser) {
            return fullUser.incrementVisitors();
          }
        })
        .catch(err => console.error('Error updating visitor count:', err));
    }
  } catch (err) {
    console.error('Error getting complete user profile:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Update user's avatar by userNumber
 * @route POST /api/users/number/:userNumber/avatar
 */
router.post('/number/:userNumber/avatar', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { avatar } = req.body;
    if (!avatar) {
      return res.status(400).json({ message: 'No avatar URL provided' });
    }

    // Update user's avatar in database
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { avatar },
      { new: true }
    ).select('-password');

    // Clear all user caches after avatar update
    clearAllUserCaches(user);

    res.json({ avatar: user.avatar });
  } catch (error) {
    console.error('Avatar update error:', error);
    res.status(500).json({ message: 'Failed to update avatar' });
  }
});

/**
 * Update user's display name by userNumber
 * @route PUT /api/users/number/:userNumber/display-name
 */
router.put('/number/:userNumber/display-name', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
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

    // Update display name and timestamp - validation will be handled by the schema middleware
    user.displayName = displayName.trim();
    user.displayNameLastChanged = new Date();
    await user.save();

    res.json({ 
      displayName: user.displayName,
      displayNameLastChanged: user.displayNameLastChanged
    });
  } catch (error) {
    console.error('Display name update error:', error);
    let errorMessage = 'Failed to update display name';
    
    if (error.message.includes('đã tồn tại')) {
      errorMessage = error.message;
    } else if (error.message.includes('ký tự đặc biệt')) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ message: errorMessage });
  }
});

/**
 * Request email change by userNumber
 * @route PUT /api/users/number/:userNumber/email
 */
router.put('/number/:userNumber/email', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { email, currentPassword } = req.body;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Check if new email is the same as current email
    if (email.toLowerCase() === req.user.email.toLowerCase()) {
      return res.status(400).json({ message: 'New email must be different from current email' });
    }

    // Check if email is already in use BEFORE password verification
    const emailExists = await User.findOne({ email, _id: { $ne: req.user._id } });
    if (emailExists) {
      return res.status(400).json({ message: 'Email is already in use' });
    }

    // Get user with password
    const user = await User.findById(req.user._id);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Generate confirmation token
    const crypto = await import('crypto');
    const confirmationToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Store pending email change
    user.pendingEmailChange = {
      newEmail: email,
      token: confirmationToken,
      expires: expires
    };
    await user.save();

    // Send confirmation email to current email
    const { sendEmailChangeConfirmation } = await import('../services/emailService.js');
    await sendEmailChangeConfirmation(user.email, email, confirmationToken);

    res.json({ 
      message: 'Email change confirmation sent to your current email address',
      requiresConfirmation: true
    });
  } catch (error) {
    console.error('Email change request error:', error);
    res.status(500).json({ message: 'Failed to send email change confirmation' });
  }
});

/**
 * Update user's password by userNumber
 * @route PUT /api/users/number/:userNumber/password
 */
router.put('/number/:userNumber/password', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
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
 * Get blocked users list by userNumber
 * @route GET /api/users/number/:userNumber/blocked
 */
router.get('/number/:userNumber/blocked', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to view blocked users' });
    }
    
    const user = await User.findById(req.user._id)
      .populate('blockedUsers', 'username displayName avatar');
    
    res.json(user.blockedUsers);
  } catch (error) {
    console.error('Get blocked users error:', error);
    res.status(500).json({ message: 'Failed to get blocked users' });
  }
});

/**
 * Block a user by userNumber
 * @route POST /api/users/number/:userNumber/block
 */
router.post('/number/:userNumber/block', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to block users' });
    }

    const { userToBlock } = req.body;
    
    // Cannot block yourself
    if (req.user.username === userToBlock) {
      return res.status(400).json({ message: 'Cannot block yourself' });
    }

    // Find the user to block
    const userToBlockObj = await User.findOne({ username: userToBlock });
    if (!userToBlockObj) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get the current user
    const currentUser = await User.findById(req.user._id);
    
    // Check if already blocked
    if (currentUser.blockedUsers.includes(userToBlockObj._id)) {
      return res.status(400).json({ message: 'User is already blocked' });
    }

    // Check block limit
    if (currentUser.blockedUsers.length >= 50) {
      return res.status(400).json({ message: 'Cannot block more than 50 users' });
    }

    // Add to blocked users
    currentUser.blockedUsers.push(userToBlockObj._id);
    await currentUser.save();

    res.json({ message: 'User blocked successfully' });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ message: 'Failed to block user' });
  }
});

/**
 * Unblock a user by userNumber
 * @route DELETE /api/users/number/:userNumber/block/:blockedUsername
 */
router.delete('/number/:userNumber/block/:blockedUsername', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    const { blockedUsername } = req.params;
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to unblock users' });
    }
    
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
 * Update user's introduction by userNumber
 * @route PUT /api/users/number/:userNumber/intro
 */
router.put('/number/:userNumber/intro', auth, async (req, res) => {
  try {
    const userNumber = parseInt(req.params.userNumber);
    
    if (isNaN(userNumber) || userNumber <= 0) {
      return res.status(400).json({ message: 'Invalid user number' });
    }
    
    // Find user by userNumber
    const targetUser = await User.findOne({ userNumber });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if the user matches the authenticated user
    if (req.user._id.toString() !== targetUser._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this profile' });
    }

    const { intro } = req.body;

    // Validate intro length
    if (intro && intro.length > 10000) {
      return res.status(400).json({ message: 'Introduction cannot exceed 10000 characters' });
    }

    // Get user
    const user = await User.findById(req.user._id);

    // Update introduction
    user.intro = intro || '';
    await user.save();

    // Clear user resolution cache since user data changed
    clearUserResolutionCache(req.user._id);

    res.json({ 
      intro: user.intro
    });
  } catch (error) {
    console.error('Introduction update error:', error);
    res.status(500).json({ message: 'Failed to update introduction' });
  }
});

/**
 * Get multiple users by their IDs or userNumbers (optimized with batch caching)
 * @route POST /api/users/by-ids
 */
router.post('/by-ids', async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'IDs array is required' });
    }
    
    // Limit the number of IDs to prevent abuse
    if (ids.length > 50) {
      return res.status(400).json({ message: 'Cannot fetch more than 50 users at once' });
    }
    
    // Use batch cache lookup
    const userLookupResult = await batchGetUsers(ids, {
      projection: { displayName: 1, username: 1, userNumber: 1, avatar: 1, role: 1, _id: 1 }
    });
    
    // Convert the lookup result to an array format that matches the old API
    const users = [];
    for (const id of ids) {
      const user = userLookupResult[id] || userLookupResult[id.toString()];
      if (user) {
        users.push(user);
      }
    }
    
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users by IDs:', error);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

export default router; 