import express from 'express';
import { auth } from '../middleware/auth.js';
import Contribution from '../models/Contribution.js';
import Request from '../models/Request.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { createNovelTransaction } from './novelTransactions.js';
import { createTransaction } from './userTransaction.js';
import { clearUserCache } from '../utils/userCache.js';
import ContributionHistory from '../models/ContributionHistory.js';

const router = express.Router();

/**
 * Retry wrapper for handling transient transaction errors
 */
async function withTransactionRetry(operation, maxRetries = 3) {
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      // Check if this is a transient transaction error that can be retried
      if (error.errorLabels && error.errorLabels.includes('TransientTransactionError')) {
        retryCount++;
        console.log(`Transaction failed with transient error, retry attempt ${retryCount}/${maxRetries}`);
        
        if (retryCount >= maxRetries) {
          console.error('Max retries reached for transaction');
          throw error;
        }
        
        // Add exponential backoff delay
        const delay = Math.min(100 * Math.pow(2, retryCount - 1), 1000);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // If it's not a transient error, throw immediately
      throw error;
    }
  }
}

/**
 * Create a new contribution to a request
 * @route POST /api/contributions
 */
router.post('/', auth, async (req, res) => {
  try {
    const result = await withTransactionRetry(async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      
      try {
        const { requestId, amount, note } = req.body;
        
        // Validate contribution amount
        if (!amount || isNaN(amount) || amount <= 0) {
          throw new Error('Invalid contribution amount');
        }
        
        // Find the request
        const request = await Request.findById(requestId).session(session);
        if (!request) {
          throw new Error('Request not found');
        }
        
        // Verify request is still pending
        if (request.status !== 'pending') {
          throw new Error('Cannot contribute to a processed request');
        }
        
        // Find user and check balance
        const user = await User.findById(req.user._id).session(session);
        if (!user) {
          throw new Error('User not found');
        }
        
        // Validate user has enough balance
        if (user.balance < amount) {
          throw new Error('Insufficient balance');
        }
        
        // Create contribution object
        const contributionData = {
          user: req.user._id,
          request: requestId,
          amount: Number(amount)
        };
        
        // Add note if provided
        if (note) {
          contributionData.note = note;
        }
        
        console.log(`💰 [Market Contribution] Starting contribution: ${amount} 🌾 for request ${requestId}`);
        console.log(`💰 [Market Contribution] User balance before contribution: ${user.balance} 🌾`);

        // Create contribution (all contributions start as pending)
        const newContribution = new Contribution(contributionData);
        await newContribution.save({ session });
        
        // Deduct contribution amount from user balance
        user.balance -= amount;
        await user.save({ session });
        console.log(`💰 [Market Contribution] User balance after contribution: ${user.balance} 🌾`);
        
        // Clear user cache to ensure fresh balance is returned by API calls
        clearUserCache(user._id, user.username);
        console.log(`🗑️ [Market Contribution] Cleared user cache for ${user.username} (ID: ${user._id})`);
        console.log(`📡 [Market Contribution] Dispatching balanceUpdated event for ${user.username}`);
        
        // Record transaction in UserTransaction ledger
        await createTransaction({
          userId: req.user._id,
          amount: -amount, // Negative amount since balance is deducted
          type: 'contribution',
          description: `Đóng góp cho yêu cầu: ${request.title || 'Yêu cầu không có tiêu đề'}${note ? ` - ${note}` : ''}`,
          sourceId: newContribution._id,
          sourceModel: 'Contribution',
          performedById: req.user._id,
          balanceAfter: user.balance
        }, session);
        
        // Populate user data before sending response
        await newContribution.populate('user', 'username displayName avatar role');
        
        await session.commitTransaction();
        return newContribution;
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    });
    
    res.status(201).json(result);
  } catch (error) {
    console.error('Failed to create contribution:', error);
    
    // Handle specific error types
    if (error.message === 'Invalid contribution amount') {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === 'Request not found') {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === 'Cannot contribute to a processed request') {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === 'User not found') {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === 'Insufficient balance') {
      return res.status(400).json({ message: error.message });
    }
    
    res.status(500).json({ message: 'Failed to create contribution' });
  }
});

/**
 * Get contributions for a specific request
 * @route GET /api/contributions/request/:requestId
 */
router.get('/request/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    
    // Find contributions for the request
    const contributions = await Contribution.find({ request: requestId })
      .populate('user', 'username displayName avatar role')
      .sort({ createdAt: -1 });
    
    res.json(contributions);
  } catch (error) {
    console.error('Failed to fetch contributions:', error);
    res.status(500).json({ message: 'Failed to fetch contributions' });
  }
});

/**
 * Approve contribution (admin only)
 * @route POST /api/contributions/:contributionId/approve
 */
router.post('/:contributionId/approve', auth, async (req, res) => {
  try {
    await withTransactionRetry(async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      
      try {
        // Verify user is admin
        if (req.user.role !== 'admin') {
          throw new Error('Only admins can approve contributions');
        }
        
        const { contributionId } = req.params;
        
        // Find contribution
        const contribution = await Contribution.findById(contributionId).session(session)
          .populate('request');
          
        if (!contribution) {
          throw new Error('Contribution not found');
        }
        
        // Check if contribution is already processed
        if (contribution.status !== 'pending') {
          throw new Error('Contribution has already been processed');
        }
        
        // Update contribution status
        contribution.status = 'approved';
        await contribution.save({ session });
        
        // Handle contribution amount based on request type
        // Note: Currently only 'new' and 'web' request types are supported
        // This section is reserved for future request type handling if needed
        
        await session.commitTransaction();
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    });
    
    res.json({ message: 'Contribution approved successfully' });
  } catch (error) {
    console.error('Failed to approve contribution:', error);
    
    // Handle specific error types
    if (error.message === 'Only admins can approve contributions') {
      return res.status(403).json({ message: error.message });
    }
    if (error.message === 'Contribution not found') {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === 'Contribution has already been processed') {
      return res.status(400).json({ message: error.message });
    }
    
    res.status(500).json({ message: 'Failed to approve contribution' });
  }
});

/**
 * Approve all contributions for a request (admin only)
 * @route POST /api/contributions/request/:requestId/approve-all
 */
router.post('/request/:requestId/approve-all', auth, async (req, res) => {
  try {
    const result = await withTransactionRetry(async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      
      try {
        // Verify user is admin
        if (req.user.role !== 'admin') {
          throw new Error('Only admins can process contributions');
        }
        
        const { requestId } = req.params;
        
        // Find request
        const request = await Request.findById(requestId).session(session);
        if (!request) {
          throw new Error('Request not found');
        }
        
        // Find all pending contributions for this request
        const contributions = await Contribution.find({ 
          request: requestId,
          status: 'pending'
        }).session(session);
        
        if (contributions.length === 0) {
          throw new Error('No pending contributions found');
        }
        
        // Update all contributions to approved
        await Contribution.updateMany(
          { request: requestId, status: 'pending' },
          { status: 'approved' },
          { session }
        );
        
        // Note: Individual contributions are now handled through request approval flow
        // All contributions for 'new' and 'web' requests are processed when the request is approved
        
        await session.commitTransaction();
        return { count: contributions.length };
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    });
    
    res.json({ 
      message: 'All contributions approved successfully',
      count: result.count
    });
  } catch (error) {
    console.error('Failed to approve all contributions:', error);
    
    // Handle specific error types
    if (error.message === 'Only admins can process contributions') {
      return res.status(403).json({ message: error.message });
    }
    if (error.message === 'Request not found') {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === 'No pending contributions found') {
      return res.status(404).json({ message: error.message });
    }
    
    res.status(500).json({ message: 'Failed to approve all contributions' });
  }
});

/**
 * Decline all contributions for a request (admin only)
 * @route POST /api/contributions/request/:requestId/decline-all
 */
router.post('/request/:requestId/decline-all', auth, async (req, res) => {
  try {
    const result = await withTransactionRetry(async () => {
      const session = await mongoose.startSession();
      session.startTransaction();
      
      try {
        // Verify user is admin
        if (req.user.role !== 'admin') {
          throw new Error('Only admins can process contributions');
        }
        
        const { requestId } = req.params;
        
        // Find the request
        const request = await Request.findById(requestId).session(session);
        if (!request) {
          throw new Error('Request not found');
        }
        
        // Find all pending contributions for this request
        const contributions = await Contribution.find({ 
          request: requestId,
          status: 'pending'
        }).session(session);
        
        if (contributions.length === 0) {
          throw new Error('No pending contributions found');
        }
        
        // Update all contributions to declined
        await Contribution.updateMany(
          { request: requestId, status: 'pending' },
          { status: 'declined' },
          { session }
        );
        
        // Refund each user and record transactions
        for (const contribution of contributions) {
          const user = await User.findById(contribution.user).session(session);
          if (user) {
            console.log(`💰 [Contribution Refund] Refunding ${contribution.amount} 🌾 to ${user.username}`);
            console.log(`💰 [Contribution Refund] User balance before refund: ${user.balance} 🌾`);
            
            user.balance += contribution.amount;
            await user.save({ session });
            console.log(`💰 [Contribution Refund] User balance after refund: ${user.balance} 🌾`);
            
            // Clear user cache to ensure fresh balance is returned by API calls
            clearUserCache(user._id, user.username);
            console.log(`🗑️ [Contribution Refund] Cleared user cache for ${user.username} (ID: ${user._id})`);
            
            // Record refund transaction
            await createTransaction({
              userId: user._id,
              amount: contribution.amount, // Positive amount since balance is increased
              type: 'refund',
              description: `Hoàn tiền đóng góp cho yêu cầu: ${request.title || 'Yêu cầu không có tiêu đề'} (bị từ chối)`,
              sourceId: contribution._id,
              sourceModel: 'Contribution',
              performedById: req.user._id,
              balanceAfter: user.balance
            }, session);
          }
        }
        
        await session.commitTransaction();
        return { count: contributions.length };
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    });
    
    res.json({ 
      message: 'All contributions declined and refunded',
      count: result.count
    });
  } catch (error) {
    console.error('Failed to decline all contributions:', error);
    
    // Handle specific error types
    if (error.message === 'Only admins can process contributions') {
      return res.status(403).json({ message: error.message });
    }
    if (error.message === 'Request not found') {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === 'No pending contributions found') {
      return res.status(404).json({ message: error.message });
    }
    
    res.status(500).json({ message: 'Failed to decline all contributions' });
  }
});

export default router; 