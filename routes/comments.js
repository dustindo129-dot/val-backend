import express from 'express';
import { auth, checkBan } from '../middleware/auth.js';
import Comment from '../models/Comment.js';

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
          dislikes: 1,
          likesCount: 1,
          dislikesCount: { $size: '$dislikes' },
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

    // Add liked/disliked status if user is authenticated
    if (req.user) {
      const userId = req.user._id;
      allComments.forEach(comment => {
        comment.liked = comment.likes.includes(userId);
        comment.disliked = comment.dislikes.includes(userId);
      });
    }

    res.json(allComments);
  } catch (err) {
    console.error('Error fetching comments:', err);
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

    res.status(201).json(comment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Like a comment
 * Toggles like status and removes dislike if present
 * @route POST /api/comments/:commentId/like
 */
router.post('/:commentId/like', auth, checkBan, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const userId = req.user._id;
    const isLiked = comment.likes.includes(userId);
    const isDisliked = comment.dislikes.includes(userId);

    if (isLiked) {
      // Unlike if already liked
      comment.likes.pull(userId);
    } else {
      // Add like and remove dislike if exists
      comment.likes.push(userId);
      if (isDisliked) {
        comment.dislikes.pull(userId);
      }
    }

    await comment.save();
    res.json({
      likes: comment.likes.length,
      dislikes: comment.dislikes.length,
      liked: !isLiked,
      disliked: false
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Dislike a comment
 * Toggles dislike status and removes like if present
 * @route POST /api/comments/:commentId/dislike
 */
router.post('/:commentId/dislike', auth, checkBan, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const userId = req.user._id;
    const isDisliked = comment.dislikes.includes(userId);
    const isLiked = comment.likes.includes(userId);

    if (isDisliked) {
      // Remove dislike if already disliked
      comment.dislikes.pull(userId);
    } else {
      // Add dislike and remove like if exists
      comment.dislikes.push(userId);
      if (isLiked) {
        comment.likes.pull(userId);
      }
    }

    await comment.save();
    res.json({
      likes: comment.likes.length,
      dislikes: comment.dislikes.length,
      liked: false,
      disliked: !isDisliked
    });
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