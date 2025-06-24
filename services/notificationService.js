import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Novel from '../models/Novel.js';
import Chapter from '../models/Chapter.js';
import Comment from '../models/Comment.js';
import UserNovelInteraction from '../models/UserNovelInteraction.js';
import { broadcastEvent, broadcastEventToUser } from './sseService.js';

/**
 * Create a notification for report feedback
 * @param {string} reporterId - ID of the user who made the report
 * @param {string} reportId - ID of the report
 * @param {string} responseMessage - Admin/mod response message (optional)
 * @param {Object} reportData - Report data including contentType, contentId, novelId
 */
export const createReportFeedbackNotification = async (reporterId, reportId, responseMessage = '', reportData = {}) => {
  try {
    // Create message based on whether there's a custom response
    let message;
    if (responseMessage && responseMessage.trim()) {
      message = `Báo cáo của bạn đã được xử lí cùng lời nhắn: <i>${responseMessage.trim()}</i>`;
    } else {
      message = 'Báo cáo của bạn đã được xử lí';
    }

    // Prepare notification data for navigation
    const notificationData = {
      reportId
    };

    // Add navigation data based on content type
    if (reportData.contentType && reportData.contentId) {
      notificationData.contentType = reportData.contentType;
      notificationData.contentId = reportData.contentId;
      
      if (reportData.novelId) {
        notificationData.novelId = reportData.novelId;
      }
      
      // For chapters, we need to get the chapter title for navigation
      if (reportData.contentType === 'chapter') {
        try {
          const chapter = await Chapter.findById(reportData.contentId);
          if (chapter) {
            notificationData.chapterTitle = chapter.title;
            notificationData.chapterId = reportData.contentId;
            // If novelId is not provided but we have a chapter, get it from the chapter
            if (!reportData.novelId && chapter.novelId) {
              notificationData.novelId = chapter.novelId.toString();
            }
          }
        } catch (err) {
          console.error('Error fetching chapter for notification:', err);
        }
      }
    }

    const notification = new Notification({
      userId: reporterId,
      type: 'report_feedback',
      title: 'Phản hồi báo cáo',
      message,
      relatedReport: reportId,
      data: notificationData
    });

    await notification.save();
    console.log(`Report feedback notification created for user ${reporterId}`);
    
    // Broadcast new notification event to specific user only
    broadcastEventToUser('new_notification', {
      userId: reporterId,
      notification: notification.toObject()
    }, reporterId);
  } catch (error) {
    console.error('Error creating report feedback notification:', error);
  }
};

/**
 * Create a notification for comment reply
 * @param {string} originalCommenterId - ID of the user who made the original comment
 * @param {string} replyCommentId - ID of the reply comment
 * @param {string} replierUsername - Username of the person who replied (deprecated, now using display name from user object)
 * @param {string} novelId - ID of the novel where the comment was made
 * @param {string} chapterId - ID of the chapter where the comment was made (optional)
 */
export const createCommentReplyNotification = async (originalCommenterId, replyCommentId, replierUsername, novelId, chapterId = null) => {
  try {
    // Don't notify if user is replying to themselves
    const replyComment = await Comment.findById(replyCommentId).populate('user');
    if (replyComment.user._id.toString() === originalCommenterId) {
      return;
    }

    const novel = await Novel.findById(novelId);
    if (!novel) return;

    // Use display name from the populated user object
    const replierDisplayName = replyComment.user.displayName || replyComment.user.username;

    let message = `<i>${replierDisplayName}</i> đã trả lời bình luận của bạn tại <b>${novel.title}</b>`;
    let linkData = { 
      novelId,
      novelTitle: novel.title
    };

    if (chapterId) {
      const chapter = await Chapter.findById(chapterId);
      if (chapter) {
        message = `<i>${replierDisplayName}</i> đã trả lời bình luận của bạn tại <b>${chapter.title}</b>`;
        linkData.chapterId = chapterId;
        linkData.chapterTitle = chapter.title;
      }
    }

    // Get the parent comment ID from the reply comment for navigation
    const parentComment = await Comment.findById(replyComment.parentId);
    if (parentComment) {
      linkData.originalCommentId = parentComment._id.toString();
    }

    const notification = new Notification({
      userId: originalCommenterId,
      type: 'comment_reply',
      title: 'Trả lời bình luận',
      message,
      relatedUser: replyComment.user._id,
      relatedNovel: novelId,
      relatedChapter: chapterId,
      relatedComment: replyCommentId,
      data: linkData
    });

    await notification.save();
    console.log(`Comment reply notification created for user ${originalCommenterId}`);
    
    // Broadcast new notification event to specific user only
    broadcastEventToUser('new_notification', {
      userId: originalCommenterId,
      notification: notification.toObject()
    }, originalCommenterId);
  } catch (error) {
    console.error('Error creating comment reply notification:', error);
  }
};

/**
 * Create notifications for new chapter (for bookmarked novels)
 * @param {string} novelId - ID of the novel
 * @param {string} chapterId - ID of the new chapter
 * @param {string} chapterTitle - Title of the new chapter
 */
export const createNewChapterNotifications = async (novelId, chapterId, chapterTitle) => {
  try {
    const novel = await Novel.findById(novelId);
    if (!novel) return;

    // Find all users who have bookmarked this novel using UserNovelInteraction
    const bookmarkedInteractions = await UserNovelInteraction.find({
      novelId: novelId,
      bookmarked: true
    }).select('userId');

    const bookmarkedUsers = bookmarkedInteractions.map(interaction => ({ _id: interaction.userId }));

    if (bookmarkedUsers.length === 0) return;

    const message = `<b>${novel.title}</b> đã cập nhật <b>${chapterTitle}</b>`;

    // Create notifications for all bookmarked users
    const notifications = bookmarkedUsers.map(user => ({
      userId: user._id,
      type: 'new_chapter',
      title: 'Chương mới',
      message,
      relatedNovel: novelId,
      relatedChapter: chapterId,
      data: {
        novelId,
        novelTitle: novel.title,
        chapterId,
        chapterTitle
      }
    }));

    const savedNotifications = await Notification.insertMany(notifications);
    
    // Broadcast new notification events to each specific user
    savedNotifications.forEach(notification => {
      broadcastEventToUser('new_notification', {
        userId: notification.userId,
        notification: notification.toObject()
      }, notification.userId);
    });
  } catch (error) {
    console.error('Error creating new chapter notifications:', error);
  }
};

/**
 * Mark notification as read
 * @param {string} notificationId - ID of the notification
 * @param {string} userId - ID of the user (for security)
 */
export const markNotificationAsRead = async (notificationId, userId) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: notificationId, userId },
      { isRead: true }
    );
    
    // Broadcast notification read event to specific user only
    broadcastEventToUser('notification_read', {
      userId,
      notificationId,
      isRead: true
    }, userId);
  } catch (error) {
    console.error('Error marking notification as read:', error);
  }
};

/**
 * Mark all notifications as read for a user
 * @param {string} userId - ID of the user
 */
export const markAllNotificationsAsRead = async (userId) => {
  try {
    await Notification.updateMany(
      { userId, isRead: false },
      { isRead: true }
    );
    
    // Broadcast notifications cleared event to specific user only
    broadcastEventToUser('notifications_cleared', {
      userId,
      allRead: true
    }, userId);
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
  }
};

/**
 * Create notifications for new comments on followed novels
 * @param {string} novelId - ID of the novel
 * @param {string} commentId - ID of the new comment
 * @param {string} commenterId - ID of the user who made the comment
 * @param {string} chapterId - ID of the chapter (optional, null for novel comments)
 */
export const createFollowCommentNotifications = async (novelId, commentId, commenterId, chapterId = null) => {
  try {
    const novel = await Novel.findById(novelId);
    if (!novel) return;

    // Find all users who are following this novel using UserNovelInteraction
    const followedInteractions = await UserNovelInteraction.find({
      novelId: novelId,
      followed: true
    }).select('userId');

    const followedUsers = followedInteractions.map(interaction => ({ _id: interaction.userId }));

    if (followedUsers.length === 0) return;

    // Get commenter info
    const commenter = await User.findById(commenterId).select('displayName username');
    if (!commenter) return;

    const commenterDisplayName = commenter.displayName || commenter.username;

    let message;
    let linkData = { 
      novelId, 
      novelTitle: novel.title,
      commentId 
    };

    if (chapterId) {
      const chapter = await Chapter.findById(chapterId);
      if (chapter) {
        message = `<i>${commenterDisplayName}</i> đã bình luận tại <b>${chapter.title}</b> trong truyện <b>${novel.title}</b>`;
        linkData.chapterId = chapterId;
        linkData.chapterTitle = chapter.title;
      } else {
        message = `<i>${commenterDisplayName}</i> đã bình luận trong truyện <b>${novel.title}</b>`;
      }
    } else {
      message = `<i>${commenterDisplayName}</i> đã bình luận trong truyện <b>${novel.title}</b>`;
    }

    // Create notifications for all following users (excluding the commenter)
    const notifications = followedUsers
      .filter(user => user._id.toString() !== commenterId) // Don't notify the commenter
      .map(user => ({
        userId: user._id,
        type: 'follow_comment',
        title: 'Bình luận mới',
        message,
        relatedUser: commenterId,
        relatedNovel: novelId,
        relatedChapter: chapterId,
        relatedComment: commentId,
        data: linkData
      }));

    if (notifications.length === 0) return;

    const savedNotifications = await Notification.insertMany(notifications);
    
    // Broadcast new notification events to each specific user
    savedNotifications.forEach(notification => {
      broadcastEventToUser('new_notification', {
        userId: notification.userId,
        notification: notification.toObject()
      }, notification.userId);
    });

    console.log(`Follow comment notifications created for ${savedNotifications.length} users`);
  } catch (error) {
    console.error('Error creating follow comment notifications:', error);
  }
};

/**
 * Create notification for comment like
 * @param {string} commentOwnerId - ID of the user who owns the comment
 * @param {string} commentId - ID of the liked comment
 * @param {string} likerId - ID of the user who liked the comment
 * @param {string} novelId - ID of the novel where the comment was made
 * @param {string} chapterId - ID of the chapter where the comment was made (optional)
 */
export const createLikedCommentNotification = async (commentOwnerId, commentId, likerId, novelId, chapterId = null) => {
  try {
    // Don't notify if user is liking their own comment
    if (commentOwnerId === likerId) {
      return;
    }

    const [novel, liker] = await Promise.all([
      Novel.findById(novelId),
      User.findById(likerId).select('displayName username')
    ]);

    if (!novel || !liker) return;

    const likerDisplayName = liker.displayName || liker.username;

    let message;
    let linkData = { 
      novelId, 
      novelTitle: novel.title,
      commentId 
    };

    if (chapterId) {
      const chapter = await Chapter.findById(chapterId);
      if (chapter) {
        message = `<i>${likerDisplayName}</i> đã thích bình luận của bạn tại <b>${chapter.title}</b> trong truyện <b>${novel.title}</b>`;
        linkData.chapterId = chapterId;
        linkData.chapterTitle = chapter.title;
      } else {
        message = `<i>${likerDisplayName}</i> đã thích bình luận của bạn trong truyện <b>${novel.title}</b>`;
      }
    } else {
      message = `<i>${likerDisplayName}</i> đã thích bình luận của bạn trong truyện <b>${novel.title}</b>`;
    }

    const notification = new Notification({
      userId: commentOwnerId,
      type: 'liked_comment',
      title: 'Bình luận được thích',
      message,
      relatedUser: likerId,
      relatedNovel: novelId,
      relatedChapter: chapterId,
      relatedComment: commentId,
      data: linkData
    });

    await notification.save();
    console.log(`Liked comment notification created for user ${commentOwnerId}`);
    
    // Broadcast new notification event to specific user only
    broadcastEventToUser('new_notification', {
      userId: commentOwnerId,
      notification: notification.toObject()
    }, commentOwnerId);
  } catch (error) {
    console.error('Error creating liked comment notification:', error);
  }
};

/**
 * Get unread notification count for a user
 * @param {string} userId - ID of the user
 * @returns {number} Count of unread notifications
 */
export const getUnreadNotificationCount = async (userId) => {
  try {
    return await Notification.countDocuments({
      userId,
      isRead: false
    });
  } catch (error) {
    console.error('Error getting unread notification count:', error);
    return 0;
  }
}; 