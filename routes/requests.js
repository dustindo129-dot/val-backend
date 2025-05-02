import express from 'express';
import { auth } from '../middleware/auth.js';
import Request from '../models/Request.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { createTransaction } from './userTransaction.js';
import { createNovelTransaction } from './novelTransactions.js';

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
    
    // Query both pending requests and approved web requests
    const requests = await Request.find({ 
      $or: [
        { status: 'pending' },
        { type: 'web', status: 'approved' }
      ]
    })
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
    const { type, title, novelId, moduleId, chapterId, deposit, note, openNow, goalBalance } = req.body;
    
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
    
    // Add novel reference for open requests only
    // Web requests now don't need a novel reference at creation time
    if (type === 'open') {
      if (!novelId) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Novel ID is required for open requests' });
      }
      requestData.novel = novelId;
      
      // Add module and chapter if provided (for open requests)
      if (moduleId) {
        requestData.module = moduleId;
      }
      
      if (chapterId) {
        requestData.chapter = chapterId;
      }
    }
    
    // Auto-approve open requests only
    if (type === 'open') {
      requestData.status = 'approved';
      requestData.openNow = true;
    }
    
    // Create request
    const newRequest = new Request(requestData);
    await newRequest.save({ session });
    
    // Only deduct deposit for non-web requests
    if (type !== 'web') {
      // Store old balance for transaction record
      const oldBalance = user.balance;
      
      // Deduct deposit from user balance
      user.balance -= deposit;
      await user.save({ session });
      
      // Record the transaction in UserTransaction ledger
      let description;
      if (type === 'open') {
        description = 'Yêu cầu mở chương truyện';
      } else if (type === 'new') {
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
    
    // Process auto-approved open requests
    let refundAmount = 0;
    
    if (type === 'open') {
      const Novel = mongoose.model('Novel');
      
      if (moduleId) {
        // Process module opening
        const Module = mongoose.model('Module');
        const module = await Module.findById(moduleId).session(session);
        
        if (module) {
          if (deposit > module.moduleBalance) {
            refundAmount = deposit - module.moduleBalance;
          }
          
          // Update module mode to "published" if balance will be 0 after this transaction
          const newMode = module.moduleBalance <= deposit ? 'published' : 'paid';
          const newBalance = Math.max(0, module.moduleBalance - deposit);
          
          // Update module
          await Module.findByIdAndUpdate(
            moduleId,
            {
              mode: newMode,
              moduleBalance: newBalance
            },
            { session }
          );
        }
      } else if (chapterId) {
        // Process chapter opening
        const Chapter = mongoose.model('Chapter');
        const chapter = await Chapter.findById(chapterId).session(session);
        
        if (chapter) {
          if (deposit > chapter.chapterBalance) {
            refundAmount = deposit - chapter.chapterBalance;
          }
          
          // Update chapter mode to "published" if balance will be 0 after this transaction
          const newMode = chapter.chapterBalance <= deposit ? 'published' : 'paid';
          const newBalance = Math.max(0, chapter.chapterBalance - deposit);
          
          // Update chapter
          await Chapter.findByIdAndUpdate(
            chapterId,
            {
              mode: newMode, 
              chapterBalance: newBalance
            },
            { session }
          );
        }
      }
      
      // Update novel balance with the appropriate amount (deposit minus any refund)
      const effectiveDeposit = deposit - refundAmount;
      if (effectiveDeposit > 0) {
        // Get current novel balance for transaction record
        const novel = await Novel.findById(novelId).session(session);
        const oldBalance = novel ? (novel.novelBalance || 0) : 0;
        const newBalance = oldBalance + effectiveDeposit;
        
        await Novel.findByIdAndUpdate(
          novelId,
          { $inc: { novelBalance: effectiveDeposit } },
          { session }
        );
        
        // Create novel transaction record
        await createNovelTransaction({
          novel: novelId,
          amount: effectiveDeposit,
          type: 'open',
          description: `Yêu cầu mở chương/tập tự động xử lí. Cọc: ${deposit}, Hoàn trả: ${refundAmount}`,
          balanceAfter: newBalance,
          sourceId: newRequest._id,
          sourceModel: 'Request',
          performedBy: req.user._id
        }, session);
      }
      
      // Process refund if needed
      if (refundAmount > 0) {
        // Add refund to user balance
        user.balance += refundAmount;
        await user.save({ session });
        
        // Record refund transaction
        await createTransaction({
          userId: user._id,
          amount: refundAmount,
          type: 'refund',
          description: 'Hoàn trả số dư sau khi mở chương/tập',
          sourceId: newRequest._id,
          sourceModel: 'Request',
          performedById: null,
          balanceAfter: user.balance
        }, session);
      }
    } else if (type === 'web' && user.role === 'admin') {
      // For admin web recommendations, we don't add to novel balance - that happens via contributions
    }
    
    // Populate user and novel data before sending response
    await newRequest.populate('user', 'username avatar role');
    if (type === 'open' || type === 'web') {
      await newRequest.populate('novel', 'title _id');
      
      // Populate module and chapter if they exist (for open requests)
      if (type === 'open' && moduleId) {
        await newRequest.populate('module', 'title _id');
      }
      
      if (type === 'open' && chapterId) {
        await newRequest.populate('chapter', 'title _id');
      }
    }
    
    await session.commitTransaction();
    
    // Add refund information to response if applicable
    const response = { ...newRequest.toObject() };
    if (refundAmount > 0) {
      response.refundAmount = refundAmount;
    }
    
    res.status(201).json(response);
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
    
    // We only process 'new' type requests here since 'open' requests are auto-processed
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
    
    // Update novel balance with deposit + all contributions
    const totalAmount = request.deposit + totalContributions;
    const oldBalance = matchingNovel.novelBalance || 0;
    const newBalance = oldBalance + totalAmount;
    
    await Novel.findByIdAndUpdate(
      matchingNovel._id, 
      { $inc: { novelBalance: totalAmount } },
      { session }
    );
    
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
            
            // Record the refund transaction
            await createTransaction({
              userId: contributor._id,
              amount: contribution.amount,
              type: 'refund',
              description: `Hoàn tiền do yêu cầu được rút lại`,
              sourceId: request._id,
              sourceModel: 'Request',
              performedById: null,
              balanceAfter: contributor.balance
            }, session);
          }
        }
      }
    }
    
    // Delete the request
    await Request.findByIdAndDelete(requestId).session(session);
    
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