import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';
import TopUpAdmin from '../models/TopUpAdmin.js';
import TopUpRequest from '../models/TopUpRequest.js';
import mongoose from 'mongoose';
import { createTransaction } from './userTransaction.js';
import { clearUserCache } from '../utils/userCache.js';

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
    console.log(`💰 [Admin TopUp] Admin ${req.user.username} adding ${amount} 🌾 to ${user.username}`);
    console.log(`💰 [Admin TopUp] User balance before topup: ${oldBalance} 🌾`);
    
    user.balance = oldBalance + amount;
    await user.save({ session });
    console.log(`💰 [Admin TopUp] User balance after topup: ${user.balance} 🌾`);
    
    // Clear user cache to ensure fresh balance is returned by API calls
    clearUserCache(user._id, user.username);
    console.log(`🗑️ [Admin TopUp] Cleared user cache for ${user.username} (ID: ${user._id})`);
    
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
 * Get all top-up transactions (Admin only) - OPTIMIZED
 * @route GET /api/topup-admin/transactions
 */
router.get('/transactions', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có thể xem tất cả giao dịch' });
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    // Use aggregation pipeline for better performance
    const transactions = await TopUpAdmin.aggregate([
      {
        $sort: { createdAt: -1 }
      },
      {
        $skip: skip
      },
      {
        $limit: limit
      },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
          pipeline: [{ $project: { username: 1, displayName: 1 } }]
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'admin',
          foreignField: '_id',
          as: 'admin',
          pipeline: [{ $project: { username: 1, displayName: 1 } }]
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'revokedBy',
          foreignField: '_id',
          as: 'revokedBy',
          pipeline: [{ $project: { username: 1, displayName: 1 } }]
        }
      },
      {
        $unwind: '$user'
      },
      {
        $unwind: '$admin'
      },
      {
        $unwind: {
          path: '$revokedBy',
          preserveNullAndEmptyArrays: true
        }
      }
    ]);
    
    // Get total count for pagination
    const total = await TopUpAdmin.countDocuments();
    
    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
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
      
      // Remove expiration to prevent TTL deletion of completed requests
      request.expiresAt = undefined;
      
      // If balance was adjusted, update it
      const finalBalance = adjustedBalance || request.balance;
      
      // Add notes if amount was adjusted
      if (adjustedBalance && adjustedBalance !== request.balance) {
        request.notes = `Số dư đã điều chỉnh từ ${request.balance} thành ${adjustedBalance} bởi admin`;
        request.balance = adjustedBalance;
      }
      
      // Add to user balance (removed bonus)
      const oldBalance = user.balance || 0;
      console.log(`💰 [TopUp Request] Processing request ${requestId} for ${user.username}`);
      console.log(`💰 [TopUp Request] User balance before topup: ${oldBalance} 🌾`);
      console.log(`💰 [TopUp Request] Adding ${finalBalance} 🌾 to balance`);
      
      user.balance = oldBalance + finalBalance;
      console.log(`💰 [TopUp Request] User balance after topup: ${user.balance} 🌾`);
      
      await request.save({ session });
      await user.save({ session });
      
      // Clear user cache to ensure fresh balance is returned by API calls
      clearUserCache(user._id, user.username);
      console.log(`🗑️ [TopUp Request] Cleared user cache for ${user.username} (ID: ${user._id})`);
      
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
 * Get all completed/failed top-up requests (Admin only) - OPTIMIZED
 * @route GET /api/topup-admin/completed-requests
 */
router.get('/completed-requests', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Truy cập bị từ chối' });
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    // Use aggregation pipeline for better performance
    const completedRequests = await TopUpRequest.aggregate([
      {
        $match: { 
          status: { $in: ['Completed', 'Failed'] } 
        }
      },
      {
        $sort: { completedAt: -1 }
      },
      {
        $skip: skip
      },
      {
        $limit: limit
      },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
          pipeline: [{ $project: { username: 1, displayName: 1 } }]
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'adminId',
          foreignField: '_id',
          as: 'adminId',
          pipeline: [{ $project: { username: 1, displayName: 1 } }]
        }
      },
      {
        $unwind: '$user'
      },
      {
        $unwind: {
          path: '$adminId',
          preserveNullAndEmptyArrays: true
        }
      }
    ]);
    
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

/**
 * Get all TopUp management data in one request (Admin only) - OPTIMIZED
 * @route GET /api/topup-admin/dashboard-data
 */
router.get('/dashboard-data', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có thể xem dashboard' });
    }
    
    const recentTransactionsLimit = parseInt(req.query.recentLimit) || 20;
    
    // Execute all queries in parallel for better performance
    const [
      recentAdminTransactions,
      recentCompletedRequests,
      pendingRequests
    ] = await Promise.all([
      // Recent admin transactions (limited)
      TopUpAdmin.aggregate([
        { $sort: { createdAt: -1 } },
        { $limit: recentTransactionsLimit },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            as: 'user',
            pipeline: [{ $project: { username: 1, displayName: 1 } }]
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'admin',
            foreignField: '_id',
            as: 'admin',
            pipeline: [{ $project: { username: 1, displayName: 1 } }]
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'revokedBy',
            foreignField: '_id',
            as: 'revokedBy',
            pipeline: [{ $project: { username: 1, displayName: 1 } }]
          }
        },
        { $unwind: '$user' },
        { $unwind: '$admin' },
        {
          $unwind: {
            path: '$revokedBy',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $addFields: {
            transactionType: 'admin'
          }
        }
      ]),
      
      // Recent completed requests (limited)
      TopUpRequest.aggregate([
        {
          $match: { 
            status: { $in: ['Completed', 'Failed'] } 
          }
        },
        { $sort: { completedAt: -1 } },
        { $limit: recentTransactionsLimit },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            as: 'user',
            pipeline: [{ $project: { username: 1, displayName: 1 } }]
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'adminId',
            foreignField: '_id',
            as: 'adminId',
            pipeline: [{ $project: { username: 1, displayName: 1 } }]
          }
        },
        { $unwind: '$user' },
        {
          $unwind: {
            path: '$adminId',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $addFields: {
            transactionType: 'user'
          }
        }
      ]),
      
      // Pending requests
      TopUpRequest.aggregate([
        {
          $match: { status: 'Pending' }
        },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            as: 'user',
            pipeline: [{ $project: { username: 1, displayName: 1 } }]
          }
        },
        { $unwind: '$user' }
      ])
    ]);
    
    // Combine recent transactions (admin + user) and sort by date
    const allRecentTransactions = [
      ...recentAdminTransactions,
      ...recentCompletedRequests
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
      recentTransactions: allRecentTransactions.slice(0, recentTransactionsLimit),
      pendingRequests: pendingRequests,
      stats: {
        totalAdminTransactions: recentAdminTransactions.length,
        totalCompletedRequests: recentCompletedRequests.length,
        totalPendingRequests: pendingRequests.length
      }
    });
  } catch (error) {
    console.error('Failed to fetch dashboard data:', error);
    res.status(500).json({ message: 'Lỗi khi tải dữ liệu dashboard' });
  }
});

/**
 * Revoke an admin top-up transaction (Admin only)
 * @route POST /api/topup-admin/revoke-transaction/:transactionId
 */
router.post('/revoke-transaction/:transactionId', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có thể thu hồi giao dịch' });
    }
    
    const { transactionId } = req.params;
    
    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      return res.status(400).json({ message: 'ID giao dịch không hợp lệ' });
    }
    
    // Find the admin transaction
    const transaction = await TopUpAdmin.findById(transactionId)
      .populate('user', 'username displayName balance')
      .session(session);
    
    if (!transaction) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Giao dịch không tồn tại' });
    }
    
    // Check if transaction is already revoked
    if (transaction.status === 'Revoked') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Giao dịch đã được thu hồi trước đó' });
    }
    
    // Check if transaction is eligible for revocation (only completed admin transactions)
    if (transaction.status !== 'Completed') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Chỉ có thể thu hồi giao dịch đã hoàn thành' });
    }
    
    // Get the user
    const user = await User.findById(transaction.user._id).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }
    
    // Calculate new balance (minimum 0)
    const currentBalance = user.balance || 0;
    const amountToSubtract = transaction.amount;
    const newBalance = Math.max(0, currentBalance - amountToSubtract);
    const actualSubtracted = currentBalance - newBalance;
    
    // Update user balance
    user.balance = newBalance;
    await user.save({ session });
    
    // Mark transaction as revoked
    transaction.status = 'Revoked';
    transaction.revokedAt = new Date();
    transaction.revokedBy = req.user._id;
    transaction.notes = `Thu hồi bởi admin`;
    await transaction.save({ session });
    
    // Clear user cache to ensure fresh balance is returned by API calls
    clearUserCache(user._id, user.username);
   
    // Record revocation in UserTransaction ledger
    await createTransaction({
      userId: user._id,
      amount: -actualSubtracted, // Negative amount to indicate subtraction
      type: 'admin_topup',
      description: `Thu hồi giao dịch phát 🌾 bởi admin (Giao dịch gốc: ${transactionId})`,
      sourceId: transaction._id,
      sourceModel: 'TopUpAdmin',
      performedById: req.user._id,
      balanceAfter: newBalance
    }, session);
    
    await session.commitTransaction();
    
    res.json({ 
      message: 'Giao dịch đã được thu hồi thành công',
      transaction: {
        id: transaction._id,
        originalAmount: amountToSubtract,
        actualSubtracted: actualSubtracted,
        userCurrentBalance: newBalance,
        revokedAt: transaction.revokedAt,
        revokedBy: req.user.username
      }
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Thu hồi giao dịch thất bại:', error);
    res.status(500).json({ message: 'Thu hồi giao dịch thất bại' });
  } finally {
    session.endSession();
  }
});

export default router; 