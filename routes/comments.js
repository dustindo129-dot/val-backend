import express from 'express';
import { auth, checkBan } from '../middleware/auth.js';
import Comment from '../models/Comment.js';
import { broadcastEvent } from '../services/sseService.js';
import { createCommentReplyNotification, createFollowCommentNotifications, createLikedCommentNotification, createCommentDeletionNotification } from '../services/notificationService.js';

// Helper function to get novel-specific roles for users
const getNovelRoles = async (novel, userIds) => {
  if (!novel?.active || !userIds?.length) return {};
  
  const roles = {};
  const { pj_user, translator, editor, proofreader } = novel.active;
  
  userIds.forEach(userId => {
    const userIdStr = userId.toString();
    const userRoles = [];
    
    if (pj_user && pj_user.some(id => id.toString() === userIdStr)) {
      userRoles.push('pj_user');
    }
    if (translator && translator.some(id => id.toString() === userIdStr)) {
      userRoles.push('translator');
    }
    if (editor && editor.some(id => id.toString() === userIdStr)) {
      userRoles.push('editor');
    }
    if (proofreader && proofreader.some(id => id.toString() === userIdStr)) {
      userRoles.push('proofreader');
    }
    
    if (userRoles.length > 0) {
      roles[userIdStr] = userRoles;
    }
  });
  
  return roles;
};

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

// Clear all comment-related caches
const clearAllCommentCaches = () => {
  recentCommentsCache.clear();
  pendingCommentsQueries.clear();
};

// Clear user stats cache when user actions change
const clearUserStatsCache = async (userId) => {
  try {
    // Import and call the user stats cache clearing function
    const { clearUserStatsCache: clearStats } = await import('./users.js');
    if (clearStats) {
      clearStats(userId);
    }
  } catch (error) {
    // Silently fail if user stats cache is not available
    console.warn('Could not clear user stats cache:', error.message);
  }
};

// Export the cache clearing functions for use in other routes
export { clearRecentCommentsCache, clearAllCommentCaches, clearUserStatsCache };

/**
 * Get all comments for a novel (including chapter comments)
 * @route GET /api/comments/novel/:novelId
 */
router.get('/novel/:novelId', async (req, res) => {
  try {
    const { novelId } = req.params;
    const { sort = 'newest' } = req.query;

    if (!novelId) {
      return res.status(400).json({ message: 'novelId is required' });
    }

    // Use query deduplication to prevent multiple identical requests
    const cacheKey = `novel_comments_${novelId}_${sort}_${req.user?._id || 'anonymous'}`;
    
    const comments = await dedupCommentsQuery(cacheKey, async () => {
      // Quick check: see if there are any comments for this novel at all
      const hasAnyComments = await Comment.countDocuments({
        $or: [
          { contentType: 'novels', contentId: novelId },
          { contentType: 'chapters', contentId: { $regex: `^${novelId}-` } }
        ],
        adminDeleted: { $ne: true }
      });

      // If no comments exist, return empty array immediately
      if (hasAnyComments === 0) {
        return [];
      }

      // Get all chapter IDs for this novel only if we have comments
      const Chapter = (await import('../models/Chapter.js')).default;
      const chapters = await Chapter.find({ novelId }, '_id');
      const chapterIds = chapters.map(ch => ch._id.toString());

      // Build the aggregation pipeline with proper sorting
      const pipeline = [
        {
          $match: {
            $or: [
              // Direct novel comments
              { contentType: 'novels', contentId: novelId },
              // Chapter comments
              { 
                contentType: 'chapters', 
                $or: [
                  { contentId: { $regex: `^${novelId}-` } },
                  ...(chapterIds.length > 0 ? [{ contentId: { $in: chapterIds } }] : [])
                ]
              }
            ],
            adminDeleted: { $ne: true }
          }
        },
        {
          $addFields: {
            likesCount: { $size: "$likes" }
          }
        }
      ];

      // Add sorting to the pipeline for better performance
      switch (sort) {
        case 'likes':
          pipeline.push({ $sort: { likesCount: -1, createdAt: -1 } });
          break;
        case 'oldest':
          pipeline.push({ $sort: { createdAt: 1 } });
          break;
        default: // newest
          pipeline.push({ $sort: { createdAt: -1 } });
      }

      // Add user lookup
      pipeline.push(
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            pipeline: [
              { $project: { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 } }
            ],
            as: 'userInfo'
          }
        },
        {
          $unwind: '$userInfo'
        }
      );

      // Add novel lookup for role checking
      pipeline.push({
        $lookup: {
          from: 'novels',
          let: { contentId: '$contentId' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: [{ $toString: '$_id' }, novelId] }
              }
            },
            {
              $project: {
                'active.pj_user': 1,
                'active.translator': 1,
                'active.editor': 1,
                'active.proofreader': 1
              }
            }
          ],
          as: 'novelInfo'
        }
      });

      // Add chapter info lookup only if we have chapter comments
      if (chapterIds.length > 0) {
        pipeline.push({
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
                      {
                        $or: [
                          // Handle contentId format: "novelId-chapterId"
                          { 
                            $and: [
                              { $ne: [{ $indexOfCP: ['$$contentId', '-'] }, -1] },  // Contains dash
                              { $eq: [{ $toString: '$_id' }, { $arrayElemAt: [{ $split: ['$$contentId', '-'] }, 1] }] }
                            ]
                          },
                          // Handle direct chapter ID (no dash)
                          { 
                            $and: [
                              { $eq: [{ $indexOfCP: ['$$contentId', '-'] }, -1] },  // No dash
                              { $eq: [{ $toString: '$_id' }, '$$contentId'] }
                            ]
                          }
                        ]
                      }
                    ]
                  }
                }
              },
              { $project: { title: 1, order: 1 } }
            ],
            as: 'chapterInfo'
          }
        });
      }

      // Final projection
      pipeline.push({
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
          isPinned: 1,
          isEdited: 1,
          chapterInfo: { $arrayElemAt: ['$chapterInfo', 0] },
                      user: {
              _id: '$userInfo._id',
              username: '$userInfo.username',
              displayName: '$userInfo.displayName',
              avatar: '$userInfo.avatar',
              role: '$userInfo.role',
              userNumber: '$userInfo.userNumber'
            },
          novelInfo: { $arrayElemAt: ['$novelInfo', 0] }
        }
      });

      const allComments = await Comment.aggregate(pipeline);

      // Get novel-specific roles for comment authors using the novel data from aggregation
      const userIds = [...new Set(allComments.map(comment => comment.user._id))];
      const novelRoles = allComments[0]?.novelInfo ? await getNovelRoles(allComments[0].novelInfo, userIds) : {};

      // Add liked status and novel-specific roles if user is authenticated
      if (req.user) {
        const userId = req.user._id;
        allComments.forEach(comment => {
          comment.liked = comment.likes.includes(userId);
        });
      }

      // Add novel-specific roles to each comment
      allComments.forEach(comment => {
        const userIdStr = comment.user._id.toString();
        comment.user.novelRoles = novelRoles[userIdStr] || [];
        // Clean up the novelInfo since we don't need to send it to client
        delete comment.novelInfo;
      });

      return allComments;
    });

    res.json(comments);
  } catch (err) {
    console.error('Error fetching novel comments:', err);
    res.status(500).json({ message: err.message });
  }
});

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

    // Use query deduplication to prevent multiple identical requests
    const cacheKey = `comments_${contentType}_${contentId}_${sort}_${req.user?._id || 'anonymous'}`;
    
    const comments = await dedupCommentsQuery(cacheKey, async () => {
      // Quick check: see if there are any comments for this content
      const hasAnyComments = await Comment.countDocuments({
        contentType,
        contentId,
        adminDeleted: { $ne: true }
      });

      // If no comments exist, return empty array immediately
      if (hasAnyComments === 0) {
        return [];
      }

      // Build the aggregation pipeline with proper sorting
      const pipeline = [
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
        }
      ];

      // Add sorting to the pipeline for better performance
      switch (sort) {
        case 'likes':
          pipeline.push({ $sort: { likesCount: -1, createdAt: -1 } });
          break;
        case 'oldest':
          pipeline.push({ $sort: { createdAt: 1 } });
          break;
        default: // newest
          pipeline.push({ $sort: { createdAt: -1 } });
      }

      // Add user lookup and projection
      pipeline.push(
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            pipeline: [
              { $project: { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 } }
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
            isPinned: 1,
            isEdited: 1,
            user: {
              _id: '$userInfo._id',
              username: '$userInfo.username',
              displayName: '$userInfo.displayName',
              avatar: '$userInfo.avatar',
              role: '$userInfo.role',
              userNumber: '$userInfo.userNumber'
            }
          }
        }
      );

      const allComments = await Comment.aggregate(pipeline);

      // Get novel information for role checking
      let novel = null;
      if (contentType === 'novels') {
        const Novel = (await import('../models/Novel.js')).default;
        novel = await Novel.findById(contentId);
      } else if (contentType === 'chapters') {
        // For chapters, get the novel from the chapter
        const Chapter = (await import('../models/Chapter.js')).default;
        
        // Handle contentId format: "novelId-chapterId" or direct chapterId
        let chapterId = contentId;
        if (contentId.includes('-')) {
          const parts = contentId.split('-');
          chapterId = parts[1]; // Take the second part as chapterId
        }
        
        const chapter = await Chapter.findById(chapterId).populate('novelId');
        novel = chapter?.novelId;
      }
      
      // Get novel-specific roles for comment authors
      const userIds = [...new Set(allComments.map(comment => comment.user._id))];
      const novelRoles = novel ? await getNovelRoles(novel, userIds) : {};

      // Add liked status if user is authenticated
      if (req.user) {
        const userId = req.user._id;
        allComments.forEach(comment => {
          comment.liked = comment.likes.includes(userId);
        });
      }

      // Add novel-specific roles to each comment
      allComments.forEach(comment => {
        const userIdStr = comment.user._id.toString();
        comment.user.novelRoles = novelRoles[userIdStr] || [];
      });

      return allComments;
    });

    res.json(comments);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get comment count for a specific user (including replies)
 * @route GET /api/comments/count/user/:userId
 */
router.get('/count/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Validate ObjectId format
    if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    const count = await Comment.countDocuments({ 
      user: userId,
      isDeleted: { $ne: true },
      adminDeleted: { $ne: true }
    });
    
    res.json({ count });
  } catch (err) {
    console.error('Error counting user comments:', err);
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
              { $project: { username: 1, displayName: 1, avatar: 1, role: 1, userNumber: 1 } }
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
                      {
                        $or: [
                          // Handle contentId format: "novelId-chapterId"
                          { 
                            $and: [
                              { $ne: [{ $indexOfCP: ['$$contentId', '-'] }, -1] },  // Contains dash
                              { $eq: [{ $toString: '$_id' }, { $arrayElemAt: [{ $split: ['$$contentId', '-'] }, 1] }] }
                            ]
                          },
                          // Handle direct chapter ID (no dash)
                          { 
                            $and: [
                              { $eq: [{ $indexOfCP: ['$$contentId', '-'] }, -1] },  // No dash
                              { $eq: [{ $toString: '$_id' }, '$$contentId'] }
                            ]
                          }
                        ]
                      }
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
              avatar: '$userInfo.avatar',
              role: '$userInfo.role',
              userNumber: '$userInfo.userNumber'
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
    
    // Clear all comment caches since a new comment was added
    clearAllCommentCaches();
    
    // Clear user stats cache for the comment author
    clearUserStatsCache(req.user._id.toString());
    
    // Populate user info
    await reply.populate('user', 'username displayName avatar role userNumber');

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
 * Like a comment (Facebook-style with metadata and real-time updates)
 * Toggles like status
 * @route POST /api/comments/:commentId/like
 */
router.post('/:commentId/like', auth, checkBan, async (req, res) => {
  try {
    const userId = req.user._id;
    const { timestamp, deviceId } = req.body;

    // First, get the current state of the comment to check if it's a first-time like
    const currentComment = await Comment.findById(req.params.commentId, {
      likes: 1,
      likeHistory: 1,
      user: 1,
      contentType: 1,
      contentId: 1
    });

    if (!currentComment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    // Check if this is a first-time like
    const currentLikes = currentComment.likes || [];
    const currentLikeHistory = currentComment.likeHistory || [];
    const isCurrentlyLiked = currentLikes.some(id => id.toString() === userId.toString());
    const hasLikedBefore = currentLikeHistory.some(id => id.toString() === userId.toString());
    const isFirstTimeLike = !hasLikedBefore && !isCurrentlyLiked;

    // Now update the comment with simplified logic
    const comment = await Comment.findOneAndUpdate(
      { _id: req.params.commentId },
      [
        {
          $set: {
            // Toggle like status
            likes: {
              $cond: {
                if: { $in: [userId, "$likes"] },
                then: { 
                  // If already liked, remove the like
                  $filter: { 
                    input: "$likes", 
                    cond: { $ne: ["$$this", userId] } 
                  }
                },
                else: { 
                  // If not liked, add like (with duplicate prevention)
                  $reduce: {
                    input: { $concatArrays: [{ $ifNull: ["$likes", []] }, [userId]] },
                    initialValue: [],
                    in: {
                      $cond: {
                        if: { $in: ["$$this", "$$value"] },
                        then: "$$value",
                        else: { $concatArrays: ["$$value", ["$$this"]] }
                      }
                    }
                  }
                }
              }
            },
            // Add to likeHistory with duplicate prevention
            likeHistory: {
              $reduce: {
                input: { 
                  $concatArrays: [
                    { $ifNull: ["$likeHistory", []] }, 
                    [userId]
                  ]
                },
                initialValue: [],
                in: {
                  $cond: {
                    if: { $in: ["$$this", "$$value"] },
                    then: "$$value",
                    else: { $concatArrays: ["$$value", ["$$this"]] }
                  }
                }
              }
            },
            // Store metadata
            lastLikeTimestamp: timestamp || new Date(),
            lastLikeDeviceId: deviceId
          }
        }
      ],
      { 
        new: true,
        projection: { 
          likes: 1, 
          user: 1, 
          contentType: 1, 
          contentId: 1,
          likeHistory: 1,
          lastLikeTimestamp: 1
        }
      }
    );

    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const isLiked = comment.likes.some(id => id.toString() === userId.toString());
    const serverTimestamp = Date.now();

    // Create notification only when liking for the FIRST TIME EVER
    if (isFirstTimeLike && isLiked && comment.user.toString() !== userId.toString()) {
      let novelId = null;
      let chapterId = null;
      
      if (comment.contentType === 'novels') {
        novelId = comment.contentId;
      } else if (comment.contentType === 'chapters') {
        // For chapters, contentId might be in format "novelId-chapterId"
        const parts = comment.contentId.split('-');
        if (parts.length === 2) {
          novelId = parts[0];
          chapterId = parts[1];
        } else {
          chapterId = comment.contentId;
          // Try to get novelId from the chapter document
          try {
            const Chapter = (await import('../models/Chapter.js')).default;
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
        try {
          await createLikedCommentNotification(
            comment.user.toString(),
            comment._id.toString(),
            userId.toString(),
            novelId,
            chapterId
          );
        } catch (error) {
          console.error('Error creating like notification:', error);
        }
      }
    }

    // Broadcast real-time update to all connected clients
    broadcastEvent('comment_like_update', {
      commentId: comment._id.toString(),
      likeCount: comment.likes.length,
      likedBy: comment.likes.map(id => id.toString()),
      timestamp: serverTimestamp,
      deviceId: deviceId
    });

    res.json({
      likes: comment.likes.length,
      liked: isLiked,
      timestamp: serverTimestamp
    });
  } catch (err) {
    console.error('Error processing like:', err);
    res.status(400).json({ message: err.message });
  }
});

/**
 * Pin/Unpin a comment
 * Only admin, moderator, or assigned pj_user can pin comments on novels
 * @route POST /api/comments/:commentId/pin
 */
router.post('/:commentId/pin', auth, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    // Only allow pinning on novel and chapter comments (not feedback)
    if (comment.contentType !== 'novels' && comment.contentType !== 'chapters') {
      return res.status(400).json({ message: 'Comments can only be pinned on novels or chapters' });
    }

    // Check if user has permission to pin comments
    const canPin = req.user.role === 'admin' || req.user.role === 'moderator';
    
    // If user is pj_user, check if they're assigned to this novel
    let canPinAsPjUser = false;
    if (req.user.role === 'pj_user') {
      try {
        // Import Novel model to check pj_user assignment
        const Novel = (await import('../models/Novel.js')).default;
        let novelId = null;
        
        if (comment.contentType === 'novels') {
          novelId = comment.contentId;
        } else if (comment.contentType === 'chapters') {
          // For chapters, contentId is in format "novelId-chapterId"
          const parts = comment.contentId.split('-');
          if (parts.length === 2) {
            novelId = parts[0];
          } else {
            // Fallback: try to get novelId from the chapter document
            try {
              const Chapter = (await import('../models/Chapter.js')).default;
              const chapterDoc = await Chapter.findById(comment.contentId);
              if (chapterDoc) {
                novelId = chapterDoc.novelId.toString();
              }
            } catch (err) {
              console.error('Error getting novelId from chapter:', err);
            }
          }
        }
        
        if (novelId) {
          const novel = await Novel.findById(novelId);
          if (novel && novel.active && novel.active.pj_user) {
            canPinAsPjUser = novel.active.pj_user.includes(req.user._id) ||
                            novel.active.pj_user.includes(req.user.username) ||
                            novel.active.pj_user.includes(req.user.displayName);
          }
        }
      } catch (err) {
        console.error('Error checking pj_user assignment:', err);
      }
    }

    if (!canPin && !canPinAsPjUser) {
      return res.status(403).json({ message: 'Not authorized to pin comments' });
    }

    if (comment.isPinned) {
      // If comment is already pinned, unpin it
      comment.isPinned = false;
      await comment.save();
      
      // Clear all comment caches since pin status changed
      clearAllCommentCaches();
      
      res.json({
        isPinned: false,
        message: 'Comment unpinned successfully'
      });
    } else {
      // If comment is not pinned, first unpin any other pinned comments for the same content
      // For novels: unpin other novel comments for the same novel
      // For chapters: unpin other chapter comments for the same chapter
      await Comment.updateMany(
        { 
          contentType: comment.contentType, 
          contentId: comment.contentId, 
          isPinned: true,
          _id: { $ne: comment._id } // Exclude current comment
        },
        { isPinned: false }
      );
      
      // Then pin this comment
      comment.isPinned = true;
      await comment.save();
      
      // Clear all comment caches since pin status changed
      clearAllCommentCaches();
      
      res.json({
        isPinned: true,
        message: 'Comment pinned successfully'
      });
    }
  } catch (error) {
    console.error('Error pinning comment:', error);
    res.status(400).json({ message: error.message });
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
    
    // Clear all comment caches since a new comment was added
    clearAllCommentCaches();
    
    // Clear user stats cache for the comment author
    clearUserStatsCache(req.user._id.toString());

    // Populate user info
    await comment.populate('user', 'username displayName avatar role userNumber');

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
    console.error('Error creating comment:', err);
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
    
    // Clear all comment caches since a comment was edited
    clearAllCommentCaches();
    
    // Populate user info before returning
    await comment.populate('user', 'username displayName avatar role userNumber');
    
    res.json(comment);
  } catch (error) {
    console.error('Error editing comment:', error);
    res.status(400).json({ message: error.message });
  }
});

/**
 * Delete a comment
 * Only comment author, admin, or moderator can delete
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
    const isModerator = req.user.role === 'moderator';
    const isAuthor = comment.user.toString() === req.user._id.toString();
    const isModAction = isAdmin || isModerator;

    if (!isModAction && !isAuthor) {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }

    // Get deletion reason from request body (only for admin/moderator deletions)
    const { reason = '' } = req.body;

    if (isModAction) {
      // Admin/Moderator deletion - remove from interface but keep in DB
      comment.isDeleted = true;
      comment.adminDeleted = true;
      
      // Store deletion reason and moderator info
      comment.deletionReason = reason;
      comment.deletedBy = req.user._id;
      comment.deletedAt = new Date();
      
      // If it's a root comment, apply the same to all replies (admin deletion cascades)
      if (!comment.parentId) {
        await Comment.updateMany(
          { parentId: comment._id },
          { 
            isDeleted: true, 
            adminDeleted: true,
            deletionReason: reason,
            deletedBy: req.user._id,
            deletedAt: new Date()
          }
        );
      }

      // Send notification to comment owner if it's not their own comment
      if (comment.user.toString() !== req.user._id.toString()) {
        // Determine novel and chapter info for notification
        let novelId = null;
        let chapterId = null;
        
        if (comment.contentType === 'novels') {
          novelId = comment.contentId;
        } else if (comment.contentType === 'chapters') {
          // For chapters, contentId might be in format "novelId-chapterId"
          const parts = comment.contentId.split('-');
          if (parts.length === 2) {
            novelId = parts[0];
            chapterId = parts[1];
          } else {
            chapterId = comment.contentId;
            // Try to get novelId from the chapter document
            try {
              const Chapter = (await import('../models/Chapter.js')).default;
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
          // Strip HTML tags from comment text for preview
          const commentText = comment.text ? comment.text.replace(/<[^>]*>/g, '') : '';
          
          await createCommentDeletionNotification(
            comment.user.toString(),
            req.user._id.toString(),
            reason,
            novelId,
            chapterId,
            commentText
          );
        }
      }
    } else {
      // User deletion - show as [deleted] but keep thread structure intact
      comment.isDeleted = true;
      comment.adminDeleted = false;
      
      // For user deletions, do NOT cascade to replies - preserve thread structure
      // Replies will remain visible and functional
    }

    await comment.save();
    
    // Clear user stats cache for the comment author
    clearUserStatsCache(comment.user.toString());
    
    res.json({ 
      message: 'Comment deleted successfully',
      isModAction: isModAction
    });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(400).json({ message: error.message });
  }
});

export default router; 