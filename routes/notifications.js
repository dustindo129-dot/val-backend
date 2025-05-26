import express from 'express';
import Notification from '../models/Notification.js';
import { auth } from '../middleware/auth.js';
import { broadcastEvent } from '../services/sseService.js';

const router = express.Router();

// Get user notifications
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const notifications = await Notification.find({ 
      userId: req.user._id 
    })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .populate('relatedUser', 'username displayName avatar')
    .populate('relatedNovel', 'title')
    .populate('relatedChapter', 'title');

    res.json({ 
      notifications,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(await Notification.countDocuments({ userId: req.user._id }) / limit),
        totalItems: await Notification.countDocuments({ userId: req.user._id })
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

export default router; 