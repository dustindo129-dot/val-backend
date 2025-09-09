import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['report_feedback', 'comment_reply', 'new_chapter', 'follow_comment', 'liked_comment', 'liked_chapter', 'comment_deleted', 'forum_post_approved', 'forum_post_declined', 'forum_post_comment', 'forum_post_deleted'],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  // Related entities for different notification types
  relatedUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  relatedNovel: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel'
  },
  relatedChapter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chapter'
  },
  relatedComment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment'
  },
  relatedReport: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Report'
  },
  relatedForumPost: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ForumPost'
  },
  // Additional data for specific notification types
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification; 