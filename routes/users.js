import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';
import { uploadImage } from '../utils/imageUpload.js';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

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
 * Get user profile
 * @route GET /api/users/:username/profile
 */
router.get('/:username/profile', auth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username })
      .select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch profile' });
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

    const user = await User.findById(req.user._id);
    const isBookmarked = user.bookmarks && user.bookmarks.some(
      bookmark => bookmark.toString() === req.params.novelId
    );
    
    res.json({ isBookmarked });
  } catch (error) {
    console.error('Bookmark status check error:', error);
    res.status(500).json({ message: 'Failed to check bookmark status' });
  }
});

/**
 * Add a novel to user's bookmarks
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

    const user = await User.findById(req.user._id);
    if (!user.bookmarks) {
      user.bookmarks = [];
    }
    
    const bookmarkExists = user.bookmarks.some(id => id.toString() === novelId);
    if (!bookmarkExists) {
      user.bookmarks.push(novelId);
      await user.save();
    }

    res.json({ message: 'Novel bookmarked successfully' });
  } catch (error) {
    console.error('Bookmark add error:', error);
    res.status(500).json({ message: 'Failed to add bookmark' });
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

    const user = await User.findById(req.user._id);
    if (!user.bookmarks) {
      user.bookmarks = [];
    }
    
    user.bookmarks = user.bookmarks.filter(
      bookmark => bookmark.toString() !== req.params.novelId
    );
    await user.save();

    res.json({ message: 'Bookmark removed successfully' });
  } catch (error) {
    console.error('Bookmark remove error:', error);
    res.status(500).json({ message: 'Failed to remove bookmark' });
  }
});

/**
 * Get all bookmarked novels for a user
 * @route GET /api/users/:username/bookmarks
 */
router.get('/:username/bookmarks', auth, async (req, res) => {
  try {
    // Check if user exists and matches the authenticated user
    if (req.user.username !== req.params.username) {
      return res.status(403).json({ message: 'Not authorized to view bookmarks' });
    }

    const user = await User.findById(req.user._id)
      .populate({
        path: 'bookmarks',
        select: '_id title' // Only select the fields we need
      });

    if (!user.bookmarks) {
      user.bookmarks = [];
      await user.save();
    }

    res.json(user.bookmarks);
  } catch (error) {
    console.error('Bookmarks fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch bookmarks' });
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
      .populate('blockedUsers', 'username avatar');
    
    res.json(user.blockedUsers);
  } catch (error) {
    console.error('Get blocked users error:', error);
    res.status(500).json({ message: 'Failed to get blocked users' });
  }
});

export default router; 