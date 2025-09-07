import express from 'express';
import { auth } from '../middleware/auth.js';
import Request from '../models/Request.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { createTransaction } from './userTransaction.js';
import { createNovelTransaction } from './novelTransactions.js';
import ContributionHistory from '../models/ContributionHistory.js';
import { clearUserCache } from '../utils/userCache.js';
import { clearContributionHistoryCache } from './novels.js';

const router = express.Router();

// Simple in-memory cache for requests
const requestsCache = new Map();
const REQUESTS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

const getCachedRequests = (cacheKey) => {
  const cached = requestsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < REQUESTS_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedRequests = (cacheKey, data) => {
  requestsCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
};

const clearRequestsCache = () => {
  requestsCache.clear();
};

/**
 * Get all requests
 * @route GET /api/requests
 */
router.get('/', async (req, res) => {
  try {
    // Get sort parameter (default to newest)
    const { sort = 'newest', includeAll = 'false' } = req.query;
    
    // Create cache key based on parameters
    const cacheKey = `requests_${sort}_${includeAll}`;
    
    // Check cache first
    const cachedResult = getCachedRequests(cacheKey);
    if (cachedResult) {
      return res.json(cachedResult);
    }
    
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
    
    let query;
    if (includeAll === 'true') {
      // For history view - show ALL requests including withdrawn
      query = {}; // No filter - show everything
    } else {
      // For main list view - show only pending requests
      query = { 
        status: 'pending', 
        type: { $in: ['new', 'web'] }
      };
    }
    
    const requests = await Request.find(query)
      .populate('user', 'username displayName avatar role userNumber')
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
    
    // Cache the result
    setCachedRequests(cacheKey, requests);
    
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
    const { type, title, novelId, moduleId, chapterId, deposit, note, contactInfo, goalBalance, image } = req.body;
    
    // Validate deposit amount (except for web requests which use goalBalance)
    if (type !== 'web' && (!deposit || isNaN(deposit) || deposit <= 0)) {
      return res.status(400).json({ message: 'Invalid deposit amount' });
    }
    
    // Find user
    const user = await User.findById(req.user._id).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Validate user has enough balance (skip for web requests)
    if (type !== 'web' && user.balance < deposit) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Insufficient balance' });
    }
    
    // Create request object
    const requestData = {
      user: req.user._id,
      type,
      title: title || "", // Provide default empty string if title is not provided
      deposit: type === 'web' ? 0 : deposit // Web requests start with 0 deposit
    };
    
    // Add goal balance for web requests
    if (type === 'web' && goalBalance) {
      requestData.goalBalance = goalBalance;
    }
    
    // Add note if provided
    if (note) {
      requestData.note = note;
    }
    
    // Add contactInfo if provided (only for 'new' requests)
    if (contactInfo && type === 'new') {
      requestData.contactInfo = contactInfo;
    }
    
    // Add illustration if provided
    if (image) {
      requestData.illustration = image;
    }
    
    // Web requests don't need a novel reference at creation time
    
    // Create request
    const newRequest = new Request(requestData);
    await newRequest.save({ session });
    
    // Clear requests cache since new request was created
    clearRequestsCache();
    
    // Only deduct deposit for non-web requests
    if (type !== 'web') {
      // Store old balance for transaction record
      const oldBalance = user.balance;
      
          // Deduct deposit from user balance
    user.balance -= deposit;
    await user.save({ session });
    
    // Clear user cache to ensure fresh balance is returned by API calls
    clearUserCache(user._id, user.username);
      
      // Record the transaction in UserTransaction ledger
      let description;
      if (type === 'new') {
        description = 'Yêu cầu truyện mới';
      }
      
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
    }
    
    // For admin web recommendations, we don't add to novel balance - that happens via contributions
    
    // Populate user and novel data before sending response
    await newRequest.populate('user', 'username displayName avatar role userNumber');
    if (type === 'web') {
      await newRequest.populate('novel', 'title _id');
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
    
    // Clear requests cache since request likes were updated
    clearRequestsCache();
    
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
    
    // We only process 'new' and 'web' type requests here
    if (request.type !== 'new' && request.type !== 'web') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'This request type cannot be approved manually' });
    }
    
    // Check if a novel with matching title already exists for both 'new' and 'web' requests
    const Novel = mongoose.model('Novel');
    const matchingNovel = await Novel.findOne({ title: request.title }).session(session);
    
    if (!matchingNovel) {
      await session.abortTransaction();
      return res.status(400).json({ 
        message: 'Không thể phê duyệt: Truyện phải được tạo trước với tên trùng khớp với yêu cầu',
        needsNovel: true 
      });
    }
    
    // Get all contributions for this request
    const Contribution = mongoose.model('Contribution');
    const contributions = await Contribution.find({ 
      request: request._id,
      status: 'pending' 
    }).session(session);
    
    // Mark all pending contributions as approved
    if (contributions.length > 0) {
      await Contribution.updateMany(
        { request: request._id, status: 'pending' },
        { status: 'approved' },
        { session }
      );
    }
    
    // Calculate total contributions (including previously approved ones)
    const allContributions = await Contribution.find({
      request: request._id,
      status: 'approved'
    }).session(session);
    
    const totalContributions = allContributions.reduce((sum, contribution) => sum + contribution.amount, 0);
    
    // Update novel balance and budget with deposit + all contributions
    const totalAmount = request.deposit + totalContributions;
    const oldBalance = matchingNovel.novelBalance || 0;
    const oldBudget = matchingNovel.novelBudget || 0;
    const newBalance = oldBalance + totalAmount;
    const newBudget = oldBudget + totalAmount;
    
    await Novel.findByIdAndUpdate(
      matchingNovel._id, 
      { 
        $inc: { 
          novelBalance: totalAmount,
          novelBudget: totalAmount 
        } 
      },
      { session }
    );
    
    // Create separate ContributionHistory records for deposit and contributions
    // This ensures proper audit trail for all money transferred to the novel
    let runningBudget = oldBudget;
    
    // 1. Create contribution history record for the original request deposit
    if (request.deposit > 0) {
      runningBudget += request.deposit;
      await ContributionHistory.create([{
        novelId: matchingNovel._id,
        userId: request.user,
        amount: request.deposit,
        note: request.type === 'new' 
          ? `Lúa cọc yêu cầu truyện mới: ${request.title}`
          : `Lúa cọc đề xuất từ nhóm dịch: ${request.title}`,
        budgetAfter: runningBudget,
        type: 'user'
      }], { session });
    }
    
    // 2. Create contribution history records for each individual contribution
    for (const contribution of allContributions) {
      runningBudget += contribution.amount;
      await ContributionHistory.create([{
        novelId: matchingNovel._id,
        userId: contribution.user,
        amount: contribution.amount,
        note: `Đóng góp cho yêu cầu: ${request.title}${contribution.note ? ` - ${contribution.note}` : ''}`,
        budgetAfter: runningBudget,
        type: 'user'
      }], { session });
    }
    
    // Create novel transaction record
    await createNovelTransaction({
      novel: matchingNovel._id,
      amount: totalAmount,
      type: 'request',
      description: request.type === 'new' 
        ? `Yêu cầu truyện mới được admin chấp nhận. Cọc: ${request.deposit}, Đóng góp: ${totalContributions}`
        : `Đề xuất từ nhóm dịch được admin chấp nhận. Cọc: ${request.deposit}, Đóng góp: ${totalContributions}`,
      balanceAfter: newBalance,
      sourceId: request._id,
      sourceModel: 'Request',
      performedBy: req.user._id
    }, session);
    
    // Update request status and link to the novel
    request.status = 'approved';
    request.novel = matchingNovel._id;
    await request.save({ session });
    
    // Clear requests cache since request was approved
    clearRequestsCache();
    
    // Clear contribution history cache since new contributions were added to the novel
    clearContributionHistoryCache(matchingNovel._id);
    
    // Record the transaction in UserTransaction ledger - no balance change since deposit was already deducted
    await createTransaction({
      userId: request.user,
      amount: 0, // No balance change as deposit was already deducted when request was created
      type: 'request',
      description: request.type === 'new'
        ? `Yêu cầu truyện mới được admin chấp nhận, ${totalAmount} 🌾 đã được chuyển vào truyện`
        : `Đề xuất từ nhóm dịch được admin chấp nhận, ${totalAmount} 🌾 đã được chuyển vào truyện`,
      sourceId: request._id,
      sourceModel: 'Request',
      performedById: req.user._id, // Admin initiated
      balanceAfter: (await User.findById(request.user).session(session)).balance || 0
    }, session);
    
    await session.commitTransaction();

    // Check for auto-unlock after request approval adds funds to novel
    if (totalAmount > 0) {
      // Import the checkAndUnlockContent function from novels.js
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(matchingNovel._id);
    }
    
    // Prepare success message based on request type and goal achievement
    let successMessage = 'Yêu cầu đã được phê duyệt thành công và 🌾 đã được chuyển cho truyện';
    
    // For web requests, check if goal is reached
    if (request.type === 'web' && request.goalBalance) {
      if (newBalance >= request.goalBalance) {
        successMessage = `Đề xuất từ nhóm dịch đã được phê duyệt và mục tiêu ${request.goalBalance} 🌾 đã đạt được!`;
      } else {
        const remaining = request.goalBalance - newBalance;
        successMessage = `Đề xuất từ nhóm dịch đã được phê duyệt. Còn cần thêm ${remaining} 🌾 để đạt mục tiêu ${request.goalBalance} 🌾`;
      }
    }
    
    res.json({ 
      message: successMessage,
      novelId: matchingNovel._id,
      goalBalance: request.type === 'web' ? request.goalBalance : null,
      currentBalance: newBalance
    });
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
    
    // Clear requests cache since request was declined
    clearRequestsCache();
    
    // Refund deposit to user
    user.balance += request.deposit;
    await user.save({ session });
    
    // Clear user cache to ensure fresh balance is returned by API calls
    clearUserCache(user._id, user.username);
    
    // Record the refund transaction in UserTransaction ledger
    await createTransaction({
      userId: user._id,
      amount: request.deposit, // Positive amount for refunds
      type: 'refund',
      description: `Hoàn lúa do admin từ chối yêu cầu`,
      sourceId: request._id,
      sourceModel: 'Request',
      performedById: req.user._id, // Admin initiated
      balanceAfter: user.balance
    }, session);
    
    // For 'new' type requests, find and refund all pending contributions
    let contributionsRefunded = 0;
    if (request.type === 'new') {
      // Find all pending contributions for this request
      const Contribution = mongoose.model('Contribution');
      const pendingContributions = await Contribution.find({ 
        request: request._id,
        status: 'pending' 
      }).session(session);
      
      // If there are pending contributions, process refunds
      if (pendingContributions.length > 0) {
        // Update all contributions to declined
        await Contribution.updateMany(
          { request: request._id, status: 'pending' },
          { status: 'declined' },
          { session }
        );
        
        // Refund each contributor
        for (const contribution of pendingContributions) {
          const contributor = await User.findById(contribution.user).session(session);
          if (contributor) {
            const contributorOldBalance = contributor.balance;
            contributor.balance += contribution.amount;
            await contributor.save({ session });
            
            // Clear contributor's cache
            clearUserCache(contributor._id, contributor.username);
            
            // Record the refund transaction
            await createTransaction({
              userId: contributor._id,
              amount: contribution.amount,
              type: 'refund',
              description: `Hoàn lúa do admin từ chối yêu cầu`,
              sourceId: request._id,
              sourceModel: 'Request',
              performedById: req.user._id, // Admin initiated
              balanceAfter: contributor.balance
            }, session);
            
            contributionsRefunded++;
          }
        }
      }
    }
    
    await session.commitTransaction();
    
    // Prepare response message based on contributions refunded
    let message = 'Yêu cầu đã được từ chối và 🌾 cọc đã được hoàn trả';
    if (contributionsRefunded > 0) {
      message = `Yêu cầu đã được từ chối và 🌾 cọc cùng ${contributionsRefunded} đóng góp đã được hoàn trả`;
    }
    
    res.json({ message });
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
    
    // Clear user cache to ensure fresh balance is returned by API calls
    clearUserCache(user._id, user.username);
    
    // Record the refund transaction in UserTransaction ledger
    await createTransaction({
      userId: user._id,
      amount: request.deposit, // Positive amount for refunds
      type: 'refund',
      description: `Hoàn lúa từ việc rút lại yêu cầu`,
      sourceId: request._id,
      sourceModel: 'Request',
      performedById: null, // User initiated
      balanceAfter: user.balance
    }, session);
    
    // For 'new' type requests, find and refund all pending contributions
    if (request.type === 'new') {
      // Find all pending contributions for this request
      const Contribution = mongoose.model('Contribution');
      const pendingContributions = await Contribution.find({ 
        request: request._id,
        status: 'pending' 
      }).session(session);
      
      // If there are pending contributions, process refunds
      if (pendingContributions.length > 0) {
        // Update all contributions to declined
        await Contribution.updateMany(
          { request: request._id, status: 'pending' },
          { status: 'declined' },
          { session }
        );
        
        // Refund each contributor
        for (const contribution of pendingContributions) {
          const contributor = await User.findById(contribution.user).session(session);
          if (contributor) {
            const contributorOldBalance = contributor.balance;
            contributor.balance += contribution.amount;
            await contributor.save({ session });
            
            // Clear contributor's cache
            clearUserCache(contributor._id, contributor.username);
            
            // Record the refund transaction
            await createTransaction({
              userId: contributor._id,
              amount: contribution.amount,
              type: 'refund',
              description: `Hoàn lúa do yêu cầu được rút lại`,
              sourceId: request._id,
              sourceModel: 'Request',
              performedById: null,
              balanceAfter: contributor.balance
            }, session);
          }
        }
      }
    }
    
    // Mark the request as withdrawn instead of deleting it
    request.status = 'withdrawn';
    await request.save({ session });
    
    // Clear requests cache since request was withdrawn
    clearRequestsCache();
    
    await session.commitTransaction();
    res.json({ 
      message: 'Yêu cầu đã được rút lại thành công',
      refundAmount: request.deposit,
      contributionsRefunded: request.type === 'new' && pendingContributions ? pendingContributions.length : 0
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
    if (status && ['pending', 'approved', 'declined', 'withdrawn'].includes(status)) {
      query.status = status;
    }
    
    // Add type filter if specified
    if (type && ['new', 'web'].includes(type)) {
      query.type = type;
    }
    
    // Query all requests matching filters
    const requests = await Request.find(query)
      .populate('user', 'username displayName avatar role userNumber')
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
      .populate('user', 'username displayName avatar')
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

/**
 * Update a request (admin, moderator, or user who created a 'new' request)
 * @route PUT /api/requests/:requestId
 */
router.put('/:requestId', auth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { note, contactInfo, illustration } = req.body;
    
    // Find the request
    const request = await Request.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: 'Yêu cầu không tồn tại' });
    }
    
    // Check user permissions
    const isAdmin = req.user.role === 'admin' || req.user.role === 'moderator';
    const isOwnerOfNewRequest = request.type === 'new' && request.user.toString() === req.user._id.toString();
    
    if (!isAdmin && !isOwnerOfNewRequest) {
      return res.status(403).json({ message: 'Bạn không có quyền chỉnh sửa yêu cầu này' });
    }
    
    // Admin/moderator can edit both 'new' and 'web' requests, users can only edit their own 'new' requests
    if (isAdmin) {
      // Admin and moderator can edit 'new' and 'web' type requests
      if (request.type !== 'new' && request.type !== 'web') {
        return res.status(400).json({ message: 'Loại yêu cầu này không thể chỉnh sửa' });
      }
    } else {
      // Regular users can only edit their own 'new' requests
      if (request.type !== 'new') {
        return res.status(400).json({ message: 'Bạn chỉ có thể chỉnh sửa yêu cầu truyện mới của chính mình' });
      }
    }
    
    // Update the fields that are allowed to be edited
    const updateData = { isEdited: true };
    
    if (note !== undefined) {
      updateData.note = note;
    }
    
    if (contactInfo !== undefined && request.type === 'new') {
      updateData.contactInfo = contactInfo;
    }
    
    if (illustration !== undefined) {
      updateData.illustration = illustration;
    }
    
    // Update the request
         const updatedRequest = await Request.findByIdAndUpdate(
       requestId,
       updateData,
       { new: true }
     ).populate('user', 'username displayName avatar role userNumber')
      .populate('novel', 'title _id');
    
    res.json({
      message: 'Yêu cầu đã được cập nhật thành công',
      request: updatedRequest
    });
  } catch (error) {
    console.error('Failed to update request:', error);
    res.status(500).json({ message: 'Lỗi khi cập nhật yêu cầu' });
  }
});

/**
 * Delete a request (admin only)
 * @route DELETE /api/requests/:requestId
 */
router.delete('/:requestId', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Chỉ admin mới có thể xóa yêu cầu' });
    }
    
    const { requestId } = req.params;
    
    // Find and delete the request
    const request = await Request.findByIdAndDelete(requestId);
    
    if (!request) {
      return res.status(404).json({ message: 'Yêu cầu không tồn tại' });
    }
    
    res.json({ message: 'Yêu cầu đã được xóa thành công' });
  } catch (error) {
    console.error('Failed to delete request:', error);
    res.status(500).json({ message: 'Lỗi khi xóa yêu cầu' });
  }
});

export default router; 