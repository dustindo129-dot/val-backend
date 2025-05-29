import express from 'express';
import Notification from '../models/Notification.js';
import { auth } from '../middleware/auth.js';
import { broadcastEvent } from '../services/sseService.js';

const router = express.Router();

// Get user notifications
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    
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

    const notifications = await Notification.find({ 
      userId: req.user._id 
    })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate('relatedUser', 'username displayName avatar')
    .populate('relatedNovel', 'title')
    .populate('relatedChapter', 'title');

    const totalItems = await Notification.countDocuments({ userId: req.user._id });

    res.json({ 
      notifications,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil((totalItems - 20) / 10) + 1, // Adjusted for our pattern
        totalItems: totalItems
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Không thể tải thông báo' });
  }
});

// Get unread notification count
router.get('/unread-count', auth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user._id,
      isRead: false
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