import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';
import TopUpTransaction from '../models/TopUpTransaction.js';
import TopUpRequest from '../models/TopUpRequest.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Create a top-up transaction (Admin only)
 * @route POST /api/topup-admin
 */
router.post('/', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can create top-up transactions' });
    }
    
    const { username, amount } = req.body;
    
    // Validate amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }
    
    // Find user by username
    const user = await User.findOne({ username }).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Create transaction
    const transaction = new TopUpTransaction({
      user: user._id,
      admin: req.user._id,
      amount,
      status: 'Completed'
    });
    
    await transaction.save({ session });
    
    // Update user balance
    user.balance = (user.balance || 0) + amount;
    await user.save({ session });
    
    // Populate user and admin information
    await transaction.populate('user', 'username');
    await transaction.populate('admin', 'username');
    
    await session.commitTransaction();
    
    res.status(201).json(transaction);
  } catch (error) {
    await session.abortTransaction();
    console.error('Top-up transaction failed:', error);
    res.status(500).json({ message: 'Failed to process top-up' });
  } finally {
    session.endSession();
  }
});

/**
 * Get all top-up transactions (Admin only)
 * @route GET /api/topup-admin/transactions
 */
router.get('/transactions', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can view all transactions' });
    }
    
    const transactions = await TopUpTransaction.find()
      .populate('user', 'username')
      .populate('admin', 'username')
      .sort({ createdAt: -1 });
    
    res.json(transactions);
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
    res.status(500).json({ message: 'Failed to fetch transactions' });
  }
});

/**
 * Get all pending top-up requests (Admin only)
 * @route GET /api/topup-admin/pending-requests
 */
router.get('/pending-requests', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    const pendingRequests = await TopUpRequest.find({ status: 'Pending' })
      .populate('user', 'username')
      .sort({ createdAt: -1 });
    
    res.json(pendingRequests);
  } catch (error) {
    console.error('Failed to fetch pending requests:', error);
    res.status(500).json({ message: 'Failed to fetch pending requests' });
  }
});

/**
 * Process a pending top-up request (Admin only)
 * @route POST /api/topup-admin/process-request/:requestId
 */
router.post('/process-request/:requestId', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    const { requestId } = req.params;
    const { action, adjustedBalance } = req.body;
    
    if (!['confirm', 'decline'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action' });
    }
    
    // Find the request
    const request = await TopUpRequest.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Request not found' });
    }
    
    if (request.status !== 'Pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Request is not pending' });
    }
    
    if (action === 'confirm') {
      // Get the user
      const user = await User.findById(request.user).session(session);
      if (!user) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Update request
      request.status = 'Completed';
      request.completedAt = new Date();
      request.adminId = req.user._id;
      
      // If balance was adjusted, update it
      const finalBalance = adjustedBalance || request.balance;
      
      // Add notes if amount was adjusted
      if (adjustedBalance && adjustedBalance !== request.balance) {
        request.notes = `Balance adjusted from ${request.balance} to ${adjustedBalance} by admin`;
        request.balance = adjustedBalance;
      }
      
      // Add to user balance (removed bonus)
      user.balance = (user.balance || 0) + finalBalance;
      
      await request.save({ session });
      await user.save({ session });
      
      await session.commitTransaction();
      
      return res.status(200).json({ 
        message: 'Request confirmed successfully',
        request
      });
    } else {
      // Decline the request
      request.status = 'Failed';
      request.notes = 'Declined by admin';
      request.adminId = req.user._id;
      
      await request.save({ session });
      await session.commitTransaction();
      
      return res.status(200).json({ 
        message: 'Request declined successfully',
        request
      });
    }
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to process request:', error);
    res.status(500).json({ message: 'Failed to process request' });
  } finally {
    session.endSession();
  }
});

/**
 * Get all completed/failed top-up requests (Admin only)
 * @route GET /api/topup-admin/completed-requests
 */
router.get('/completed-requests', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    const completedRequests = await TopUpRequest.find({ 
      status: { $in: ['Completed', 'Failed'] } 
    })
      .populate('user', 'username')
      .populate('adminId', 'username')
      .sort({ completedAt: -1 });
    
    res.json(completedRequests);
  } catch (error) {
    console.error('Failed to fetch completed requests:', error);
    res.status(500).json({ message: 'Failed to fetch completed requests' });
  }
});

/**
 * Get top-up transactions for current user
 * @route GET /api/topup-admin/history
 */
router.get('/history', auth, async (req, res) => {
  try {
    const transactions = await TopUpTransaction.find({ user: req.user._id })
      .populate('admin', 'username')
      .sort({ createdAt: -1 });
    
    res.json(transactions);
  } catch (error) {
    console.error('Failed to fetch transaction history:', error);
    res.status(500).json({ message: 'Failed to fetch transaction history' });
  }
});

/**
 * Search for users (Admin only)
 * @route GET /api/topup-admin/search-users
 */
router.get('/search-users', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can search users' });
    }
    
    const { query } = req.query;
    
    if (!query || query.length < 2) {
      return res.status(400).json({ message: 'Search query must be at least 2 characters' });
    }
    
    // Search for users by username or email
    const users = await User.find({
      $or: [
        { username: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } }
      ]
    }).select('username avatar balance');
    
    res.json(users);
  } catch (error) {
    console.error('User search failed:', error);
    res.status(500).json({ message: 'Failed to search users' });
  }
});

export default router; 