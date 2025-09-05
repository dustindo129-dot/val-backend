import express from 'express';
import { auth, checkBan } from '../middleware/auth.js';
import ForumPost from '../models/ForumPost.js';
import { clearAllCommentCaches } from './comments.js';
import { batchGetUsers } from '../utils/batchUserCache.js';

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
    const { page = 1, limit = 10 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Check cache first
    const cachedPosts = getCachedForumPosts(pageNum, limitNum);
    if (cachedPosts) {
      return res.json(cachedPosts);
    }

    // Get total count
    const totalPosts = await ForumPost.countDocuments({
      isDeleted: false,
      adminDeleted: false
    });

    // Fetch posts with pagination
    const posts = await ForumPost.find({
      isDeleted: false,
      adminDeleted: false
    })
    .sort({ isPinned: -1, lastActivity: -1 }) // Pinned first, then by last activity
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

    // Cache the result
    setCachedForumPosts(pageNum, limitNum, result);

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
      adminDeleted: false
    }).lean();

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Get author info
    const authors = await batchGetUsers([post.author], {
      projection: { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 }
    });

    const postWithAuthor = {
      ...post,
      author: authors[post.author.toString()] || null
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

    // Check if user is admin or moderator
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only administrators and moderators can create forum posts' });
    }

    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    if (title.length > 200) {
      return res.status(400).json({ message: 'Title must be 200 characters or less' });
    }

    // Generate unique slug
    const slug = await ForumPost.generateSlug(title);

    // Create the post
    const post = new ForumPost({
      title: title.trim(),
      content,
      author: req.user._id,
      slug
    });

    await post.save();

    // Clear forum posts cache
    clearForumPostsCache();

    // Populate author info for response
    await post.populate('author', 'username displayName avatar role userNumber');

    res.status(201).json(post);
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
 * Pin/Unpin a forum post
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
 * Toggle comments for a forum post (Admin/Moderator only)
 * @route PATCH /api/forum/posts/:slug/toggle-comments
 */
router.patch('/posts/:slug/toggle-comments', auth, async (req, res) => {
  try {
    const { slug } = req.params;
    const { commentsDisabled } = req.body;

    // Check if user is admin or moderator
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Only admin and moderators can toggle comments' });
    }

    const post = await ForumPost.findOne({ slug });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
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

export default router;
