import mongoose from 'mongoose';
import sanitizeHtml from 'sanitize-html';

/**
 * Main Comment Schema
 * Supports both novel and chapter comments
 * Includes like/dislike functionality and soft deletion
 */
const commentSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true,
    set: function(text) {
      // Sanitize HTML content before saving
      return sanitizeHtml(text, {
        allowedTags: ['p', 'br', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
                     'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'img'],
        allowedAttributes: {
          'a': ['href', 'target'],
          'img': ['src', 'alt', 'width', 'height']
        }
      });
    }
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  contentType: {
    type: String,
    required: true,
    enum: ['novels', 'chapters']
  },
  contentId: {
    type: String,
    required: true
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  dislikes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isDeleted: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Virtual property to get the count of likes
commentSchema.virtual('likeCount').get(function() {
  return this.likes.length;
});

// Virtual property to get the count of dislikes
commentSchema.virtual('dislikeCount').get(function() {
  return this.dislikes.length;
});

// Helper method to check if a user has liked a comment
commentSchema.methods.isLikedBy = function(userId) {
  return this.likes.includes(userId);
};

// Helper method to check if a user has disliked a comment
commentSchema.methods.isDislikedBy = function(userId) {
  return this.dislikes.includes(userId);
};

const Comment = mongoose.model('Comment', commentSchema);

export default Comment; 