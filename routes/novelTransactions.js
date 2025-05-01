import express from 'express';
import { auth } from '../middleware/auth.js';
import NovelTransaction from '../models/NovelTransaction.js';
import Novel from '../models/Novel.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Create a novel transaction record
 * @param {Object} transactionData - Data for the transaction
 * @param {mongoose.ClientSession} session - Mongoose session for transaction
 * @returns {Promise<Object>} Created transaction
 */
export const createNovelTransaction = async (transactionData, session = null) => {
  try {
    const transaction = new NovelTransaction(transactionData);
    if (session) {
      await transaction.save({ session });
    } else {
      await transaction.save();
    }
    return transaction;
  } catch (error) {
    console.error('Error creating novel transaction:', error);
    throw error;
  }
};

/**
 * Get transactions for a specific novel
 * @route GET /api/novel-transactions
 */
router.get('/', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const { novelId, limit = 20, offset = 0 } = req.query;
    
    if (!novelId) {
      return res.status(400).json({ message: 'Novel ID is required' });
    }

    // Verify the novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    // Find transactions for this novel
    const transactions = await NovelTransaction.find({ novel: novelId })
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .populate('performedBy', 'username')
      .populate('novel', 'title');

    // Get total count for pagination
    const total = await NovelTransaction.countDocuments({ novel: novelId });

    res.json({
      transactions,
      pagination: {
        total,
        offset: parseInt(offset),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error fetching novel transactions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Search novels by title
 * @route GET /api/novel-transactions/search-novels
 */
router.get('/search-novels', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const { query } = req.query;
    
    if (!query || query.length < 2) {
      return res.status(400).json({ message: 'Search query must be at least 2 characters' });
    }

    // Search novels by title
    const novels = await Novel.find({
      $or: [
        { title: { $regex: query, $options: 'i' } },
        { alternativeTitles: { $regex: query, $options: 'i' } }
      ]
    })
    .select('_id title illustration novelBalance')
    .limit(5);

    res.json(novels);
  } catch (error) {
    console.error('Error searching novels:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router; 