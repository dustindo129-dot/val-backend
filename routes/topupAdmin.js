import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';
import TopUpAdmin from '../models/TopUpAdmin.js';
import TopUpRequest from '../models/TopUpRequest.js';
import mongoose from 'mongoose';
import { createTransaction } from './userTransaction.js';

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
      return res.status(403).json({ message: 'Chỉ admin mới có thể phát 🌾' });
    }
    
    const { username, amount } = req.body;
    
    // Validate amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Số 🌾 không hợp lệ' });
    }
    
    // Find user by username
    const user = await User.findOne({ username }).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }
    
    // Create transaction
    const transaction = new TopUpAdmin({
      user: user._id,
      admin: req.user._id,
      amount,
      status: 'Completed'
    });
    
    await transaction.save({ session });
    
    // Update user balance
    const oldBalance = user.balance || 0;
    user.balance = oldBalance + amount;
    await user.save({ session });
    
    // Record in UserTransaction ledger
    await createTransaction({
      userId: user._id,
      amount: amount,
      type: 'admin_topup',
      description: `Admin phát 🌾`,
      sourceId: transaction._id,
      sourceModel: 'TopUpAdmin',
      performedById: req.user._id,
      balanceAfter: user.balance
    }, session);
    
    // Populate user and admin information
    await transaction.populate('user', 'username displayName');
    await transaction.populate('admin', 'username displayName');
    
    await session.commitTransaction();
    
    res.status(201).json(transaction);
  } catch (error) {
    await session.abortTransaction();
    console.error('Phát 🌾 thất bại:', error);
    res.status(500).json({ message: 'Phát 🌾 thất bại' });
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
      return res.status(403).json({ message: 'Chỉ admin mới có thể xem tất cả giao dịch' });
    }
    
    const transactions = await TopUpAdmin.find()
      .populate('user', 'username displayName')
      .populate('admin', 'username displayName')
      .sort({ createdAt: -1 });
    
    res.json(transactions);
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
    res.status(500).json({ message: 'Lỗi khi tải lại giao dịch' });
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
      return res.status(403).json({ message: 'Truy cập bị từ chối' });
    }
    
    const pendingRequests = await TopUpRequest.find({ status: 'Pending' })
      .populate('user', 'username displayName')
      .sort({ createdAt: -1 });
    
    res.json(pendingRequests);
  } catch (error) {
    console.error('Failed to fetch pending requests:', error);
    res.status(500).json({ message: 'Lỗi khi tải lại yêu cầu chờ xử lý' });
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
      return res.status(403).json({ message: 'Truy cập bị từ chối' });
    }
    
    const { requestId } = req.params;
    const { action, adjustedBalance } = req.body;
    
    if (!['confirm', 'decline'].includes(action)) {
      return res.status(400).json({ message: 'Hành động không hợp lệ' });
    }
    
    // Find the request
    const request = await TopUpRequest.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Yêu cầu không tồn tại' });
    }
    
    if (request.status !== 'Pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Yêu cầu đang không chờ xử lý' });
    }
    
    if (action === 'confirm') {
      // Get the user
      const user = await User.findById(request.user).session(session);
      if (!user) {
        await session.abortTransaction();
        return res.status(404).json({ message: 'Người dùng không tồn tại' });
      }
      
      // Update request
      request.status = 'Completed';
      request.completedAt = new Date();
      request.adminId = req.user._id;
      
      // If balance was adjusted, update it
      const finalBalance = adjustedBalance || request.balance;
      
      // Add notes if amount was adjusted
      if (adjustedBalance && adjustedBalance !== request.balance) {
        request.notes = `Số dư đã điều chỉnh từ ${request.balance} thành ${adjustedBalance} bởi admin`;
        request.balance = adjustedBalance;
      }
      
      // Add to user balance (removed bonus)
      user.balance = (user.balance || 0) + finalBalance;
      
      await request.save({ session });
      await user.save({ session });
      
      // Record in UserTransaction ledger
      await createTransaction({
        userId: user._id,
        amount: finalBalance,
        type: 'topup',
        description: `Nạp tiền qua ${request.paymentMethod === 'bank' ? 'chuyển khoản ngân hàng' : 
                      request.paymentMethod === 'ewallet' ? request.subMethod : 'thẻ cào'} (xác nhận bởi admin)`,
        sourceId: request._id,
        sourceModel: 'TopUpRequest',
        performedById: req.user._id,
        balanceAfter: user.balance
      }, session);
      
      await session.commitTransaction();
      
      return res.status(200).json({ 
        message: 'Yêu cầu đã được xác nhận thành công',
        request
      });
    } else {
      // Decline the request
      request.status = 'Failed';
      request.notes = 'Từ chối bởi admin';
      request.adminId = req.user._id;
      
      await request.save({ session });
      
      // Record in UserTransaction ledger (no balance change)
      await createTransaction({
        userId: request.user,
        amount: 0,
        type: 'other',
        description: `Yêu cầu nạp tiền bị từ chối bởi admin`,
        sourceId: request._id,
        sourceModel: 'TopUpRequest',
        performedById: req.user._id,
        balanceAfter: (await User.findById(request.user).session(session)).balance || 0
      }, session);
      
      await session.commitTransaction();
      
      return res.status(200).json({ 
        message: 'Yêu cầu đã được từ chối thành công',
        request
      });
    }
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to process request:', error);
    res.status(500).json({ message: 'Lỗi khi xử lý yêu cầu' });
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
      return res.status(403).json({ message: 'Truy cập bị từ chối' });
    }
    
    const completedRequests = await TopUpRequest.find({ 
      status: { $in: ['Completed', 'Failed'] } 
    })
      .populate('user', 'username displayName')
      .populate('adminId', 'username displayName')
      .sort({ completedAt: -1 });
    
    res.json(completedRequests);
  } catch (error) {
    console.error('Failed to fetch completed requests:', error);
    res.status(500).json({ message: 'Lỗi khi tải lại yêu cầu đã hoàn tất' });
  }
});

/**
 * Get top-up transactions for current user
 * @route GET /api/topup-admin/history
 */
router.get('/history', auth, async (req, res) => {
  try {
    const transactions = await TopUpAdmin.find({ user: req.user._id })
      .populate('admin', 'username')
      .sort({ createdAt: -1 });
    
    res.json(transactions);
  } catch (error) {
    console.error('Failed to fetch transaction history:', error);
    res.status(500).json({ message: 'Lỗi khi tải lại lịch sử giao dịch' });
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
      return res.status(403).json({ message: 'Chỉ admin mới có thể tìm kiếm người dùng' });
    }
    
    const { query } = req.query;
    
    if (!query || query.length < 2) {
      return res.status(400).json({ message: 'Tìm kiếm phải có ít nhất 2 ký tự' });
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
    res.status(500).json({ message: 'Tìm kiếm người dùng thất bại' });
  }
});

export default router; 