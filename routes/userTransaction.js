import express from 'express';
import { auth } from '../middleware/auth.js';
import UserTransaction from '../models/UserTransaction.js';
import User from '../models/User.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Get all transactions for a specific user (Admin only)
 * @route GET /api/transactions/user/:userId
 */
router.get('/user/:userId', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    const { userId } = req.params;
    const { limit = 100, offset = 0, type } = req.query;
    
    // Build query
    const query = { user: userId };
    
    // Add type filter if provided
    if (type) {
      query.type = type;
    }
    
    // Get transactions with pagination
    const transactions = await UserTransaction.find(query)
      .sort({ createdAt: -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .populate('user', 'username displayName avatar')
      .populate('performedBy', 'username displayName role');
    
    // Get total count for pagination
    const total = await UserTransaction.countDocuments(query);
    
    res.json({
      transactions,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    console.error('Failed to fetch user transactions:', error);
    res.status(500).json({ message: 'Failed to fetch transactions' });
  }
});

/**
 * Get current user's transaction history
 * @route GET /api/transactions/me
 */
router.get('/me', auth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;
    
    // Build query
    const query = { user: req.user._id };
    
    // Add type filter if provided
    if (type) {
      query.type = type;
    }
    
    // Get transactions with pagination
    const transactions = await UserTransaction.find(query)
      .sort({ createdAt: -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .populate('performedBy', 'username displayName role');
    
    // Get total count for pagination
    const total = await UserTransaction.countDocuments(query);
    
    res.json({
      transactions,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    console.error('Failed to fetch transaction history:', error);
    res.status(500).json({ message: 'Failed to fetch transaction history' });
  }
});

/**
 * Create a new transaction record (internal use by other endpoints)
 * This helper function can be used in other routes to create transaction records
 * @param {Object} transactionData - Transaction data
 * @param {Object} session - Mongoose session for transaction
 */
export const createTransaction = async (transactionData, session) => {
  try {
    const { 
      userId, 
      amount, 
      type, 
      description, 
      sourceId,
      sourceModel,
      metadata,
      performedById
    } = transactionData;
    
    // Get current user balance
    const user = await User.findById(userId).session(session);
    if (!user) {
      throw new Error('User not found');
    }
    
    // Create transaction record
    const transaction = new UserTransaction({
      user: userId,
      amount,
      type,
      balanceAfter: user.balance || 0,
      description,
      sourceId,
      sourceModel,
      metadata: metadata || {},
      performedBy: performedById
    });
    
    await transaction.save({ session });
    return transaction;
  } catch (error) {
    console.error('Failed to create transaction record:', error);
    throw error;
  }
};

/**
 * Get all transactions (Admin only)
 * @route GET /api/transactions
 */
router.get('/', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    const { limit = 100, offset = 0, type, username } = req.query;
    
    // Build query
    const query = {};
    
    // Add type filter if provided
    if (type) {
      query.type = type;
    }
    
    // Find by username if provided
    if (username) {
      const user = await User.findOne({ username });
      if (user) {
        query.user = user._id;
      } else {
        // If username is provided but not found, return empty results
        return res.json({
          transactions: [],
          pagination: {
            total: 0,
            limit: Number(limit),
            offset: Number(offset)
          }
        });
      }
    }
    
    // Get transactions with pagination
    const transactions = await UserTransaction.find(query)
      .sort({ createdAt: -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .populate('user', 'username displayName avatar')
      .populate('performedBy', 'username displayName role');
    
    // Get total count for pagination
    const total = await UserTransaction.countDocuments(query);
    
    res.json({
      transactions,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset)
      }
    });
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
    res.status(500).json({ message: 'Failed to fetch transactions' });
  }
});

/**
 * Get transactions by username (Admin only)
 * @route GET /api/transactions/user-transactions
 */
router.get('/user-transactions', auth, async (req, res) => {
  try {
    // Verify user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    const { limit = 100, offset = 0, type, username } = req.query;
    
    // Username is required
    if (!username) {
      return res.json({
        transactions: [],
        pagination: {
          total: 0,
          limit: Number(limit),
          offset: Number(offset)
        }
      });
    }
    
    // Find user by username
    const user = await User.findOne({ username });
    if (!user) {
      return res.json({
        transactions: [],
        pagination: {
          total: 0,
          limit: Number(limit),
          offset: Number(offset)
        }
      });
    }
    
    // Build query
    const query = { user: user._id };
    
    // Add type filter if provided
    if (type) {
      query.type = type;
    }
    
    try {
      // Get transactions with pagination
      const transactions = await UserTransaction.find(query)
        .sort({ createdAt: -1 })
        .skip(Number(offset))
        .limit(Number(limit))
        .populate('user', 'username displayName avatar')
        .populate({
          path: 'performedBy',
          select: 'username displayName role',
          // Handle case where the performedBy user might not exist
          match: { _id: { $ne: null } }
        });
      
      // Get total count for pagination
      const total = await UserTransaction.countDocuments(query);
      
      // Process transactions to handle null performedBy values
      const processedTransactions = transactions.map(transaction => {
        // Convert to plain object if it's a Mongoose document
        const plainTransaction = transaction.toObject ? transaction.toObject() : { ...transaction };
        
        // If performedBy is null but there's a performedBy ID, it means the user might have been deleted
        if (!plainTransaction.performedBy && plainTransaction.performedBy === null) {
          plainTransaction.performedBy = { username: 'Unknown User', role: 'unknown' };
        }
        
        return plainTransaction;
      });
      
      res.json({
        transactions: processedTransactions,
        pagination: {
          total,
          limit: Number(limit),
          offset: Number(offset)
        }
      });
    } catch (queryError) {
      console.error('Error in transaction query:', queryError);
      return res.status(500).json({ message: 'Error querying transactions' });
    }
  } catch (error) {
    console.error('Failed to fetch user transactions by username:', error);
    res.status(500).json({ message: 'Failed to fetch transactions' });
  }
});

export default router;

/**
 * Create both user and novel transaction records for module rental
 * @param {Object} rentalData - Rental transaction data
 * @param {Object} session - Mongoose session for transaction
 */
export const createRentalTransactions = async (rentalData, session) => {
  try {
    const { 
      userId, 
      novelId, 
      moduleTitle, 
      rentalAmount, 
      userBalanceAfter, 
      novelBalanceAfter, 
      rentalId,
      username
    } = rentalData;
    
    // Import novel transaction function
    const { createNovelTransaction } = await import('./novelTransactions.js');
    
    // Create user transaction record (deduction)
    const userTransaction = await createTransaction({
      userId: userId,
      amount: -rentalAmount,
      type: 'rental',
      description: `Mở tạm thời tập "${moduleTitle}" (7 ngày)`,
      sourceId: rentalId,
      sourceModel: 'ModuleRental'
    }, session);
    
    // Create novel transaction record (addition)
    const novelTransaction = await createNovelTransaction({
      novel: novelId,
      amount: rentalAmount,
      type: 'rental',
      description: `Mở tạm thời tập "${moduleTitle}" (7 ngày) bởi ${username}`,
      balanceAfter: novelBalanceAfter,
      sourceId: rentalId,
      sourceModel: 'ModuleRental',
      performedBy: userId
    }, session);
    
    return {
      userTransaction,
      novelTransaction
    };
  } catch (error) {
    console.error('Failed to create rental transactions:', error);
    throw error;
  }
}; 