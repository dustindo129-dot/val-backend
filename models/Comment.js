import mongoose from 'mongoose';

/**
 * Main Comment Schema
 * Supports both novel and chapter comments
 * Includes like/dislike functionality and soft deletion
 */

// Custom sanitization function
const sanitizeText = (text) => {
  if (!text) return '';
  
  // Convert special characters to HTML entities
  const escapeHtml = (str) => {
    const htmlEntities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return str.replace(/[&<>"']/g, match => htmlEntities[match]);
  };

  // Strip all HTML tags except newlines
  const stripTags = (str) => {
    // Replace HTML tags with newlines to preserve formatting
    const withNewlines = str.replace(/<br\s*\/?>/gi, '\n')
                           .replace(/<\/p>/gi, '\n\n')
                           .replace(/<\/div>/gi, '\n');
    
    // Remove all remaining HTML tags
    const noTags = withNewlines.replace(/<[^>]+>/g, '');
    
    // Clean up excessive newlines and spaces
    return noTags.replace(/\n\s*\n\s*\n/g, '\n\n')
                 .replace(/\s+/g, ' ')
                 .trim();
  };

  // First strip tags, then escape any remaining HTML characters
  return escapeHtml(stripTags(text));
};

const commentSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true,
    set: function(text) {
      return sanitizeText(text);
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
    enum: ['novels', 'chapters', 'feedback']
  },
  contentId: {
    type: String,
    required: true
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment',
    default: null
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isDeleted: {
    type: Boolean,
    default: false
  },
  adminDeleted: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Add index for faster querying of replies
commentSchema.index({ parentId: 1 });

// Virtual property to get the count of likes
commentSchema.virtual('likeCount').get(function() {
  return this.likes.length;
});

// Helper method to check if a user has liked a comment
commentSchema.methods.isLikedBy = function(userId) {
  return this.likes.includes(userId);
};

const Comment = mongoose.model('Comment', commentSchema);

export default Comment; 