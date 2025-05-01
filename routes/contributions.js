import express from 'express';
import { auth } from '../middleware/auth.js';
import Contribution from '../models/Contribution.js';
import Request from '../models/Request.js';
import User from '../models/User.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Create a new contribution to a request
 * @route POST /api/contributions
 */
router.post('/', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { requestId, amount, note } = req.body;
    
    // Validate contribution amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Invalid contribution amount' });
    }
    
    // Find the request
    const request = await Request.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Request not found' });
    }
    
    // Verify request is still pending or is a web request that's approved
    // Web requests from translation team can receive contributions even when approved
    if (request.status !== 'pending' && !(request.type === 'web' && request.status === 'approved')) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Cannot contribute to a processed request' });
    }
    
    // Find user and check balance
    const user = await User.findById(req.user._id).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Validate user has enough balance
    if (user.balance < amount) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Insufficient balance' });
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
    
    // Create contribution
    const newContribution = new Contribution(contributionData);
    await newContribution.save({ session });
    
    // Deduct contribution amount from user balance
    user.balance -= amount;
    await user.save({ session });
    
    // Populate user data before sending response
    await newContribution.populate('user', 'username avatar role');
    
    await session.commitTransaction();
    
    res.status(201).json(newContribution);
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to create contribution:', error);
    res.status(500).json({ message: 'Failed to create contribution' });
  } finally {
    session.endSession();
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
      .populate('user', 'username avatar role')
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
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can approve contributions' });
    }
    
    const { contributionId } = req.params;
    
    // Find contribution
    const contribution = await Contribution.findById(contributionId).session(session)
      .populate('request');
      
    if (!contribution) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Contribution not found' });
    }
    
    // Check if contribution is already processed
    if (contribution.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Contribution has already been processed' });
    }
    
    // Update contribution status
    contribution.status = 'approved';
    await contribution.save({ session });
    
    // Handle contribution amount based on request type
    if (contribution.request.type === 'open' && contribution.request.novel) {
      // For chapter opening requests, add contribution to novel balance
      const Novel = mongoose.model('Novel');
      await Novel.findByIdAndUpdate(
        contribution.request.novel,
        { $inc: { novelBalance: contribution.amount } },
        { session }
      );
    }
    
    await session.commitTransaction();
    res.json({ message: 'Contribution approved successfully' });
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to approve contribution:', error);
    res.status(500).json({ message: 'Failed to approve contribution' });
  } finally {
    session.endSession();
  }
});

/**
 * Decline contribution (admin only)
 * @route POST /api/contributions/:contributionId/decline
 */
router.post('/:contributionId/decline', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can decline contributions' });
    }
    
    const { contributionId } = req.params;
    
    // Find contribution
    const contribution = await Contribution.findById(contributionId).session(session);
    if (!contribution) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Contribution not found' });
    }
    
    // Check if contribution is already processed
    if (contribution.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Contribution has already been processed' });
    }
    
    // Find user to refund contribution
    const user = await User.findById(contribution.user).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Update contribution status
    contribution.status = 'declined';
    await contribution.save({ session });
    
    // Refund contribution to user
    user.balance += contribution.amount;
    await user.save({ session });
    
    await session.commitTransaction();
    res.json({ message: 'Contribution declined and amount refunded' });
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to decline contribution:', error);
    res.status(500).json({ message: 'Failed to decline contribution' });
  } finally {
    session.endSession();
  }
});

/**
 * Approve all contributions for a request (admin only)
 * @route POST /api/contributions/request/:requestId/approve-all
 */
router.post('/request/:requestId/approve-all', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can process contributions' });
    }
    
    const { requestId } = req.params;
    
    // Find request
    const request = await Request.findById(requestId).session(session);
    if (!request) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Request not found' });
    }
    
    // Find all pending contributions for this request
    const contributions = await Contribution.find({ 
      request: requestId,
      status: 'pending'
    }).session(session);
    
    if (contributions.length === 0) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'No pending contributions found' });
    }
    
    // Update all contributions to approved
    await Contribution.updateMany(
      { request: requestId, status: 'pending' },
      { status: 'approved' },
      { session }
    );
    
    // If request is for a novel opening, add all contributions to novel balance
    if (request.type === 'open' && request.novel) {
      const totalAmount = contributions.reduce((sum, contribution) => sum + contribution.amount, 0);
      
      // Add total contribution amount to novel balance
      const Novel = mongoose.model('Novel');
      await Novel.findByIdAndUpdate(
        request.novel,
        { $inc: { novelBalance: totalAmount } },
        { session }
      );
    }
    
    await session.commitTransaction();
    res.json({ 
      message: 'All contributions approved successfully',
      count: contributions.length
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to approve all contributions:', error);
    res.status(500).json({ message: 'Failed to approve all contributions' });
  } finally {
    session.endSession();
  }
});

/**
 * Decline all contributions for a request (admin only)
 * @route POST /api/contributions/request/:requestId/decline-all
 */
router.post('/request/:requestId/decline-all', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can process contributions' });
    }
    
    const { requestId } = req.params;
    
    // Find all pending contributions for this request
    const contributions = await Contribution.find({ 
      request: requestId,
      status: 'pending'
    }).session(session);
    
    if (contributions.length === 0) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'No pending contributions found' });
    }
    
    // Update all contributions to declined
    await Contribution.updateMany(
      { request: requestId, status: 'pending' },
      { status: 'declined' },
      { session }
    );
    
    // Refund each user
    for (const contribution of contributions) {
      const user = await User.findById(contribution.user).session(session);
      if (user) {
        user.balance += contribution.amount;
        await user.save({ session });
      }
    }
    
    await session.commitTransaction();
    res.json({ 
      message: 'All contributions declined and refunded',
      count: contributions.length
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to decline all contributions:', error);
    res.status(500).json({ message: 'Failed to decline all contributions' });
  } finally {
    session.endSession();
  }
});

export default router; 