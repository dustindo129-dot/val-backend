import mongoose from 'mongoose';

/**
 * BlogPost Schema
 * Represents a blog post created by a user on their profile
 * Features:
 * - Personal blog posts (no comments)
 * - Rich text content support
 * - Author ownership
 * - Creation and update timestamps
 */
const blogPostSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  content: {
    type: String,
    required: true,
    maxlength: 50000 // Allow for rich content
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  likeHistory: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  likesCount: {
    type: Number,
    default: 0
  },
  showOnHomepage: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true // This will automatically manage createdAt and updatedAt
});

// Create indexes for better query performance
blogPostSchema.index({ author: 1, createdAt: -1 }); // For fetching user's posts in chronological order
blogPostSchema.index({ author: 1, updatedAt: -1 }); // For sorting by last updated
blogPostSchema.index({ showOnHomepage: 1, createdAt: -1 }); // For homepage blog posts

/**
 * Pre-save middleware to update the updatedAt timestamp
 */
blogPostSchema.pre('save', function(next) {
  // Only update updatedAt if the document is being modified (not just created)
  if (!this.isNew) {
    this.updatedAt = new Date();
  }
  next();
});

/**
 * Static method to get blog posts count for a user
 * @param {ObjectId} userId - The user's ID
 * @returns {Promise<number>} Number of blog posts
 */
blogPostSchema.statics.getPostsCountByUser = function(userId) {
  return this.countDocuments({ author: userId });
};

/**
 * Static method to get user's blog posts with pagination
 * @param {ObjectId} userId - The user's ID
 * @param {Object} options - Pagination options { page, limit, sort }
 * @returns {Promise<Object>} { posts, pagination }
 */
blogPostSchema.statics.getUserPosts = async function(userId, options = {}) {
  const {
    page = 1,
    limit = 10,
    sort = { createdAt: -1 } // Latest first
  } = options;
  
  const skip = (page - 1) * limit;
  
  const [posts, totalPosts] = await Promise.all([
    this.find({ author: userId })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments({ author: userId })
  ]);
  
  const totalPages = Math.ceil(totalPosts / limit);
  
  return {
    posts,
    pagination: {
      currentPage: page,
      totalPages,
      totalPosts,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  };
};

/**
 * Static method to get homepage blog posts
 * @param {number} limit - Number of posts to fetch (default 8)
 * @returns {Promise<Array>} Array of blog posts with author info
 */
blogPostSchema.statics.getHomepagePosts = async function(limit = 8) {
  return this.find({ showOnHomepage: true })
    .populate('author', 'username displayName avatar userNumber')
    .sort({ createdAt: -1 }) // Latest first
    .limit(limit)
    .lean();
};

/**
 * Instance method to check if user can edit this post
 * @param {ObjectId} userId - The user's ID
 * @returns {boolean} Can the user edit this post
 */
blogPostSchema.methods.canEdit = function(userId) {
  return this.author.toString() === userId.toString();
};

/**
 * Instance method to check if user can delete this post
 * @param {ObjectId} userId - The user's ID
 * @param {string} userRole - The user's role
 * @returns {boolean} Can the user delete this post
 */
blogPostSchema.methods.canDelete = function(userId, userRole = 'user') {
  // Author can always delete, admin/moderator can delete any post
  return this.author.toString() === userId.toString() || 
         ['admin', 'moderator'].includes(userRole);
};

/**
 * Instance method to toggle like on blog post
 * @param {String} userId - The user ID
 * @returns {Object} Result with likesCount, likedByUser status, and isFirstTimeLike
 */
blogPostSchema.methods.toggleLike = function(userId) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const likedIndex = this.likes.indexOf(userObjectId);
  
  // Check if user has ever liked this post before
  const hasLikedBefore = this.likeHistory.some(id => id.toString() === userObjectId.toString());
  const isFirstTimeLike = !hasLikedBefore && likedIndex === -1;
  
  if (likedIndex > -1) {
    // User already liked, remove like
    this.likes.splice(likedIndex, 1);
    this.likesCount = Math.max(0, this.likesCount - 1);
  } else {
    // User hasn't liked, add like
    this.likes.push(userObjectId);
    this.likesCount += 1;
    
    // Add to like history if first time liking
    if (!hasLikedBefore) {
      this.likeHistory.push(userObjectId);
    }
  }
  
  return {
    likesCount: this.likesCount,
    likedByUser: likedIndex === -1,
    isFirstTimeLike: isFirstTimeLike
  };
};

/**
 * Instance method to check if user has liked this post
 * @param {String} userId - The user ID
 * @returns {boolean} True if user has liked, false otherwise
 */
blogPostSchema.methods.isLikedByUser = function(userId) {
  if (!userId) return false;
  return this.likes.includes(new mongoose.Types.ObjectId(userId));
};

const BlogPost = mongoose.model('BlogPost', blogPostSchema);

export default BlogPost;
