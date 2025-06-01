import express from 'express';
import { auth } from '../middleware/auth.js';
import Gift from '../models/Gift.js';
import NovelGift from '../models/NovelGift.js';
import GiftTransaction from '../models/GiftTransaction.js';
import Novel from '../models/Novel.js';
import User from '../models/User.js';
import ContributionHistory from '../models/ContributionHistory.js';
import { createTransaction } from './userTransaction.js';
import { createNovelTransaction } from './novelTransactions.js';
import mongoose from 'mongoose';

const router = express.Router();

// Simple in-memory cache for gifts to avoid repeated aggregations
const giftsCache = new Map();
const GIFTS_CACHE_TTL = 1000 * 60 * 2; // 2 minutes (shorter for dynamic data)
const MAX_GIFTS_CACHE_SIZE = 500;

// Query deduplication cache
const pendingGiftQueries = new Map();

// Helper function to manage gifts cache
const getCachedGifts = (novelId) => {
  const cached = giftsCache.get(novelId);
  if (cached && Date.now() - cached.timestamp < GIFTS_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedGifts = (novelId, data) => {
  // Remove oldest entries if cache is too large
  if (giftsCache.size >= MAX_GIFTS_CACHE_SIZE) {
    const oldestKey = giftsCache.keys().next().value;
    giftsCache.delete(oldestKey);
  }
  
  giftsCache.set(novelId, {
    data,
    timestamp: Date.now()
  });
};

// Clear gifts cache for a specific novel
const clearGiftsCache = (novelId) => {
  giftsCache.delete(novelId);
};

// Query deduplication helper for gifts
const dedupGiftQuery = async (key, queryFn) => {
  if (pendingGiftQueries.has(key)) {
    return await pendingGiftQueries.get(key);
  }
  
  const queryPromise = queryFn();
  pendingGiftQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    pendingGiftQueries.delete(key);
  }
};

// Get all available gifts
router.get('/', async (req, res) => {
  try {
    const gifts = await Gift.find().sort({ order: 1 });
    res.json(gifts);
  } catch (error) {
    console.error('Error fetching gifts:', error);
    res.status(500).json({ message: 'Lỗi khi tải danh sách quà tặng' });
  }
});

// Get gift counts for a specific novel (OPTIMIZED)
router.get('/novel/:novelId', async (req, res) => {
  try {
    const { novelId } = req.params;
    
    // Check cache first
    const cached = getCachedGifts(novelId);
    if (cached) {
      return res.json(cached);
    }
    
    // Use query deduplication to prevent multiple identical requests
    const giftCounts = await dedupGiftQuery(`novel-gifts:${novelId}`, async () => {
      // Get all gifts with their counts for this novel
      return await Gift.aggregate([
        {
          $lookup: {
            from: 'novelgifts',
            let: { giftId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$giftId', '$$giftId'] },
                      { $eq: ['$novelId', new mongoose.Types.ObjectId(novelId)] }
                    ]
                  }
                }
              }
            ],
            as: 'novelGift'
          }
        },
        {
          $addFields: {
            count: {
              $ifNull: [{ $arrayElemAt: ['$novelGift.count', 0] }, 0]
            }
          }
        },
        {
          $project: {
            _id: 1,
            name: 1,
            icon: 1,
            price: 1,
            order: 1,
            count: 1
          }
        },
        {
          $sort: { order: 1 }
        }
      ]);
    });

    // Cache the result for future requests
    setCachedGifts(novelId, giftCounts);
    
    res.json(giftCounts);
  } catch (error) {
    console.error('Error fetching novel gifts:', error);
    res.status(500).json({ message: 'Lỗi khi tải quà tặng của truyện' });
  }
});

// Send a gift to a novel
router.post('/send', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { novelId, giftId } = req.body;
    const userId = req.user._id;

    // Validate input
    if (!novelId || !giftId) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Thiếu thông tin novelId hoặc giftId' });
    }

    // Get gift information
    const gift = await Gift.findById(giftId).session(session);
    if (!gift) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Quà tặng không tồn tại' });
    }

    // Get user information
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    // Check if user has enough balance
    if (user.balance < gift.price) {
      await session.abortTransaction();
      return res.status(400).json({ 
        message: `Số dư không đủ. Bạn cần ${gift.price} 🌾 nhưng chỉ có ${user.balance} 🌾` 
      });
    }

    // Get novel information
    const novel = await Novel.findById(novelId).session(session);
    if (!novel) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Truyện không tồn tại' });
    }

    // Calculate balances
    const userBalanceBefore = user.balance;
    const userBalanceAfter = userBalanceBefore - gift.price;
    const novelBalanceBefore = novel.novelBalance || 0;
    const novelBalanceAfter = novelBalanceBefore + gift.price;

    // Update user balance
    await User.findByIdAndUpdate(
      userId,
      { $inc: { balance: -gift.price } },
      { session }
    );

    // Update novel balance (only novelBalance, not novelBudget)
    await Novel.findByIdAndUpdate(
      novelId,
      { $inc: { novelBalance: gift.price } },
      { session }
    );

    // Update or create novel gift count
    await NovelGift.findOneAndUpdate(
      { novelId, giftId },
      { $inc: { count: 1 } },
      { upsert: true, session }
    );

    // Create gift transaction record
    const giftTransaction = new GiftTransaction({
      userId,
      novelId,
      giftId,
      amount: gift.price,
      userBalanceBefore,
      userBalanceAfter,
      novelBalanceBefore,
      novelBalanceAfter
    });
    await giftTransaction.save({ session });

    // Create user transaction record for the ledger
    await createTransaction({
      userId,
      amount: -gift.price, // Negative amount for deduction
      type: 'gift',
      description: `Tặng ${gift.icon} ${gift.name} cho "${novel.title}"`,
      sourceId: giftTransaction._id,
      sourceModel: 'GiftTransaction',
      performedById: userId
    }, session);

    // Create novel transaction record
    await createNovelTransaction({
      novel: novelId,
      type: 'gift_received',
      amount: gift.price,
      balanceAfter: novelBalanceAfter,
      description: `Nhận quà tặng ${gift.icon} ${gift.name} từ ${user.username}`,
      sourceId: giftTransaction._id,
      sourceModel: 'GiftTransaction',
      performedBy: userId
    }, session);

    // Create contribution history record
    await ContributionHistory.create([{
      novelId,
      userId,
      amount: gift.price,
      note: `Quà tặng ${gift.icon} ${gift.name}`,
      budgetAfter: novel.novelBudget || 0, // Budget doesn't change for gifts
      balanceAfter: novelBalanceAfter,
      type: 'gift'
    }], { session });

    await session.commitTransaction();

    // Clear gifts cache for this novel since counts have changed
    clearGiftsCache(novelId);

    res.json({
      message: `Đã tặng ${gift.icon} ${gift.name} thành công!`,
      userBalanceAfter,
      novelBalanceAfter,
      gift: {
        name: gift.name,
        icon: gift.icon,
        price: gift.price
      }
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Error sending gift:', error);
    res.status(500).json({ message: 'Lỗi khi gửi quà tặng' });
  } finally {
    session.endSession();
  }
});

// Get gift transaction history for a user
router.get('/transactions/user', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const transactions = await GiftTransaction.find({ userId })
      .populate('giftId', 'name icon price')
      .populate('novelId', 'title')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await GiftTransaction.countDocuments({ userId });

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
    console.error('Error fetching user gift transactions:', error);
    res.status(500).json({ message: 'Lỗi khi tải lịch sử quà tặng' });
  }
});

// Get gift transaction history for a novel
router.get('/transactions/novel/:novelId', async (req, res) => {
  try {
    const { novelId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const transactions = await GiftTransaction.find({ novelId })
      .populate('giftId', 'name icon price')
      .populate('userId', 'username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await GiftTransaction.countDocuments({ novelId });

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
    console.error('Error fetching novel gift transactions:', error);
    res.status(500).json({ message: 'Lỗi khi tải lịch sử quà tặng của truyện' });
  }
});

export default router; 