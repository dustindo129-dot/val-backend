import mongoose from 'mongoose';

/**
 * Forum Post Schema
 * For storing forum discussion posts created by admin/moderators
 */

// Custom sanitization function (similar to Comment model)
const sanitizeText = (text) => {
  if (!text) return '';
  
  // Check if the text contains HTML tags (indicating rich text content)
  const hasHtmlTags = /<[^>]+>/.test(text);
  
  if (hasHtmlTags) {
    // For rich text content, preserve safe HTML tags
    // Allow: p, br, strong, b, em, i, u, a, img, ul, ol, li, h1, h2, h3, h4, h5, h6
    const allowedTags = /^(p|br|strong|b|em|i|u|a|img|ul|ol|li|h1|h2|h3|h4|h5|h6)$/i;
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

const forumPostSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  content: {
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
      message: 'Post content must contain either text or images'
    }
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  slug: {
    type: String,
    unique: true,
    required: true
  },
  isPinned: {
    type: Boolean,
    default: false
  },
  isLocked: {
    type: Boolean,
    default: false
  },
  commentsDisabled: {
    type: Boolean,
    default: false
  },
  // Moderation status
  isPending: {
    type: Boolean,
    default: false
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  approvedAt: {
    type: Date,
    default: null
  },
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  rejectedAt: {
    type: Date,
    default: null
  },
  rejectionReason: {
    type: String,
    default: ''
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  // Admin deletion tracking
  adminDeleted: {
    type: Boolean,
    default: false
  },
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
  // Edit tracking
  isEdited: {
    type: Boolean,
    default: false
  },
  lastEditedAt: {
    type: Date,
    default: null
  },
  lastEditedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Engagement tracking
  views: {
    type: Number,
    default: 0
  },
  commentCount: {
    type: Number,
    default: 0
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Add indexes for better query performance
// Note: slug index is already created by the unique: true field option
forumPostSchema.index({ author: 1 });
forumPostSchema.index({ createdAt: -1 });
forumPostSchema.index({ lastActivity: -1 });
forumPostSchema.index({ isPinned: -1, lastActivity: -1 });
forumPostSchema.index({ isDeleted: 1, adminDeleted: 1 });
forumPostSchema.index({ isPending: 1, createdAt: -1 }); // For moderator queue
forumPostSchema.index({ isPending: 1, isDeleted: 1, adminDeleted: 1 }); // For approved posts listing

// Pre-save middleware to update timestamps
forumPostSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.updatedAt = new Date();
    
    // Update lastActivity if content changed or it's a new post
    if (this.isModified('content') || this.isNew) {
      this.lastActivity = new Date();
    }
  }
  next();
});

// Method to increment view count
forumPostSchema.methods.incrementViews = function() {
  this.views += 1;
  return this.save();
};

// Method to update comment count
forumPostSchema.methods.updateCommentCount = async function() {
  const Comment = mongoose.model('Comment');
  const count = await Comment.countDocuments({
    contentType: 'forum',
    contentId: this._id.toString(),
    adminDeleted: { $ne: true },
    isDeleted: { $ne: true }
  });
  
  this.commentCount = count;
  this.lastActivity = new Date();
  return this.save();
};

// Static method to approve a pending post
forumPostSchema.statics.approvePost = async function(postId, approverId) {
  const post = await this.findById(postId);
  if (!post || !post.isPending) {
    throw new Error('Post not found or not pending approval');
  }
  
  post.isPending = false;
  post.approvedBy = approverId;
  post.approvedAt = new Date();
  post.rejectedBy = null;
  post.rejectedAt = null;
  post.rejectionReason = '';
  
  return await post.save();
};

// Static method to reject a pending post
forumPostSchema.statics.rejectPost = async function(postId, rejecterId, reason = '') {
  const post = await this.findById(postId);
  if (!post || !post.isPending) {
    throw new Error('Post not found or not pending approval');
  }
  
  post.isPending = false;
  post.rejectedBy = rejecterId;
  post.rejectedAt = new Date();
  post.rejectionReason = reason;
  post.approvedBy = null;
  post.approvedAt = null;
  
  return await post.save();
};

// Static method to generate unique slug
forumPostSchema.statics.generateSlug = async function(title, postId = null) {
  const createSlug = (str) => {
    return str
      .toLowerCase()
      .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
      .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
      .replace(/[ìíịỉĩ]/g, 'i')
      .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
      .replace(/[ùúụủũưừứựửữ]/g, 'u')
      .replace(/[ỳýỵỷỹ]/g, 'y')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 100);
  };

  let baseSlug = createSlug(title);
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const existingPost = await this.findOne({ 
      slug, 
      ...(postId && { _id: { $ne: postId } })
    });
    
    if (!existingPost) {
      return slug;
    }
    
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
};

const ForumPost = mongoose.model('ForumPost', forumPostSchema);

export default ForumPost;
