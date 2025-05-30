import express from 'express';
import { auth, checkBan } from '../middleware/auth.js';
import Comment from '../models/Comment.js';
import { broadcastEvent } from '../services/sseService.js';
import { createCommentReplyNotification } from '../services/notificationService.js';

const router = express.Router();

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
            { $project: { username: 1, avatar: 1 } }
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
 * Get recent comments from across the website
 * Fetches the latest comments regardless of content type
 * @route GET /api/comments/recent
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    // Get recent comments, excluding replies and deleted comments
    const recentComments = await Comment.aggregate([
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
            { $project: { username: 1, avatar: 1 } }
          ],
          as: 'userInfo'
        }
      },
      {
        $unwind: '$userInfo'
      },
      // Lookup for content titles
      {
        $lookup: {
          from: 'novels',
          let: { contentId: { $toString: '$contentId' }, contentType: '$contentType' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: [{ $toString: '$_id' }, '$$contentId'] },
                    { $eq: ['$$contentType', 'novels'] }
                  ]
                }
              }
            },
            { $project: { title: 1 } }
          ],
          as: 'novelInfo'
        }
      },
      {
        $lookup: {
          from: 'chapters',
          let: { 
            contentIdParts: { $split: ['$contentId', '-'] },
            contentType: '$contentType'
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$$contentType', 'chapters'] },
                    { $eq: [{ $toString: '$_id' }, { $arrayElemAt: ['$$contentIdParts', 1] }] }
                  ]
                }
              }
            },
            { 
              $lookup: {
                from: 'novels',
                let: { novelId: '$novel' },
                pipeline: [
                  { $match: { $expr: { $eq: ['$_id', '$$novelId'] } } },
                  { $project: { title: 1 } }
                ],
                as: 'novelTitle'
              }
            },
            { $unwind: { path: '$novelTitle', preserveNullAndEmptyArrays: true } },
            { $project: { 
                novelTitle: '$novelTitle.title', 
                chapterTitle: '$title' 
              } 
            }
          ],
          as: 'chapterInfo'
        }
      },
      {
        $addFields: {
          contentTitle: {
            $cond: [
              { $eq: ['$contentType', 'novels'] },
              { $arrayElemAt: ['$novelInfo.title', 0] },
              { $cond: [
                { $eq: ['$contentType', 'chapters'] },
                { $arrayElemAt: ['$chapterInfo.novelTitle', 0] },
                'Feedback'
              ]}
            ]
          },
          chapterTitle: {
            $cond: [
              { $eq: ['$contentType', 'chapters'] },
              { $arrayElemAt: ['$chapterInfo.chapterTitle', 0] },
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
            avatar: '$userInfo.avatar'
          }
        }
      }
    ]);

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
    
    // Populate user info
    await reply.populate('user', 'username avatar');

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
    await comment.populate('user', 'username avatar');

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