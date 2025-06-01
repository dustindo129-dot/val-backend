import express from 'express';
import Notification from '../models/Notification.js';
import { auth } from '../middleware/auth.js';
import { broadcastEvent } from '../services/sseService.js';
import mongoose from 'mongoose';

const router = express.Router();

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

// Helper function for query deduplication
const dedupQuery = async (key, queryFn) => {
  // If query is already pending, wait for it
  if (pendingQueries.has(key)) {
    return await pendingQueries.get(key);
  }
  
  // Start new query
  const queryPromise = queryFn();
  pendingQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    // Clean up pending query
    pendingQueries.delete(key);
  }
};

/**
 * Get user notifications with combined stats (OPTIMIZED)
 * This endpoint combines notifications list, unread count, and total count in one query
 * @route GET /api/notifications/combined
 */
router.get('/combined', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const userId = req.user._id;
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(`notifications:${userId}:${pageNum}:${limitNum}`, async () => {
      // Calculate skip based on infinite scroll pattern
      let skip;
      if (pageNum === 1) {
        skip = 0;
      } else {
        skip = 20 + (pageNum - 2) * 10;
      }

      // Single aggregation that gets notifications, unread count, and total count
      const [aggregationResult] = await Notification.aggregate([
        // Match notifications for this user
        {
          $match: { userId: new mongoose.Types.ObjectId(userId) }
        },
        
        // Use $facet to run multiple pipelines in parallel
        {
          $facet: {
            // Get notifications with pagination
            notifications: [
              { $sort: { createdAt: -1 } },
              { $skip: skip },
              { $limit: limitNum },
              // Lookup related user
              {
                $lookup: {
                  from: 'users',
                  localField: 'relatedUser',
                  foreignField: '_id',
                  pipeline: [
                    { $project: { username: 1, displayName: 1, avatar: 1 } }
                  ],
                  as: 'relatedUserInfo'
                }
              },
              // Lookup related novel
              {
                $lookup: {
                  from: 'novels',
                  localField: 'relatedNovel',
                  foreignField: '_id',
                  pipeline: [
                    { $project: { title: 1 } }
                  ],
                  as: 'relatedNovelInfo'
                }
              },
              // Lookup related chapter
              {
                $lookup: {
                  from: 'chapters',
                  localField: 'relatedChapter',
                  foreignField: '_id',
                  pipeline: [
                    { $project: { title: 1 } }
                  ],
                  as: 'relatedChapterInfo'
                }
              },
              // Format the output to match existing structure
              {
                $addFields: {
                  relatedUser: { $arrayElemAt: ['$relatedUserInfo', 0] },
                  relatedNovel: { $arrayElemAt: ['$relatedNovelInfo', 0] },
                  relatedChapter: { $arrayElemAt: ['$relatedChapterInfo', 0] }
                }
              },
              // Remove the temporary lookup fields
              {
                $project: {
                  relatedUserInfo: 0,
                  relatedNovelInfo: 0,
                  relatedChapterInfo: 0
                }
              }
            ],
            
            // Get unread count
            unreadCount: [
              {
                $match: { isRead: false }
              },
              {
                $count: 'count'
              }
            ],
            
            // Get total count
            totalCount: [
              {
                $count: 'count'
              }
            ]
          }
        }
      ]);

      const notifications = aggregationResult?.notifications || [];
      const unreadCount = aggregationResult?.unreadCount[0]?.count || 0;
      const totalItems = aggregationResult?.totalCount[0]?.count || 0;

      return {
        notifications,
        unreadCount,
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(Math.max(0, totalItems - 20) / 10) + 1,
          totalItems: totalItems
        }
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Không thể tải thông báo' });
  }
});

// Get user notifications
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const userId = req.user._id;
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(`notifications-legacy:${userId}:${pageNum}:${limitNum}`, async () => {
      // Calculate skip based on our infinite scroll pattern:
      // Page 1: 20 items (skip = 0)
      // Page 2: 10 items (skip = 20) 
      // Page 3: 10 items (skip = 30)
      // Page 4: 10 items (skip = 40)
      // etc.
      let skip;
      if (pageNum === 1) {
        skip = 0;
      } else {
        // For pages 2+, we skip the first 20 items from page 1, 
        // then (page-2) * 10 additional items from previous pages
        skip = 20 + (pageNum - 2) * 10;
      }

      const [notifications, totalItems] = await Promise.all([
        Notification.find({ 
          userId: userId 
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('relatedUser', 'username displayName avatar')
        .populate('relatedNovel', 'title')
        .populate('relatedChapter', 'title'),
        
        Notification.countDocuments({ userId: userId })
      ]);

      return {
        notifications,
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil((totalItems - 20) / 10) + 1, // Adjusted for our pattern
          totalItems: totalItems
        }
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Không thể tải thông báo' });
  }
});

// Get unread notification count
router.get('/unread-count', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Use query deduplication to prevent multiple identical requests
    const count = await dedupQuery(`unread-count:${userId}`, async () => {
      return await Notification.countDocuments({
        userId: userId,
        isRead: false
      });
    });

    res.json({ count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ message: 'Không thể tải số thông báo chưa đọc' });
  }
});

// Mark all notifications as read
router.put('/read-all', auth, async (req, res) => {
  try {
    await Notification.updateMany(
      { 
        userId: req.user._id,
        isRead: false
      },
      { isRead: true }
    );

    // Broadcast notifications cleared event
    broadcastEvent('notifications_cleared', {
      userId: req.user._id,
      allRead: true
    });

    res.json({ message: 'Đã đánh dấu tất cả thông báo đã đọc' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: 'Không thể đánh dấu tất cả thông báo đã đọc' });
  }
});

// Delete all notifications
router.delete('/delete-all', auth, async (req, res) => {
  try {
    await Notification.deleteMany({
      userId: req.user._id
    });

    // Broadcast notifications deleted event
    broadcastEvent('notifications_deleted', {
      userId: req.user._id,
      allDeleted: true
    });

    res.json({ message: 'Đã xóa tất cả thông báo' });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({ message: 'Không thể xóa tất cả thông báo' });
  }
});

// Mark notification as read
router.put('/:id/read', auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { 
        _id: req.params.id, 
        userId: req.user._id 
      },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Không tìm thấy thông báo' });
    }

    // Broadcast notification read event
    broadcastEvent('notification_read', {
      userId: req.user._id,
      notificationId: req.params.id,
      isRead: true
    });

    res.json(notification);
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: 'Không thể đánh dấu thông báo đã đọc' });
  }
});

// Delete individual notification
router.delete('/:id', auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!notification) {
      return res.status(404).json({ message: 'Không tìm thấy thông báo' });
    }

    // Broadcast notification deleted event
    broadcastEvent('notification_deleted', {
      userId: req.user._id,
      notificationId: req.params.id
    });

    res.json({ message: 'Đã xóa thông báo' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'Không thể xóa thông báo' });
  }
});

export default router; 