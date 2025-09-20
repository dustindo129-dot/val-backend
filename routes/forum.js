import express from 'express';
import { auth, checkBan } from '../middleware/auth.js';
import ForumPost from '../models/ForumPost.js';
import { clearAllCommentCaches } from './comments.js';
import { batchGetUsers } from '../utils/batchUserCache.js';
import Comment from '../models/Comment.js';
import Notification from '../models/Notification.js';
import { 
  createForumPostApprovedNotification, 
  createForumPostDeclinedNotification, 
  createForumPostCommentNotification, 
  createForumPostDeletedNotification 
} from '../services/notificationService.js';
import { broadcastEvent } from '../services/sseService.js';

const router = express.Router();

// Cache for forum posts
const forumPostsCache = new Map();
const FORUM_POSTS_CACHE_TTL = 1000 * 60 * 5; // 5 minutes
const MAX_FORUM_POSTS_CACHE_SIZE = 50;

// Helper function to manage forum posts cache
const getCachedForumPosts = (page, limit) => {
  const cacheKey = `posts_${page}_${limit}`;
  const cached = forumPostsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < FORUM_POSTS_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedForumPosts = (page, limit, data) => {
  if (forumPostsCache.size >= MAX_FORUM_POSTS_CACHE_SIZE) {
    const oldestKey = forumPostsCache.keys().next().value;
    forumPostsCache.delete(oldestKey);
  }
  
  const cacheKey = `posts_${page}_${limit}`;
  forumPostsCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
};

const clearForumPostsCache = () => {
  forumPostsCache.clear();
};

/**
 * Get all forum posts with pagination
 * @route GET /api/forum/posts
 */
router.get('/posts', async (req, res) => {
  try {
    const { page = 1, limit = 10, showOnHomepage } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Build query filter
    const queryFilter = {
      isDeleted: false,
      adminDeleted: false,
      $or: [
        { isPending: false },
        { isPending: { $exists: false } } // Include legacy posts without isPending field
      ]
    };

    // Add homepage visibility filter if specified
    if (showOnHomepage !== undefined) {
      if (showOnHomepage === 'true') {
        queryFilter.$and = [
          { $or: [
            { showOnHomepage: true },
            { showOnHomepage: { $exists: false } } // Include legacy posts without showOnHomepage field (default true)
          ]}
        ];
      } else if (showOnHomepage === 'false') {
        queryFilter.showOnHomepage = false;
      }
    }

    // Create cache key that includes homepage filter
    const cacheKey = `posts_${pageNum}_${limitNum}_${showOnHomepage || 'all'}`;
    const cachedPosts = forumPostsCache.get(cacheKey);
    if (cachedPosts && Date.now() - cachedPosts.timestamp < FORUM_POSTS_CACHE_TTL) {
      return res.json(cachedPosts.data);
    }

    // Get total count with filters
    const totalPosts = await ForumPost.countDocuments(queryFilter);

    // Fetch posts with pagination and filters
    const posts = await ForumPost.find(queryFilter)
    .sort({ isPinned: -1, lastActivity: -1 }) // Pinned first, then by last activity
    .skip(skip)
    .limit(limitNum)
    .lean();

    // Get user info for all authors and approvers
    const authorIds = [...new Set(posts.map(post => post.author))];
    const approverIds = [...new Set(posts.map(post => post.approvedBy).filter(Boolean))];
    const allUserIds = [...new Set([...authorIds, ...approverIds])];
    
    const users = await batchGetUsers(allUserIds, {
      projection: { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 }
    });

    // Attach author and approver info to posts
    const postsWithAuthors = posts.map(post => ({
      ...post,
      author: users[post.author.toString()] || null,
      approvedBy: post.approvedBy ? users[post.approvedBy.toString()] || null : null
    }));

    const result = {
      posts: postsWithAuthors,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalPosts / limitNum),
        totalPosts,
        hasNext: pageNum < Math.ceil(totalPosts / limitNum),
        hasPrev: pageNum > 1,
        limit: limitNum
      }
    };

    // Cache the result with the new cache key
    forumPostsCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching forum posts:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Get a single forum post by slug
 * @route GET /api/forum/posts/:slug
 */
router.get('/posts/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { skipViewTracking } = req.query;

    const post = await ForumPost.findOne({
      slug,
      isDeleted: false,
      adminDeleted: false,
      $or: [
        { isPending: false },
        { isPending: { $exists: false } } // Include legacy posts without isPending field
      ]
    }).lean();

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Get author and approver info
    const userIds = [post.author, post.approvedBy].filter(Boolean);
    const users = await batchGetUsers(userIds, {
      projection: { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 }
    });

    const postWithAuthor = {
      ...post,
      author: users[post.author.toString()] || null,
      approvedBy: post.approvedBy ? users[post.approvedBy.toString()] || null : null
    };

    // Only increment view count if skipViewTracking is not set (view gating system)
    if (skipViewTracking !== 'true') {
      // Increment view count (async, don't wait)
      ForumPost.findByIdAndUpdate(
        post._id,
        { $inc: { views: 1 } },
        { new: false }
      ).catch(err => {
        console.error('Failed to increment view count:', err);
      });
    }

    res.json(postWithAuthor);
  } catch (error) {
    console.error('Error fetching forum post:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Create a new forum post
 * @route POST /api/forum/posts
 */
router.post('/posts', auth, checkBan, async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    if (title.length > 200) {
      return res.status(400).json({ message: 'Title must be 200 characters or less' });
    }

    // Generate unique slug
    const slug = await ForumPost.generateSlug(title);

    // Check if user is admin or moderator (auto-approve their posts)
    const isAdminOrMod = req.user.role === 'admin' || req.user.role === 'moderator';

    // Create the post
    const post = new ForumPost({
      title: title.trim(),
      content,
      author: req.user._id,
      slug,
      isPending: !isAdminOrMod, // Regular users have pending posts
      ...(isAdminOrMod && {
        approvedBy: req.user._id,
        approvedAt: new Date()
      })
    });

    await post.save();

    // Only clear forum posts cache if post was approved immediately
    if (!post.isPending) {
      clearForumPostsCache();
    } else {
      // Clear admin cache since a new pending post was created
      const { clearAdminCache } = await import('./users.js');
      clearAdminCache('admin_task_counts');
    }

    // Broadcast admin task update if a pending post was created
    if (post.isPending) {
      broadcastEvent('admin_task_update', { 
        type: 'pending_post_created',
        postId: post._id.toString(),
        title: post.title
      });
    }

    // Populate author info for response
    await post.populate('author', 'username displayName avatar role userNumber');

    res.status(201).json({
      ...post.toObject(),
      isPending: post.isPending
    });
  } catch (error) {
    console.error('Error creating forum post:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ 
        message: 'Invalid post data',
        details: Object.values(error.errors).map(e => e.message)
      });
    }
    res.status(500).json({ message: error.message });
  }
});

/**
 * Update a forum post
 * @route PATCH /api/forum/posts/:slug
 */
router.patch('/posts/:slug', auth, checkBan, async (req, res) => {
  try {
    const { slug } = req.params;
    const { title, content } = req.body;

    const post = await ForumPost.findOne({ slug });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check permissions: author, admin, or moderator
    const isAuthor = post.author.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    const isModerator = req.user.role === 'moderator';

    if (!isAuthor && !isAdmin && !isModerator) {
      return res.status(403).json({ message: 'Not authorized to edit this post' });
    }

    // Update fields
    if (title !== undefined) {
      if (title.length > 200) {
        return res.status(400).json({ message: 'Title must be 200 characters or less' });
      }
      
      const newTitle = title.trim();
      const oldTitle = post.title;
      
      // Regenerate slug if title changed
      if (newTitle !== oldTitle) {
        post.slug = await ForumPost.generateSlug(newTitle, post._id);
      }
      
      post.title = newTitle;
    }

    if (content !== undefined) {
      post.content = content;
    }

    // Mark as edited
    post.isEdited = true;
    post.lastEditedAt = new Date();
    post.lastEditedBy = req.user._id;

    await post.save();

    // Clear forum posts cache
    clearForumPostsCache();

    // Populate author info for response
    await post.populate('author', 'username displayName avatar role userNumber');

    res.json(post);
  } catch (error) {
    console.error('Error updating forum post:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Delete a forum post
 * @route DELETE /api/forum/posts/:slug
 */
router.delete('/posts/:slug', auth, async (req, res) => {
  try {
    const { slug } = req.params;
    const { reason = '' } = req.body;

    const post = await ForumPost.findOne({ slug });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check permissions: author, admin, or moderator
    const isAuthor = post.author.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    const isModerator = req.user.role === 'moderator';

    if (!isAuthor && !isAdmin && !isModerator) {
      return res.status(403).json({ message: 'Not authorized to delete this post' });
    }

    const isModAction = isAdmin || isModerator;

    if (isModAction && !isAuthor) {
      // Admin/Moderator deletion
      post.isDeleted = true;
      post.adminDeleted = true;
      post.deletionReason = reason;
      post.deletedBy = req.user._id;
      post.deletedAt = new Date();
    } else {
      // Author deletion
      post.isDeleted = true;
      post.adminDeleted = false;
    }

    await post.save();
    
    // Clear admin cache if a pending post was deleted by admin/moderator
    if (isModAction && post.isPending) {
      const { clearAdminCache } = await import('./users.js');
      clearAdminCache('admin_task_counts');
    }

    // Delete all comments related to this forum post
    try {
      const deleteResult = await Comment.deleteMany({
        contentType: 'forum',
        contentId: post._id.toString()
      });
      console.log(`Deleted ${deleteResult.deletedCount} comments for forum post ${post._id}`);
    } catch (commentDeleteError) {
      console.error('Failed to delete related comments:', commentDeleteError);
      // Continue with post deletion even if comment deletion fails
    }

    // Delete all notifications related to this forum post
    try {
      const notificationDeleteResult = await Notification.deleteMany({
        relatedForumPost: post._id
      });
      console.log(`Deleted ${notificationDeleteResult.deletedCount} notifications for forum post ${post._id}`);
    } catch (notificationDeleteError) {
      console.error('Failed to delete related notifications:', notificationDeleteError);
      // Continue with post deletion even if notification deletion fails
    }

    // Send notification to post author if it's a mod action (not their own post)
    if (isModAction && !isAuthor) {
      try {
        await createForumPostDeletedNotification(
          post.author.toString(),
          post.title,
          req.user._id.toString(),
          reason
        );
      } catch (notificationError) {
        console.error('Failed to send deletion notification:', notificationError);
        // Don't fail the deletion if notification fails
      }
    }

    // Clear forum posts cache
    clearForumPostsCache();

    // Also clear comment caches since comments will be affected
    clearAllCommentCaches();

    res.json({ 
      message: 'Post deleted successfully',
      isModAction: isModAction
    });
  } catch (error) {
    console.error('Error deleting forum post:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Pin/Unpin a forum post by slug
 * @route POST /api/forum/posts/:slug/pin
 */
router.post('/posts/:slug/pin', auth, async (req, res) => {
  try {
    const { slug } = req.params;

    // Only admin and moderators can pin posts
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only administrators and moderators can pin posts' });
    }

    const post = await ForumPost.findOne({ slug });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Toggle pin status
    post.isPinned = !post.isPinned;
    await post.save();

    // Clear forum posts cache
    clearForumPostsCache();

    res.json({
      isPinned: post.isPinned,
      message: post.isPinned ? 'Post pinned successfully' : 'Post unpinned successfully'
    });
  } catch (error) {
    console.error('Error pinning post:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Pin/Unpin a forum post by ID (alternative endpoint)
 * @route POST /api/forum/posts/id/:id/pin
 */
router.post('/posts/id/:id/pin', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Only admin and moderators can pin posts
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only administrators and moderators can pin posts' });
    }

    const post = await ForumPost.findById(id);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Toggle pin status
    post.isPinned = !post.isPinned;
    await post.save();

    // Clear forum posts cache
    clearForumPostsCache();

    res.json({
      isPinned: post.isPinned,
      message: post.isPinned ? 'Post pinned successfully' : 'Post unpinned successfully'
    });
  } catch (error) {
    console.error('Error pinning post:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Lock/Unlock a forum post
 * @route POST /api/forum/posts/:slug/lock
 */
router.post('/posts/:slug/lock', auth, async (req, res) => {
  try {
    const { slug } = req.params;

    // Only admin and moderators can lock posts
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only administrators and moderators can lock posts' });
    }

    const post = await ForumPost.findOne({ slug });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Toggle lock status
    post.isLocked = !post.isLocked;
    await post.save();

    // Clear forum posts cache
    clearForumPostsCache();

    res.json({
      isLocked: post.isLocked,
      message: post.isLocked ? 'Post locked successfully' : 'Post unlocked successfully'
    });
  } catch (error) {
    console.error('Error locking post:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Toggle comments for a forum post (Admin/Moderator or post author)
 * @route PATCH /api/forum/posts/:slug/toggle-comments
 */
router.patch('/posts/:slug/toggle-comments', auth, async (req, res) => {
  try {
    const { slug } = req.params;
    const { commentsDisabled } = req.body;

    const post = await ForumPost.findOne({ slug });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check permissions: admin/moderator can toggle any post, authors can toggle their own posts
    const isAdmin = req.user.role === 'admin' || req.user.role === 'moderator';
    const isAuthor = post.author.toString() === req.user.id;
    
    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ message: 'You can only toggle comments on your own posts or if you are an admin/moderator' });
    }

    // Update comments disabled status
    post.commentsDisabled = commentsDisabled;
    await post.save();

    // Clear forum posts cache
    clearForumPostsCache();

    res.json({
      commentsDisabled: post.commentsDisabled,
      message: post.commentsDisabled ? 'Comments disabled successfully' : 'Comments enabled successfully'
    });
  } catch (error) {
    console.error('Error toggling comments:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Toggle homepage visibility for a forum post (Admin/Moderator or post author)
 * @route PATCH /api/forum/posts/:slug/toggle-homepage
 */
router.patch('/posts/:slug/toggle-homepage', auth, async (req, res) => {
  try {
    const { slug } = req.params;
    const { showOnHomepage } = req.body;

    const post = await ForumPost.findOne({ slug });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check permissions: admin/moderator can toggle any post, authors can toggle their own posts
    const isAdmin = req.user.role === 'admin' || req.user.role === 'moderator';
    const isAuthor = post.author.toString() === req.user.id;
    
    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ message: 'You can only toggle homepage visibility on your own posts or if you are an admin/moderator' });
    }

    // Update homepage visibility status
    post.showOnHomepage = showOnHomepage;
    await post.save();

    // Clear forum posts cache
    clearForumPostsCache();

    res.json({
      showOnHomepage: post.showOnHomepage,
      message: post.showOnHomepage ? 'Post will be shown on homepage' : 'Post will not be shown on homepage'
    });
  } catch (error) {
    console.error('Error toggling homepage visibility:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Get pending posts for admin/moderator review
 * @route GET /api/forum/pending-posts
 */
router.get('/pending-posts', auth, async (req, res) => {
  try {
    // Only admin and moderators can view pending posts
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only administrators and moderators can view pending posts' });
    }

    const { page = 1, limit = 10 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const totalPosts = await ForumPost.countDocuments({
      isPending: true,
      isDeleted: false,
      adminDeleted: false
    });

    // Fetch pending posts with pagination
    const posts = await ForumPost.find({
      isPending: true,
      isDeleted: false,
      adminDeleted: false
    })
    .sort({ createdAt: -1 }) // Newest first
    .skip(skip)
    .limit(limitNum)
    .lean();

    // Get user info for all authors
    const authorIds = [...new Set(posts.map(post => post.author))];
    const authors = await batchGetUsers(authorIds, {
      projection: { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 }
    });

    // Attach author info to posts
    const postsWithAuthors = posts.map(post => ({
      ...post,
      author: authors[post.author.toString()] || null
    }));

    const result = {
      posts: postsWithAuthors,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalPosts / limitNum),
        totalPosts,
        hasNext: pageNum < Math.ceil(totalPosts / limitNum),
        hasPrev: pageNum > 1,
        limit: limitNum
      }
    };

    res.json(result);
  } catch (error) {
    console.error('Error fetching pending posts:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Approve a pending post
 * @route POST /api/forum/posts/:id/approve
 */
router.post('/posts/:id/approve', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Only admin and moderators can approve posts
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only administrators and moderators can approve posts' });
    }

    const post = await ForumPost.approvePost(id, req.user._id);

    // Clear forum posts cache since we now have a new approved post
    clearForumPostsCache();
    
    // Clear admin cache since pending posts count changed
    const { clearAdminCache } = await import('./users.js');
    clearAdminCache('admin_task_counts');

    // Populate author info for response
    await post.populate('author', 'username displayName avatar role userNumber');

    // Send notification to post author
    try {
      await createForumPostApprovedNotification(
        post.author._id.toString(),
        post._id.toString(),
        post.title,
        req.user._id.toString()
      );
    } catch (notificationError) {
      console.error('Failed to send approval notification:', notificationError);
      // Don't fail the approval if notification fails
    }

    // Broadcast admin task update to all connected clients
    broadcastEvent('admin_task_update', { 
      type: 'post_approved',
      postId: post._id.toString(),
      title: post.title
    });

    res.json({
      message: 'Post approved successfully',
      post: post
    });
  } catch (error) {
    console.error('Error approving post:', error);
    if (error.message.includes('not found') || error.message.includes('not pending')) {
      return res.status(404).json({ message: error.message });
    }
    res.status(500).json({ message: error.message });
  }
});

/**
 * Reject a pending post
 * @route POST /api/forum/posts/:id/reject
 */
router.post('/posts/:id/reject', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body;

    // Only admin and moderators can reject posts
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only administrators and moderators can reject posts' });
    }

    const post = await ForumPost.rejectPost(id, req.user._id, reason);
    
    // Clear admin cache since pending posts count changed
    const { clearAdminCache } = await import('./users.js');
    clearAdminCache('admin_task_counts');

    // Populate author info for response
    await post.populate('author', 'username displayName avatar role userNumber');

    // Send notification to post author
    try {
      await createForumPostDeclinedNotification(
        post.author._id.toString(),
        post._id.toString(),
        post.title,
        req.user._id.toString(),
        reason
      );
    } catch (notificationError) {
      console.error('Failed to send decline notification:', notificationError);
      // Don't fail the rejection if notification fails
    }

    // Broadcast admin task update to all connected clients
    broadcastEvent('admin_task_update', { 
      type: 'post_rejected',
      postId: post._id.toString(),
      title: post.title
    });

    res.json({
      message: 'Post rejected successfully',
      post: post
    });
  } catch (error) {
    console.error('Error rejecting post:', error);
    if (error.message.includes('not found') || error.message.includes('not pending')) {
      return res.status(404).json({ message: error.message });
    }
    res.status(500).json({ message: error.message });
  }
});

// Export the cache clearing function for use in other routes
export { clearForumPostsCache };

export default router;
