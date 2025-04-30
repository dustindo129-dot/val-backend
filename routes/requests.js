import express from 'express';
import { auth } from '../middleware/auth.js';
import Request from '../models/Request.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { createTransaction } from './userTransaction.js';

const router = express.Router();

/**
 * Get all requests
 * @route GET /api/requests
 */
router.get('/', async (req, res) => {
  try {
    // Get sort parameter (default to newest)
    const { sort = 'newest' } = req.query;
    
    // Define sort criteria
    let sortCriteria = {};
    if (sort === 'newest') {
      sortCriteria = { createdAt: -1 };
    } else if (sort === 'oldest') {
      sortCriteria = { createdAt: 1 };
    } else if (sort === 'likes') {
      // We'll sort by likes length in the application logic
      sortCriteria = { createdAt: -1 };
    }
    
    // Query requests with status pending and populate user and novel
    const requests = await Request.find({ status: 'pending' })
      .populate('user', 'username avatar role')
      .populate('novel', 'title _id')
      .populate('module', 'title _id')
      .populate('chapter', 'title _id')
      .sort(sortCriteria)
      .lean();
    
    // If sorting by likes, we need to do this after query
    if (sort === 'likes') {
      requests.sort((a, b) => 
        (b.likes ? b.likes.length : 0) - (a.likes ? a.likes.length : 0)
      );
    }
    
    return res.json(requests);
  } catch (error) {
    console.error('Failed to fetch requests:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Create a new request
 * @route POST /api/requests
 */
router.post('/', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { type, text, novelId, moduleId, chapterId, deposit, note, autoApproveWebRecommendation } = req.body;
    
    // Validate deposit amount
    if (!deposit || isNaN(deposit) || deposit <= 0) {
      return res.status(400).json({ message: 'Invalid deposit amount' });
    }
    
    // Find user and check balance
    const user = await User.findById(req.user._id).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Validate user has enough balance
    if (user.balance < deposit) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Insufficient balance' });
    }
    
    // Create request object
    const requestData = {
      user: req.user._id,
      type,
      text: text || "", // Provide default empty string if text is not provided
      deposit
    };
    
    // Add note if provided
    if (note) {
      requestData.note = note;
    }
    
    // Add novel reference if request type is 'open'
    if (type === 'open') {
      if (!novelId) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Novel ID is required for open requests' });
      }
      requestData.novel = novelId;
      
      // Add module and chapter if provided
      if (moduleId) {
        requestData.module = moduleId;
      }
      
      if (chapterId) {
        requestData.chapter = chapterId;
      }
    }
    
    // Handle web recommendations with auto-approval
    if (autoApproveWebRecommendation && user.role === 'admin') {
      requestData.status = 'approved'; // Auto-approve web recommendations by admin
    }
    
    // Create request
    const newRequest = new Request(requestData);
    await newRequest.save({ session });
    
    // Store old balance for transaction record
    const oldBalance = user.balance;
    
    // Deduct deposit from user balance
    user.balance -= deposit;
    await user.save({ session });
    
    // Record the transaction in UserTransaction ledger
    const description = type === 'open' 
      ? `Yêu cầu mở chương truyện` 
      : `Yêu cầu truyện mới`;
    
    await createTransaction({
      userId: user._id,
      amount: -deposit, // Negative amount for deductions
      type: 'request',
      description,
      sourceId: newRequest._id,
      sourceModel: 'Request',
      performedById: null, // User initiated
      balanceAfter: user.balance
    }, session);
    
    // If this is an auto-approved web recommendation, add deposit to novel balance
    if (autoApproveWebRecommendation && user.role === 'admin' && type === 'open' && novelId) {
      const Novel = mongoose.model('Novel');
      await Novel.findByIdAndUpdate(
        novelId,
        { $inc: { novelBalance: deposit } },
        { session }
      );
    }
    
    // Populate user and novel data before sending response
    await newRequest.populate('user', 'username avatar role');
    if (type === 'open') {
      await newRequest.populate('novel', 'title _id');
      
      // Populate module and chapter if they exist
      if (moduleId) {
        await newRequest.populate('module', 'title _id');
      }
      
      if (chapterId) {
        await newRequest.populate('chapter', 'title _id');
      }
    }
    
    await session.commitTransaction();
    
    res.status(201).json(newRequest);
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to create request:', error);
    res.status(500).json({ message: 'Failed to create request' });
  } finally {
    session.endSession();
  }
});

/**
 * Like/unlike a request
 * @route POST /api/requests/:requestId/like
 */
router.post('/:requestId/like', auth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user._id;
    
    // Find the request
    const request = await Request.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }
    
    // Check if user has already liked the request
    const alreadyLiked = request.likes && request.likes.some(
      id => id.toString() === userId.toString()
    );
    
    // Add or remove like based on current status
    if (alreadyLiked) {
      request.likes = request.likes.filter(
        id => id.toString() !== userId.toString()
      );
    } else {
      if (!request.likes) request.likes = [];
      request.likes.push(userId);
    }
    
    await request.save();
    
    res.json({ 
      liked: !alreadyLiked,
      likesCount: request.likes.length
    });
  } catch (error) {
    console.error('Failed to like/unlike request:', error);
    res.status(500).json({ message: 'Failed to process like' });
  }
});

/**
 * Approve request (admin only)
 * @route POST /api/requests/:requestId/approve
 */
router.post('/:requestId/approve', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can approve requests' });
    }
    
    const { requestId } = req.params;
    
    // Find request
    const request = await Request.findById(requestId).session(session)
      .populate('novel', '_id title novelBalance');
      
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Request not found' });
    }
    
    // Check if request is already processed
    if (request.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Request has already been processed' });
    }
    
    // Update request status
    request.status = 'approved';
    await request.save({ session });
    
    // Handle deposit based on request type
    if (request.type === 'open' && request.novel) {
      // For chapter opening requests, add deposit to novel balance
      const Novel = mongoose.model('Novel');
      await Novel.findByIdAndUpdate(
        request.novel._id,
        { $inc: { novelBalance: request.deposit } },
        { session }
      );
      
      // Record the transaction in UserTransaction ledger - no balance change since deposit was already deducted
      await createTransaction({
        userId: request.user,
        amount: 0, // No balance change as deposit was already deducted when request was created
        type: 'request',
        description: `Yêu cầu mở chương được admin chấp nhận`,
        sourceId: request._id,
        sourceModel: 'Request',
        performedById: req.user._id, // Admin initiated
        balanceAfter: (await User.findById(request.user).session(session)).balance || 0
      }, session);
      
      await session.commitTransaction();
      res.json({ 
        message: 'Request approved successfully. Deposit added to novel balance.',
        novelId: request.novel._id,
        novelBalance: (request.novel.novelBalance || 0) + request.deposit
      });
    } else {
      // For new novel requests, deposit is kept (not returned to user)
      
      // Record the transaction in UserTransaction ledger - no balance change since deposit was already deducted
      await createTransaction({
        userId: request.user,
        amount: 0, // No balance change as deposit was already deducted when request was created
        type: 'request',
        description: `Yêu cầu truyện mới được admin chấp nhận`,
        sourceId: request._id,
        sourceModel: 'Request',
        performedById: req.user._id, // Admin initiated
        balanceAfter: (await User.findById(request.user).session(session)).balance || 0
      }, session);
      
      await session.commitTransaction();
      res.json({ message: 'Request approved successfully' });
    }
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to approve request:', error);
    res.status(500).json({ message: 'Failed to approve request' });
  } finally {
    session.endSession();
  }
});

/**
 * Decline request (admin only)
 * @route POST /api/requests/:requestId/decline
 */
router.post('/:requestId/decline', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có thể từ chối yêu cầu' });
    }
    
    const { requestId } = req.params;
    
    // Find request
    const request = await Request.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Yêu cầu không tồn tại' });
    }
    
    // Check if request is already processed
    if (request.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Yêu cầu đã được xử lý' });
    }
    
    // Find user to refund deposit
    const user = await User.findById(request.user).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }
    
    // Store old balance for transaction record
    const oldBalance = user.balance;
    
    // Update request status
    request.status = 'declined';
    await request.save({ session });
    
    // Refund deposit to user
    user.balance += request.deposit;
    await user.save({ session });
    
    // Record the refund transaction in UserTransaction ledger
    await createTransaction({
      userId: user._id,
      amount: request.deposit, // Positive amount for refunds
      type: 'refund',
      description: `Hoàn tiền do admin từ chối yêu cầu`,
      sourceId: request._id,
      sourceModel: 'Request',
      performedById: req.user._id, // Admin initiated
      balanceAfter: user.balance
    }, session);
    
    await session.commitTransaction();
    res.json({ message: 'Yêu cầu đã được từ chối và 🌾 gửi đã được hoàn trả' });
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to decline request:', error);
    res.status(500).json({ message: 'Lỗi khi từ chối yêu cầu' });
  } finally {
    session.endSession();
  }
});

/**
 * Withdraw request (user withdraws their own request)
 * @route POST /api/requests/:requestId/withdraw
 */
router.post('/:requestId/withdraw', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { requestId } = req.params;
    const userId = req.user._id;
    
    // Find request
    const request = await Request.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Yêu cầu không tồn tại' });
    }
    
    // Verify this is the user's own request
    if (request.user.toString() !== userId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ message: 'Bạn chỉ có thể rút lại yêu cầu của chính mình' });
    }
    
    // Check if request is already processed
    if (request.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Yêu cầu không thể được rút lại' });
    }
    
    // Find user to refund deposit
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }
    
    // Store old balance for transaction record
    const oldBalance = user.balance;
    
    // Refund deposit to user
    user.balance += request.deposit;
    await user.save({ session });
    
    // Record the refund transaction in UserTransaction ledger
    await createTransaction({
      userId: user._id,
      amount: request.deposit, // Positive amount for refunds
      type: 'refund',
      description: `Hoàn tiền từ việc rút lại yêu cầu`,
      sourceId: request._id,
      sourceModel: 'Request',
      performedById: null, // User initiated
      balanceAfter: user.balance
    }, session);
    
    // Delete the request
    await Request.findByIdAndDelete(requestId).session(session);
    
    await session.commitTransaction();
    res.json({ 
      message: 'Yêu cầu đã được rút lại thành công',
      refundAmount: request.deposit
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to withdraw request:', error);
    res.status(500).json({ message: 'Lỗi khi rút lại yêu cầu' });
  } finally {
    session.endSession();
  }
});

/**
 * Get all request history (admin and moderator only)
 * @route GET /api/requests/all
 */
router.get('/all', auth, async (req, res) => {
  try {
    // Verify user is admin or moderator
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Truy cập bị từ chối. Chỉ admin hoặc moderator mới được truy cập.' });
    }
    
    // Get query parameters for filtering
    const { status, type, limit = 100 } = req.query;
    
    // Build query
    const query = {};
    
    // Add status filter if specified
    if (status && ['pending', 'approved', 'declined'].includes(status)) {
      query.status = status;
    }
    
    // Add type filter if specified
    if (type && ['new', 'open'].includes(type)) {
      query.type = type;
    }
    
    // Query all requests matching filters
    const requests = await Request.find(query)
      .populate('user', 'username avatar role')
      .populate('novel', 'title _id')
      .populate('module', 'title _id')
      .populate('chapter', 'title _id')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();
    
    return res.json(requests);
  } catch (error) {
    console.error('Failed to fetch request history:', error);
    return res.status(500).json({ message: 'Lỗi khi tải lại lịch sử yêu cầu' });
  }
});

/**
 * Get user request history 
 * @route GET /api/requests/history
 */
router.get('/history', auth, async (req, res) => {
  try {
    // Get all requests for the user, both pending and processed
    const requests = await Request.find({ user: req.user._id })
      .populate('user', 'username avatar')
      .populate('novel', 'title _id')
      .populate('module', 'title _id')
      .populate('chapter', 'title _id')
      .sort({ createdAt: -1 });
    
    res.json(requests);
  } catch (error) {
    console.error('Failed to fetch request history:', error);
    res.status(500).json({ message: 'Lỗi khi tải lại lịch sử yêu cầu' });
  }
});

export default router; 