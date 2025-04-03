import express from 'express';
import { auth } from '../middleware/auth.js';
import Comment from '../models/Comment.js';

const router = express.Router();

/**
 * Get comments for a specific content (novel or chapter)
 * Supports sorting by newest, oldest, or most liked
 * @route GET /api/comments
 */
router.get('/', async (req, res) => {
  try {
    const { contentType, contentId, sort = 'newest', includeDeleted = false } = req.query;

    if (!contentType || !contentId) {
      return res.status(400).json({ message: 'contentType and contentId are required' });
    }

    let sortQuery = {};
    switch (sort) {
      case 'likes':
        sortQuery = { 'likes.length': -1, createdAt: -1 };
        break;
      case 'oldest':
        sortQuery = { createdAt: 1 };
        break;
      default: // newest
        sortQuery = { createdAt: -1 };
    }

    // Get all comments for this content
    const allComments = await Comment.find({
      contentType,
      contentId,
      ...(includeDeleted === 'false' && { isDeleted: { $ne: true } })
    })
    .sort(sortQuery)
    .populate('user', 'username avatar');

    // Create a map for quick lookup
    const commentMap = {};
    allComments.forEach(comment => {
      commentMap[comment._id] = {
        ...comment.toObject(),
        replies: []
      };
    });

    // Organize into tree structure
    const rootComments = [];
    allComments.forEach(comment => {
      const commentObj = commentMap[comment._id];
      if (comment.parentId) {
        // This is a reply, add it to parent's replies
        if (commentMap[comment.parentId]) {
          commentMap[comment.parentId].replies.push(commentObj);
        }
      } else {
        // This is a root comment
        rootComments.push(commentObj);
      }
    });

    // Add liked/disliked status for the current user
    const addUserStatus = (comments) => {
      return comments.map(comment => {
        if (req.user) {
          comment.liked = comment.likes.includes(req.user._id);
          comment.disliked = comment.dislikes.includes(req.user._id);
          comment.replies = addUserStatus(comment.replies);
        }
        return comment;
      });
    };

    const commentsWithStatus = addUserStatus(rootComments);
    res.json(commentsWithStatus);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Create a new comment on a content
 * @route POST /api/comments/:contentType/:contentId
 */
router.post('/:contentType/:contentId', auth, async (req, res) => {
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
 * Add a reply to an existing comment
 * @route POST /api/comments/:commentId/replies
 */
router.post('/:commentId/replies', auth, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    if (!req.body.text || typeof req.body.text !== 'string') {
      return res.status(400).json({ message: 'Reply text is required and must be a string' });
    }

    // Create a new reply
    const reply = {
      text: req.body.text,
      user: req.user._id,
      likes: [],
      dislikes: [],
      createdAt: new Date()
    };

    // Add reply to the comment's replies array
    comment.replies.push(reply);
    await comment.save();

    // Populate the user info for the new reply
    await comment.populate('replies.user', 'username avatar');
    const newReply = comment.replies[comment.replies.length - 1];
    
    res.status(201).json(newReply);
  } catch (err) {
    console.error('Reply creation error:', err);
    res.status(400).json({ 
      message: err.message,
      details: err.errors ? Object.values(err.errors).map(e => e.message) : undefined
    });
  }
});

/**
 * Like a comment
 * Toggles like status and removes dislike if present
 * @route POST /api/comments/:commentId/like
 */
router.post('/:commentId/like', auth, async (req, res) => {
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
router.post('/:commentId/dislike', auth, async (req, res) => {
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
router.patch('/:commentId', auth, async (req, res) => {
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
    if (comment.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }

    comment.isDeleted = true;
    await comment.save();
    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

export default router; 