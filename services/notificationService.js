import mongoose from 'mongoose';
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
 * @param {string} novelId - ID of the novel where the comment was made
 * @param {string} chapterId - ID of the chapter where the comment was made (optional)
 */
export const createCommentReplyNotification = async (originalCommenterId, replyCommentId, novelId, chapterId = null) => {
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
 * Create notification for chapter like (first time only)
 * @param {string} chapterOwner - Username or ObjectId of the user who owns the chapter (translator/editor/proofreader)
 * @param {string} chapterId - ID of the liked chapter
 * @param {string} likerId - ID of the user who liked the chapter
 * @param {string} novelId - ID of the novel where the chapter belongs
 */
export const createLikedChapterNotification = async (chapterOwner, chapterId, likerId, novelId) => {
  try {
    // Don't notify if chapterOwner is empty or null
    if (!chapterOwner) {
      return;
    }

    // Don't notify if user is liking their own chapter (if chapterOwner is an ObjectId)
    if (chapterOwner === likerId) {
      return;
    }

    // Determine if chapterOwner is an ObjectId or username
    let chapterOwnerId = null;
    if (mongoose.Types.ObjectId.isValid(chapterOwner) && chapterOwner.length === 24) {
      // It's already an ObjectId
      chapterOwnerId = chapterOwner;
    } else {
      // It's a username, need to look it up
      const ownerUser = await User.findOne({
        $or: [
          { username: chapterOwner },
          { displayName: chapterOwner }
        ]
      }).select('_id');
      
      if (!ownerUser) {
        console.log(`Chapter owner user not found: ${chapterOwner}`);
        return;
      }
      
      chapterOwnerId = ownerUser._id.toString();
    }

    // Don't notify if user is liking their own chapter (after lookup)
    if (chapterOwnerId === likerId) {
      return;
    }

    const [novel, liker, chapter] = await Promise.all([
      Novel.findById(novelId),
      User.findById(likerId).select('displayName username'),
      Chapter.findById(chapterId).select('title')
    ]);

    if (!novel || !liker || !chapter) return;

    const likerDisplayName = liker.displayName || liker.username;

    const message = `<i>${likerDisplayName}</i> đã thích chương <b>${chapter.title}</b> trong truyện <b>${novel.title}</b>`;
    
    const linkData = { 
      novelId, 
      novelTitle: novel.title,
      chapterId,
      chapterTitle: chapter.title
    };

    const notification = new Notification({
      userId: chapterOwnerId,
      type: 'liked_chapter',
      title: 'Chương được thích',
      message,
      relatedUser: likerId,
      relatedNovel: novelId,
      relatedChapter: chapterId,
      data: linkData
    });

    await notification.save();
    
    // Broadcast new notification event to specific user only
    broadcastEventToUser('new_notification', {
      userId: chapterOwnerId,
      notification: notification.toObject()
    }, chapterOwnerId);
  } catch (error) {
    console.error('Error creating liked chapter notification:', error);
  }
};

/**
 * Create notification for comment deletion by admin/moderator
 * @param {string} commentOwnerId - ID of the user who owns the deleted comment
 * @param {string} moderatorId - ID of the admin/moderator who deleted the comment
 * @param {string} reason - Reason for deletion
 * @param {string} novelId - ID of the novel where the comment was made
 * @param {string} chapterId - ID of the chapter where the comment was made (optional)
 * @param {string} commentText - Preview of the deleted comment
 */
export const createCommentDeletionNotification = async (commentOwnerId, moderatorId, reason, novelId, chapterId = null, commentText = '') => {
  try {
    // Don't notify if moderator is deleting their own comment
    if (commentOwnerId === moderatorId) {
      return;
    }

    const [novel, moderator] = await Promise.all([
      Novel.findById(novelId),
      User.findById(moderatorId).select('displayName username role')
    ]);

    if (!novel || !moderator) return;

    const moderatorTitle = moderator.role === 'admin' ? 'Admin' : 'Mod';

    // Create a preview of the comment (first 50 characters)
    const commentPreview = commentText ? 
      (commentText.length > 50 ? commentText.substring(0, 50) + '...' : commentText) : 
      'bình luận của bạn';

    let message;
    let linkData = { 
      novelId, 
      novelTitle: novel.title
    };

    if (chapterId) {
      const chapter = await Chapter.findById(chapterId);
      if (chapter) {
        message = `<b>${moderatorTitle}</b> đã xóa ${commentPreview} tại <b>${chapter.title}</b> trong truyện <b>${novel.title}</b>`;
        linkData.chapterId = chapterId;
        linkData.chapterTitle = chapter.title;
      } else {
        message = `<b>${moderatorTitle}</b> đã xóa ${commentPreview} trong truyện <b>${novel.title}</b>`;
      }
    } else {
      message = `<b>${moderatorTitle}</b> đã xóa ${commentPreview} trong truyện <b>${novel.title}</b>`;
    }

    // Add reason to message if provided
    if (reason && reason.trim()) {
      message += `<br><b>Lý do:</b> ${reason.trim()}`;
    }

    const notification = new Notification({
      userId: commentOwnerId,
      type: 'comment_deleted',
      title: 'Bình luận bị xóa',
      message,
      relatedUser: moderatorId,
      relatedNovel: novelId,
      relatedChapter: chapterId,
      data: {
        ...linkData,
        reason: reason || '',
        moderatorRole: moderator.role
      }
    });

    await notification.save();
    console.log(`Comment deletion notification created for user ${commentOwnerId}`);
    
    // Broadcast new notification event to specific user only
    broadcastEventToUser('new_notification', {
      userId: commentOwnerId,
      notification: notification.toObject()
    }, commentOwnerId);
  } catch (error) {
    console.error('Error creating comment deletion notification:', error);
  }
};

/**
 * Create notification for forum post approval
 * @param {string} userId - ID of the post author
 * @param {string} postId - ID of the approved post
 * @param {string} postTitle - Title of the approved post
 * @param {string} postSlug - Slug of the approved post
 * @param {string} approverId - ID of the admin/mod who approved
 */
export const createForumPostApprovedNotification = async (userId, postId, postTitle, postSlug, approverId) => {
  try {
    // We no longer include admin/mod identity in notification content

    const notification = new Notification({
      userId,
      type: 'forum_post_approved',
      title: 'Bài đăng được duyệt',
      message: `Bài đăng <b>"${postTitle}"</b> đã được duyệt`,
      relatedForumPost: postId,
      // Do not attach approver info to avoid exposing identity
      data: {
        postId,
        postTitle,
        postSlug,
        status: 'approved'
      }
    });

    await notification.save();
    console.log(`Forum post approval notification created for user ${userId}`);
    
    broadcastEventToUser('new_notification', {
      userId,
      notification: notification.toObject()
    }, userId);
  } catch (error) {
    console.error('Error creating forum post approval notification:', error);
  }
};

/**
 * Create notification for forum post decline
 * @param {string} userId - ID of the post author
 * @param {string} postId - ID of the declined post
 * @param {string} postTitle - Title of the declined post
 * @param {string} postSlug - Slug of the declined post (optional, since post may be deleted)
 * @param {string} declinerId - ID of the admin/mod who declined
 * @param {string} reason - Reason for decline (optional)
 */
export const createForumPostDeclinedNotification = async (userId, postId, postTitle, postSlug, declinerId, reason = '') => {
  try {
    // Do not include admin/mod identity in message
    let message = `Bài đăng <b>"${postTitle}"</b> đã bị từ chối`;
    if (reason && reason.trim()) {
      message += `<br><b>Lý do:</b> ${reason.trim()}`;
    }

    const notification = new Notification({
      userId,
      type: 'forum_post_declined',
      title: 'Bài đăng bị từ chối',
      message,
      relatedForumPost: postId,
      // Do not attach decliner identity
      data: {
        postId,
        postTitle,
        postSlug,
        status: 'declined',
        reason: reason || ''
      }
    });

    await notification.save();
    console.log(`Forum post decline notification created for user ${userId}`);
    
    broadcastEventToUser('new_notification', {
      userId,
      notification: notification.toObject()
    }, userId);
  } catch (error) {
    console.error('Error creating forum post decline notification:', error);
  }
};

/**
 * Create notification for new comment on user's forum post
 * @param {string} postAuthorId - ID of the post author
 * @param {string} postId - ID of the forum post
 * @param {string} postTitle - Title of the forum post
 * @param {string} postSlug - Slug of the forum post
 * @param {string} commenterId - ID of the commenter
 * @param {string} commentId - ID of the comment
 */
export const createForumPostCommentNotification = async (postAuthorId, postId, postTitle, postSlug, commenterId, commentId) => {
  try {
    // Don't notify if user is commenting on their own post
    if (postAuthorId === commenterId) {
      return;
    }

    const commenter = await User.findById(commenterId).select('displayName username');
    if (!commenter) return;

    const commenterName = commenter.displayName || commenter.username;

    const notification = new Notification({
      userId: postAuthorId,
      type: 'forum_post_comment',
      title: 'Bình luận mới',
      message: `<i>${commenterName}</i> đã bình luận trong bài đăng <b>"${postTitle}"</b>`,
      relatedForumPost: postId,
      relatedComment: commentId,
      relatedUser: commenterId,
      data: {
        postId,
        postTitle,
        postSlug,
        commenterId,
        commenterName,
        commentId
      }
    });

    await notification.save();
    console.log(`Forum post comment notification created for user ${postAuthorId}`);
    
    broadcastEventToUser('new_notification', {
      userId: postAuthorId,
      notification: notification.toObject()
    }, postAuthorId);
  } catch (error) {
    console.error('Error creating forum post comment notification:', error);
  }
};

/**
 * Create notification for forum post deletion by admin/moderator
 * @param {string} userId - ID of the post author
 * @param {string} postTitle - Title of the deleted post
 * @param {string} deleterId - ID of the admin/mod who deleted
 * @param {string} reason - Reason for deletion (optional)
 */
export const createForumPostDeletedNotification = async (userId, postTitle, deleterId, reason = '') => {
  try {
    // Don't notify if user is deleting their own post
    if (userId === deleterId) {
      return;
    }

    // Do not include admin/mod identity in message
    let message = `Bài đăng <b>"${postTitle}"</b> đã bị xóa`;
    if (reason && reason.trim()) {
      message += `<br><b>Lý do:</b> ${reason.trim()}`;
    }

    const notification = new Notification({
      userId,
      type: 'forum_post_deleted',
      title: 'Bài đăng bị xóa',
      message,
      // Do not attach deleter identity
      data: {
        postTitle,
        status: 'deleted',
        reason: reason || ''
      }
    });

    await notification.save();
    console.log(`Forum post deletion notification created for user ${userId}`);
    
    broadcastEventToUser('new_notification', {
      userId,
      notification: notification.toObject()
    }, userId);
  } catch (error) {
    console.error('Error creating forum post deletion notification:', error);
  }
};

/**
 * Create notification for blog post like
 * @param {string} blogAuthorId - ID of the user who owns the blog post
 * @param {string} blogPostId - ID of the liked blog post
 * @param {string} blogPostTitle - Title of the liked blog post
 * @param {string} likerId - ID of the user who liked the blog post
 * @param {string} blogAuthorDisplayName - Display name or username of the blog author for URL
 */
export const createLikedBlogPostNotification = async (blogAuthorId, blogPostId, blogPostTitle, likerId, blogAuthorDisplayName) => {
  try {
    // Don't notify if user is liking their own blog post
    if (blogAuthorId === likerId) {
      return;
    }

    const liker = await User.findById(likerId).select('displayName username');
    if (!liker) return;

    const likerDisplayName = liker.displayName || liker.username;

    const message = `<i>${likerDisplayName}</i> đã thích bài viết <b>"${blogPostTitle}"</b> của bạn`;
    
    const linkData = { 
      blogPostId,
      blogPostTitle,
      blogAuthorDisplayName
    };

    const notification = new Notification({
      userId: blogAuthorId,
      type: 'liked_blog_post',
      title: 'Bài viết được thích',
      message,
      relatedUser: likerId,
      data: linkData
    });

    await notification.save();
    
    // Broadcast new notification event to specific user only
    broadcastEventToUser('new_notification', {
      userId: blogAuthorId,
      notification: notification.toObject()
    }, blogAuthorId);

    console.log(`Blog post like notification created for user ${blogAuthorId}`);
  } catch (error) {
    console.error('Error creating liked blog post notification:', error);
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