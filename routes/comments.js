import express from 'express';
import { auth, checkBan } from '../middleware/auth.js';
import Comment from '../models/Comment.js';
import { broadcastEvent } from '../services/sseService.js';
import { createCommentReplyNotification, createFollowCommentNotifications } from '../services/notificationService.js';

const router = express.Router();

// Simple in-memory cache for recent comments
const recentCommentsCache = new Map();
const RECENT_COMMENTS_CACHE_TTL = 1000 * 60 * 2; // 2 minutes
const MAX_RECENT_COMMENTS_CACHE_SIZE = 50;

// Query deduplication cache
const pendingCommentsQueries = new Map();

// Helper function to manage recent comments cache
const getCachedRecentComments = (limit) => {
  const cached = recentCommentsCache.get(`recent_${limit}`);
  if (cached && Date.now() - cached.timestamp < RECENT_COMMENTS_CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedRecentComments = (limit, data) => {
  if (recentCommentsCache.size >= MAX_RECENT_COMMENTS_CACHE_SIZE) {
    const oldestKey = recentCommentsCache.keys().next().value;
    recentCommentsCache.delete(oldestKey);
  }
  
  recentCommentsCache.set(`recent_${limit}`, {
    data,
    timestamp: Date.now()
  });
};

// Query deduplication helper for comments
const dedupCommentsQuery = async (key, queryFn) => {
  if (pendingCommentsQueries.has(key)) {
    return await pendingCommentsQueries.get(key);
  }
  
  const queryPromise = queryFn();
  pendingCommentsQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    pendingCommentsQueries.delete(key);
  }
};

// Clear recent comments cache (call this when new comments are added)
const clearRecentCommentsCache = () => {
  recentCommentsCache.clear();
};

// Export the cache clearing function for use in other routes
export { clearRecentCommentsCache };

/**
 * Get comments for a specific content (novel or chapter)
 * Supports sorting by newest, oldest, or most liked
 * @route GET /api/comments
 */
router.get('/', async (req, res) => {
  try {
    const { contentType, contentId, sort = 'newest' } = req.query;

    if (!contentType || !contentId) {
      return res.status(400).json({ message: 'contentType and contentId are required' });
    }

    // Get all comments for this content, including replies
    const allComments = await Comment.aggregate([
      {
        $match: {
          contentType,
          contentId,
          adminDeleted: { $ne: true }
        }
      },
      {
        $addFields: {
          likesCount: { $size: "$likes" }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          pipeline: [
            { $project: { username: 1, displayName: 1, avatar: 1 } }
          ],
          as: 'userInfo'
        }
      },
      {
        $unwind: '$userInfo'
      },
      {
        $project: {
          _id: 1,
          text: 1,
          contentType: 1,
          contentId: 1,
          parentId: 1,
          createdAt: 1,
          isDeleted: 1,
          adminDeleted: 1,
          likes: 1,
          likesCount: 1,
          user: {
            _id: '$userInfo._id',
            username: '$userInfo.username',
            displayName: '$userInfo.displayName',
            avatar: '$userInfo.avatar'
          }
        }
      }
    ]);

    // Sort all comments based on the sort parameter
    switch (sort) {
      case 'likes':
        allComments.sort((a, b) => b.likesCount - a.likesCount || b.createdAt - a.createdAt);
        break;
      case 'oldest':
        allComments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        break;
      default: // newest
        allComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // Add liked status if user is authenticated
    if (req.user) {
      const userId = req.user._id;
      allComments.forEach(comment => {
        comment.liked = comment.likes.includes(userId);
      });
    }

    res.json(allComments);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get recent comments from across the website (OPTIMIZED)
 * Fetches the latest comments regardless of content type
 * @route GET /api/comments/recent
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    // Use query deduplication to prevent multiple identical requests
    const recentComments = await dedupCommentsQuery(`recent_${limit}`, async () => {
      // Check if recent comments are cached
      const cachedComments = getCachedRecentComments(limit);
      if (cachedComments) {
        return cachedComments;
      }

      // Optimized aggregation with proper title lookups
      const comments = await Comment.aggregate([
        {
          $match: {
            isDeleted: { $ne: true },
            adminDeleted: { $ne: true },
            parentId: null // Only root comments, not replies
          }
        },
        {
          $sort: { createdAt: -1 } // Newest first
        },
        {
          $limit: limit
        },
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            pipeline: [
              { $project: { username: 1, displayName: 1, avatar: 1 } }
            ],
            as: 'userInfo'
          }
        },
        {
          $unwind: '$userInfo'
        },
        // Lookup novel titles for novel comments
        {
          $lookup: {
            from: 'novels',
            let: { 
              contentId: '$contentId',
              contentType: '$contentType'
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$$contentType', 'novels'] },
                      { $eq: [{ $toString: '$_id' }, '$$contentId'] }
                    ]
                  }
                }
              },
              { $project: { title: 1 } }
            ],
            as: 'novelInfo'
          }
        },
        // Lookup chapter and novel info for chapter comments
        {
          $lookup: {
            from: 'chapters',
            let: { 
              contentId: '$contentId',
              contentType: '$contentType'
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$$contentType', 'chapters'] },
                      // Handle contentId format: "novelId-chapterId"
                      { $eq: [{ $toString: '$_id' }, { $arrayElemAt: [{ $split: ['$$contentId', '-'] }, 1] }] }
                    ]
                  }
                }
              },
              {
                $lookup: {
                  from: 'novels',
                  localField: 'novelId',
                  foreignField: '_id',
                  pipeline: [
                    { $project: { title: 1 } }
                  ],
                  as: 'novel'
                }
              },
              {
                $project: {
                  title: 1,
                  novelTitle: { $arrayElemAt: ['$novel.title', 0] }
                }
              }
            ],
            as: 'chapterInfo'
          }
        },
        // Resolve content titles properly
        {
          $addFields: {
            contentTitle: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ['$contentType', 'novels'] },
                    then: { $arrayElemAt: ['$novelInfo.title', 0] }
                  },
                  {
                    case: { $eq: ['$contentType', 'chapters'] },
                    then: { $arrayElemAt: ['$chapterInfo.novelTitle', 0] }
                  }
                ],
                default: 'Feedback'
              }
            },
            chapterTitle: {
              $cond: [
                { $eq: ['$contentType', 'chapters'] },
                { $arrayElemAt: ['$chapterInfo.title', 0] },
                null
              ]
            }
          }
        },
        {
          $project: {
            _id: 1,
            text: 1,
            contentType: 1,
            contentId: 1,
            contentTitle: 1,
            chapterTitle: 1,
            createdAt: 1,
            user: {
              _id: '$userInfo._id',
              username: '$userInfo.username',
              displayName: '$userInfo.displayName',
              avatar: '$userInfo.avatar'
            }
          }
        }
      ]);

      // Cache the result
      setCachedRecentComments(limit, comments);
      return comments;
    });

    res.json(recentComments);
  } catch (err) {
    console.error('Error fetching recent comments:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Add a reply to an existing comment
 * @route POST /api/comments/:commentId/replies
 */
router.post('/:commentId/replies', auth, checkBan, async (req, res) => {
  try {
    // First check if parent comment exists and populate it
    const parentComment = await Comment.findById(req.params.commentId);
    if (!parentComment) {
      return res.status(404).json({ message: 'Parent comment not found' });
    }

    if (!req.body.text || typeof req.body.text !== 'string') {
      return res.status(400).json({ message: 'Reply text is required and must be a string' });
    }

    // Create a new comment document for the reply
    // Use the parent comment's contentType and contentId
    const reply = new Comment({
      text: req.body.text,
      user: req.user._id,
      contentType: parentComment.contentType, // Use parent's contentType
      contentId: parentComment.contentId,     // Use parent's contentId
      parentId: parentComment._id
    });

    // Validate the reply before saving
    await reply.validate();

    // Save the reply
    await reply.save();
    
    // Clear recent comments cache since a new comment was added
    clearRecentCommentsCache();
    
    // Populate user info
    await reply.populate('user', 'username displayName avatar');

    // Create notification for the original commenter
    if (parentComment.user.toString() !== req.user._id.toString()) {
      // Extract novelId and chapterId from contentId and contentType
      let novelId = null;
      let chapterId = null;
      
      if (parentComment.contentType === 'novels') {
        novelId = parentComment.contentId;
      } else if (parentComment.contentType === 'chapters') {
        // For chapters, contentId might be in format "novelId-chapterId"
        const parts = parentComment.contentId.split('-');
        if (parts.length === 2) {
          novelId = parts[0];
          chapterId = parts[1];
        } else {
          chapterId = parentComment.contentId;
          // Try to get novelId from the chapter document
          try {
            const Chapter = require('../models/Chapter.js').default;
            const chapterDoc = await Chapter.findById(chapterId);
            if (chapterDoc) {
              novelId = chapterDoc.novelId.toString();
            }
          } catch (err) {
            console.error('Error getting novelId from chapter:', err);
          }
        }
      }
      
      if (novelId || chapterId) {
        await createCommentReplyNotification(
          parentComment.user.toString(),
          reply._id.toString(),
          req.user.username,
          novelId,
          chapterId
        );
      }
    }

    // Create follow notifications for users following this novel (for replies too)
    let novelId = null;
    let chapterId = null;
    
    if (parentComment.contentType === 'novels') {
      novelId = parentComment.contentId;
    } else if (parentComment.contentType === 'chapters') {
      // For chapters, contentId might be in format "novelId-chapterId"
      const parts = parentComment.contentId.split('-');
      if (parts.length === 2) {
        novelId = parts[0];
        chapterId = parts[1];
      } else {
        chapterId = parentComment.contentId;
        // Try to get novelId from the chapter document
        try {
          const Chapter = require('../models/Chapter.js').default;
          const chapterDoc = await Chapter.findById(chapterId);
          if (chapterDoc) {
            novelId = chapterDoc.novelId.toString();
          }
        } catch (err) {
          console.error('Error getting novelId from chapter:', err);
        }
      }
    }
    
    if (novelId) {
      await createFollowCommentNotifications(
        novelId,
        reply._id.toString(),
        req.user._id.toString(),
        chapterId
      );
    }

    // Notify clients about the new comment via SSE
    broadcastEvent('new_comment', {
      commentId: reply._id,
      username: req.user.username
    });

    res.status(201).json(reply);
  } catch (err) {
    console.error('Reply creation error:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ 
        message: 'Invalid reply data',
        details: Object.values(err.errors).map(e => e.message)
      });
    }
    res.status(400).json({ 
      message: err.message || 'Failed to create reply'
    });
  }
});

/**
 * Like a comment
 * Toggles like status
 * @route POST /api/comments/:commentId/like
 */
router.post('/:commentId/like', auth, checkBan, async (req, res) => {
  try {
    const userId = req.user._id;

    // Use findOneAndUpdate to handle concurrent requests atomically
    const comment = await Comment.findOneAndUpdate(
      { _id: req.params.commentId },
      [
        {
          $set: {
            likes: {
              $cond: {
                if: { $in: [userId, "$likes"] },
                then: { $filter: { input: "$likes", cond: { $ne: ["$$this", userId] } } },
                else: { $concatArrays: ["$likes", [userId]] }
              }
            }
          }
        }
      ],
      { new: true }
    );

    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const isLiked = comment.likes.includes(userId);

    res.json({
      likes: comment.likes.length,
      liked: isLiked
    });
  } catch (err) {
    console.error('Error processing like:', err);
    res.status(400).json({ message: err.message });
  }
});

/**
 * Create a new comment on a content
 * @route POST /api/comments/:contentType/:contentId
 */
router.post('/:contentType/:contentId', auth, checkBan, async (req, res) => {
  try {
    const { contentType, contentId } = req.params;
    const { text } = req.body;

    const comment = new Comment({
      text,
      user: req.user._id,
      contentType,
      contentId
    });

    await comment.save();
    
    // Clear recent comments cache since a new comment was added
    clearRecentCommentsCache();

    // Populate user info
    await comment.populate('user', 'username displayName avatar');

    // Create follow notifications for users following this novel
    let novelId = null;
    let chapterId = null;
    
    if (contentType === 'novels') {
      novelId = contentId;
    } else if (contentType === 'chapters') {
      // For chapters, contentId might be in format "novelId-chapterId"
      const parts = contentId.split('-');
      if (parts.length === 2) {
        novelId = parts[0];
        chapterId = parts[1];
      } else {
        chapterId = contentId;
        // Try to get novelId from the chapter document
        try {
          const Chapter = require('../models/Chapter.js').default;
          const chapterDoc = await Chapter.findById(contentId);
          if (chapterDoc) {
            novelId = chapterDoc.novelId.toString();
          }
        } catch (err) {
          console.error('Error getting novelId from chapter:', err);
        }
      }
    }
    
    if (novelId) {
      await createFollowCommentNotifications(
        novelId,
        comment._id.toString(),
        req.user._id.toString(),
        chapterId
      );
    }

    // Notify clients about the new comment via SSE
    broadcastEvent('new_comment', {
      commentId: comment._id,
      username: req.user.username
    });

    res.status(201).json(comment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Edit a comment
 * Only the comment author can edit their own comments
 * @route PATCH /api/comments/:commentId
 */
router.patch('/:commentId', auth, checkBan, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to edit this comment' });
    }

    comment.text = req.body.text;
    comment.isEdited = true;
    if (req.body.rating) {
      comment.rating = req.body.rating;
    }

    await comment.save();
    res.json(comment);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

/**
 * Delete a comment
 * Only comment author or admin can delete
 * @route DELETE /api/comments/:commentId
 */
router.delete('/:commentId', auth, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    // Check if user is authorized to delete the comment
    const isAdmin = req.user.role === 'admin';
    const isAuthor = comment.user.toString() === req.user._id.toString();

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }

    if (isAdmin) {
      // Admin deletion - remove from interface but keep in DB
      comment.isDeleted = true;
      comment.adminDeleted = true;
      
      // If it's a root comment, apply the same to all replies
      if (!comment.parentId) {
        await Comment.updateMany(
          { parentId: comment._id },
          { isDeleted: true, adminDeleted: true }
        );
      }
    } else {
      // User deletion - show as [deleted]
      comment.isDeleted = true;
      comment.adminDeleted = false;
      
      // If it's a root comment, apply the same to all replies
      if (!comment.parentId) {
        await Comment.updateMany(
          { parentId: comment._id },
          { isDeleted: true, adminDeleted: false }
        );
      }
    }

    await comment.save();
    res.json({ 
      message: 'Comment deleted successfully',
      isAdminDelete: isAdmin
    });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(400).json({ message: error.message });
  }
});

export default router; 