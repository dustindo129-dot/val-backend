import mongoose from 'mongoose';

/**
 * Main Comment Schema
 * Supports both novel and chapter comments
 * Includes like/dislike functionality and soft deletion
 */

// Custom sanitization function
const sanitizeText = (text) => {
  if (!text) return '';
  
  // Check if the text contains HTML tags (indicating rich text content)
  const hasHtmlTags = /<[^>]+>/.test(text);
  
  if (hasHtmlTags) {
    // For rich text content, preserve safe HTML tags
    // Allow: p, br, strong, b, em, i, u, a, img, ul, ol, li
    const allowedTags = /^(p|br|strong|b|em|i|u|a|img|ul|ol|li)$/i;
    const allowedAttributes = /^(href|src|alt|title|target)$/i;
    
    // Basic HTML sanitization - remove dangerous tags and attributes
    let sanitized = text
      // Remove script tags and their content
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      // Remove style tags and their content
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      // Remove on* event attributes
      .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '')
      // Remove javascript: links
      .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, '')
      // Remove data: URLs except for images
      .replace(/src\s*=\s*["']data:(?!image\/)[^"']*["']/gi, '');
    
    // Clean up excessive whitespace but preserve structure
    sanitized = sanitized
      .replace(/\s+/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
    
    return sanitized;
  } else {
    // For plain text content, strip all HTML tags
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

    return stripTags(text);
  }
};

const commentSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true,
    set: function(text) {
      return sanitizeText(text);
    },
    validate: {
      validator: function(text) {
        if (!text) return false;
        
        // Check if text has meaningful content (either text or images)
        const hasText = text.replace(/<[^>]*>/g, '').trim().length > 0;
        const hasImages = /<img[^>]*>/i.test(text);
        
        return hasText || hasImages;
      },
      message: 'Comment must contain either text or images'
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
  // Track all users who have EVER liked this comment (for notification spam prevention)
  likeHistory: [{
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
  // Fields for tracking admin/moderator deletions
  deletionReason: {
    type: String,
    default: ''
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  deletedAt: {
    type: Date,
    default: null
  },
  isPinned: {
    type: Boolean,
    default: false
  },
  isEdited: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Add indexes for faster querying
commentSchema.index({ parentId: 1 });
commentSchema.index({ contentType: 1, contentId: 1 });
commentSchema.index({ contentType: 1, contentId: 1, adminDeleted: 1 });
commentSchema.index({ createdAt: -1 });
commentSchema.index({ user: 1, isDeleted: 1 });
commentSchema.index({ isPinned: 1, contentType: 1, contentId: 1 });
commentSchema.index({ likeHistory: 1 }); // Index for checking like history
// Index for novel comment queries (including regex searches)
commentSchema.index({ contentType: 1, contentId: 1, adminDeleted: 1, createdAt: -1 });

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