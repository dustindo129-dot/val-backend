import express from "express";
import Novel from "../../models/Novel.js";
import Module from "../../models/Module.js";
import Chapter from "../../models/Chapter.js";
import { cache, shouldBypassCache } from '../../utils/cacheUtils.js';
import UserNovelInteraction from '../../models/UserNovelInteraction.js';
import UserChapterInteraction from '../../models/UserChapterInteraction.js';
import Gift from '../../models/Gift.js';
import ContributionHistory from '../../models/ContributionHistory.js';
import Comment from '../../models/Comment.js';
import mongoose from 'mongoose';
import { populateStaffNames } from '../../utils/populateStaffNames.js';
import { dedupQuery } from './basic.js';

const router = express.Router();

/**
 * Get complete novel page data in a single optimized request
 * @route GET /api/novels/:id/complete
 */
router.get("/:id/complete", async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user ? req.user._id : null;
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(`novel-complete:${novelId}:${userId || 'guest'}`, async () => {
      // Execute all queries in parallel for maximum performance
      const [
        novel, 
        modules, 
        chapters, 
        gifts, 
        userInteraction, 
        novelStats, 
        contributionHistory
      ] = await Promise.all([
        // 1. Get novel data
        Novel.findById(novelId)
          .select('title description alternativeTitles author illustrator illustration status active inactive genres note updatedAt createdAt views ratings novelBalance novelBudget')
          .lean(),
          
        // 2. Get modules
        Module.find({ novelId: novelId })
          .select('title illustration order chapters mode moduleBalance')
          .sort('order')
          .lean(),
          
        // 3. Get chapters
        Chapter.find({ novelId: novelId })
          .select('title moduleId order createdAt updatedAt mode chapterBalance')
          .sort('order')
          .lean(),
          
        // 4. Get gifts with counts (using the same aggregation but cached)
        Gift.aggregate([
          {
            $lookup: {
              from: 'novelgifts',
              let: { giftId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$giftId', '$$giftId'] },
                        { $eq: ['$novelId', new mongoose.Types.ObjectId(novelId)] }
                      ]
                    }
                  }
                }
              ],
              as: 'novelGift'
            }
          },
          {
            $addFields: {
              count: {
                $ifNull: [{ $arrayElemAt: ['$novelGift.count', 0] }, 0]
              }
            }
          },
          {
            $project: {
              _id: 1,
              name: 1,
              icon: 1,
              price: 1,
              order: 1,
              count: 1
            }
          },
          {
            $sort: { order: 1 }
          }
        ]),
        
        // 5. Get user interaction if logged in
        userId ? UserNovelInteraction.findOne({ 
          userId, 
          novelId: new mongoose.Types.ObjectId(novelId) 
        }).lean() : null,
        
        // 6. Get novel interaction statistics
        UserNovelInteraction.aggregate([
          {
            $match: { novelId: new mongoose.Types.ObjectId(novelId) }
          },
          {
            $group: {
              _id: null,
              totalLikes: {
                $sum: { $cond: [{ $eq: ['$liked', true] }, 1, 0] }
              },
              totalRatings: {
                $sum: { $cond: [{ $ne: ['$rating', null] }, 1, 0] }
              },
              ratingSum: {
                $sum: { $ifNull: ['$rating', 0] }
              }
            }
          }
        ]),
        
        // 7. Get recent contribution history
        ContributionHistory.find({ novelId: novelId })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean()
      ]);

      if (!novel) {
        return { error: "Novel not found", status: 404 };
      }

      // Populate staff ObjectIds with user display names
      const populatedNovel = await populateStaffNames(novel);

      // Organize chapters by module
      const chaptersByModule = chapters.reduce((acc, chapter) => {
        const moduleId = chapter.moduleId.toString();
        if (!acc[moduleId]) {
          acc[moduleId] = [];
        }
        acc[moduleId].push(chapter);
        return acc;
      }, {});

      // Attach chapters to their modules
      const modulesWithChapters = modules.map(module => ({
        ...module,
        chapters: chaptersByModule[module._id.toString()] || []
      }));

      // Build interaction response
      const stats = novelStats[0];
      const interactions = {
        totalLikes: stats?.totalLikes || 0,
        totalRatings: stats?.totalRatings || 0,
        averageRating: stats?.totalRatings > 0 
          ? (stats.ratingSum / stats.totalRatings).toFixed(1) 
          : '0.0',
        userInteraction: {
          liked: userInteraction?.liked || false,
          rating: userInteraction?.rating || null,
          bookmarked: userInteraction?.bookmarked || false
        }
      };

      return {
        novel: populatedNovel,
        modules: modulesWithChapters,
        gifts,
        interactions,
        contributionHistory
      };
    });

    // Handle deduplication errors
    if (result.error) {
      return res.status(result.status).json({ message: result.error });
    }

    // Return complete novel page data
    res.json(result);

    // Increment view count after sending response (non-blocking)
    if (req.query.skipViewTracking !== 'true') {
      Novel.findById(novelId)
        .then(fullNovel => {
          if (fullNovel) {
            return fullNovel.incrementViews();
          }
        })
        .catch(err => console.error('Error updating view count:', err));
    }
  } catch (err) {
    console.error('Error in novel complete route:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get complete homepage data in a single optimized request
 * @route GET /api/novels/homepage
 */
router.get("/homepage", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;
    const userId = req.user ? req.user._id : null;
    const timeRange = req.query.timeRange || 'today';

    // Check if we should bypass cache
    const bypass = shouldBypassCache(req.path, req.query);
    const cacheKey = `homepage_${page}_${limit}_${timeRange}_${userId || 'guest'}`;
    
    if (!bypass) {
      const cachedData = cache.get(cacheKey);
      if (cachedData) {
        return res.json(cachedData);
      }
    }

    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(cacheKey, async () => {
      // Execute all homepage queries in parallel for maximum performance
      const [
        novelListResult,
        hotNovels,
        recentComments,
        readingHistory
      ] = await Promise.all([
        // 1. Novel list with pagination (existing optimized aggregation)
        Novel.aggregate([
          {
            $facet: {
              total: [{ $count: 'count' }],
              novels: [
                {
                  $project: {
                    title: 1,
                    illustration: 1,
                    author: 1,
                    illustrator: 1,
                    status: 1,
                    genres: 1,
                    alternativeTitles: 1,
                    updatedAt: 1,
                    createdAt: 1,
                    description: 1,
                    note: 1,
                    active: 1,
                    inactive: 1,
                    novelBalance: 1,
                    novelBudget: 1
                  }
                },
                // Simplified chapter lookup - only get what we need
                {
                  $lookup: {
                    from: 'chapters',
                    let: { novelId: '$_id' },
                    pipeline: [
                      {
                        $match: {
                          $expr: { $eq: ['$novelId', '$$novelId'] }
                        }
                      },
                      { $sort: { createdAt: -1 } },
                      { $limit: 1 }, // Reduced from 3 to 1 for performance
                      {
                        $project: {
                          _id: 1,
                          title: 1,
                          createdAt: 1
                        }
                      }
                    ],
                    as: 'latestChapter'
                  }
                },
                // Calculate latest activity
                {
                  $addFields: {
                    latestActivity: {
                      $max: [
                        '$updatedAt',
                        { $max: '$latestChapter.createdAt' }
                      ]
                    },
                    latestChapter: { $arrayElemAt: ['$latestChapter', 0] }
                  }
                },
                { $sort: { latestActivity: -1 } },
                { $skip: skip },
                { $limit: limit }
              ]
            }
          }
        ]),

        // 2. Hot novels (cached separately with shorter TTL)
        dedupQuery(`hot_novels_${timeRange}`, async () => {
          const now = new Date();
          let startDate;
          
          if (timeRange === 'today') {
            startDate = new Date();
            startDate.setHours(0, 0, 0, 0);
          } else if (timeRange === 'week') {
            startDate = new Date();
            startDate.setDate(startDate.getDate() - 7);
          }

          try {
            return await Novel.aggregate([
              { $match: { "views.daily": { $exists: true, $ne: [] } } },
              { $unwind: "$views.daily" },
              {
                $match: {
                  "views.daily.date": { $gte: startDate }
                }
              },
              {
                $group: {
                  _id: "$_id",
                  title: { $first: "$title" },
                  illustration: { $first: "$illustration" },
                  status: { $first: "$status" },
                  dailyViews: { $sum: "$views.daily.count" }
                }
              },
              { $sort: { dailyViews: -1 } },
              { $limit: 5 },
              {
                $project: {
                  _id: 1,
                  title: 1,
                  illustration: 1,
                  status: 1,
                  dailyViews: 1
                }
              }
            ]);
          } catch (err) {
            console.warn('Hot novels query failed, returning empty array:', err);
            return [];
          }
        }),

        // 3. Recent comments (optimized with proper title lookups)
        dedupQuery(`recent_comments_10`, async () => {
          try {
            return await Comment.aggregate([
              {
                $match: {
                  isDeleted: { $ne: true },
                  adminDeleted: { $ne: true },
                  parentId: null
                }
              },
              { $sort: { createdAt: -1 } },
              { $limit: 10 },
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
              { $unwind: '$userInfo' },
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
                    avatar: '$userInfo.avatar'
                  }
                }
              }
            ]);
          } catch (err) {
            console.warn('Comments query failed, returning empty array:', err);
            return [];
          }
        }),

        // 4. Reading history (only if user is logged in)
        userId ? UserChapterInteraction.aggregate([
          {
            $match: {
              userId: new mongoose.Types.ObjectId(userId),
              lastReadAt: {
                $ne: null,
                $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) // Last 2 weeks
              }
            }
          },
          { $sort: { lastReadAt: -1 } },
          {
            $group: {
              _id: '$novelId',
              latestInteraction: { $first: '$$ROOT' }
            }
          },
          { $replaceRoot: { newRoot: '$latestInteraction' } },
          { $sort: { lastReadAt: -1 } },
          { $limit: 5 },
          // Simplified lookups
          {
            $lookup: {
              from: 'chapters',
              localField: 'chapterId',
              foreignField: '_id',
              pipeline: [
                { $project: { title: 1, novelId: 1 } }
              ],
              as: 'chapter'
            }
          },
          {
            $lookup: {
              from: 'novels',
              localField: 'novelId',
              foreignField: '_id',
              pipeline: [
                { $project: { title: 1, illustration: 1 } }
              ],
              as: 'novel'
            }
          },
          {
            $addFields: {
              chapter: { $arrayElemAt: ['$chapter', 0] },
              novel: { $arrayElemAt: ['$novel', 0] }
            }
          },
          {
            $match: {
              'chapter._id': { $exists: true },
              'novel._id': { $exists: true }
            }
          },
          {
            $project: {
              chapterId: 1,
              novelId: 1,
              lastReadAt: 1,
              chapter: 1,
              novel: 1
            }
          }
        ]) : []
      ]);

      // Process novel list result
      const total = novelListResult[0]?.total[0]?.count || 0;
      const novels = novelListResult[0]?.novels || [];

      return {
        novelList: {
          novels,
          pagination: {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total
          }
        },
        hotNovels: hotNovels || [],
        recentComments: recentComments || [],
        readingHistory: readingHistory || []
      };
    });

    // Cache the result only if not bypassing
    if (!bypass) {
      cache.set(cacheKey, result, 1000 * 60 * 2); // 2 minutes cache
    }

    res.json(result);

  } catch (err) {
    console.error('Error in homepage route:', err);
    res.status(500).json({
      novelList: { novels: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0 } },
      hotNovels: [],
      recentComments: [],
      readingHistory: [],
      error: err.message
    });
  }
});

/**
 * Get optimized dashboard data for a novel (eliminates duplicate queries)
 * @route GET /api/novels/:id/dashboard
 */
router.get("/:id/dashboard", async (req, res) => {
  try {
    const novelId = req.params.id;
    const moduleId = req.query.moduleId;
    
    // Check if we should bypass cache
    const bypass = shouldBypassCache(req.path, req.query);
    const cacheKey = `novel-dashboard:${novelId}:${moduleId || 'all'}`;
    
    // Try to get from cache first (short TTL for dashboard data)
    if (!bypass) {
      const cachedData = cache.get(cacheKey);
      if (cachedData) {
        return res.json(cachedData);
      }
    }
    
    // Use query deduplication to prevent multiple identical requests
    const result = await dedupQuery(cacheKey, async () => {
      // Import Module here to avoid circular imports
      const Module = mongoose.model('Module');
      
      // Optimized aggregation pipeline that minimizes data transfer
      const [dashboardData] = await Novel.aggregate([
        // Match the specific novel
        {
          $match: { _id: new mongoose.Types.ObjectId(novelId) }
        },
        
        // Lookup all modules for this novel with full details
        {
          $lookup: {
            from: 'modules',
            localField: '_id',
            foreignField: 'novelId',
            pipeline: [
              { $sort: { order: 1 } }
            ],
            as: 'modules'
          }
        },
        
        // Only lookup chapters for the specific module if moduleId is provided
        // Otherwise, just get chapter counts per module for performance
        ...(moduleId ? [
          {
            $lookup: {
              from: 'chapters',
              let: { moduleId: new mongoose.Types.ObjectId(moduleId) },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ['$moduleId', '$$moduleId'] }
                  }
                },
                { $sort: { order: 1 } },
                // Project only essential fields for dashboard
                {
                  $project: {
                    title: 1,
                    order: 1,
                    mode: 1,
                    chapterBalance: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    moduleId: 1
                  }
                }
              ],
              as: 'moduleChapters'
            }
          }
        ] : [
          // If no specific module, get chapter counts per module for overview
          {
            $lookup: {
              from: 'chapters',
              localField: '_id',
              foreignField: 'novelId',
              pipeline: [
                {
                  $group: {
                    _id: '$moduleId',
                    count: { $sum: 1 },
                    lastUpdated: { $max: '$updatedAt' }
                  }
                }
              ],
              as: 'chapterCounts'
            }
          }
        ]),
        
        // If specific moduleId is provided, also get that module's details
        ...(moduleId ? [
          {
            $lookup: {
              from: 'modules',
              let: { novelId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$_id', new mongoose.Types.ObjectId(moduleId)] },
                        { $eq: ['$novelId', '$$novelId'] }
                      ]
                    }
                  }
                }
              ],
              as: 'selectedModule'
            }
          }
        ] : []),
        
        // Project the final structure
        {
          $project: {
            // Novel fields
            title: 1,
            description: 1,
            alternativeTitles: 1,
            author: 1,
            illustrator: 1,
            illustration: 1,
            status: 1,
            active: 1,
            inactive: 1,
            genres: 1,
            note: 1,
            updatedAt: 1,
            createdAt: 1,
            views: 1,
            ratings: 1,
            novelBalance: 1,
            novelBudget: 1,
            // Module data
            modules: 1,
            // Conditional chapter data
            ...(moduleId ? { 
              moduleChapters: 1,
              selectedModule: { $arrayElemAt: ['$selectedModule', 0] }
            } : { 
              chapterCounts: 1 
            })
          }
        }
      ]);

      if (!dashboardData) {
        return { error: "Novel not found", status: 404 };
      }

      let modulesWithChapters;
      
      if (moduleId && dashboardData.moduleChapters) {
        // If specific module requested, only attach chapters to that module
        modulesWithChapters = dashboardData.modules.map(module => {
          if (module._id.toString() === moduleId) {
            return {
              ...module,
              chapters: dashboardData.moduleChapters || []
            };
          }
          return {
            ...module,
            chapters: [] // Empty for other modules to save memory
          };
        });
      } else if (dashboardData.chapterCounts) {
        // If no specific module, add chapter counts to modules
        const countsByModule = dashboardData.chapterCounts.reduce((acc, count) => {
          acc[count._id.toString()] = count;
          return acc;
        }, {});
        
        modulesWithChapters = dashboardData.modules.map(module => ({
          ...module,
          chapterCount: countsByModule[module._id.toString()]?.count || 0,
          lastChapterUpdate: countsByModule[module._id.toString()]?.lastUpdated || null,
          chapters: [] // Don't load all chapters for overview
        }));
      } else {
        // Fallback: modules without chapter data
        modulesWithChapters = dashboardData.modules.map(module => ({
          ...module,
          chapters: []
        }));
      }

      return {
        novel: {
          _id: dashboardData._id,
          title: dashboardData.title,
          description: dashboardData.description,
          alternativeTitles: dashboardData.alternativeTitles,
          author: dashboardData.author,
          illustrator: dashboardData.illustrator,
          illustration: dashboardData.illustration,
          status: dashboardData.status,
          active: dashboardData.active,
          inactive: dashboardData.inactive,
          genres: dashboardData.genres,
          note: dashboardData.note,
          updatedAt: dashboardData.updatedAt,
          createdAt: dashboardData.createdAt,
          views: dashboardData.views,
          ratings: dashboardData.ratings,
          novelBalance: dashboardData.novelBalance,
          novelBudget: dashboardData.novelBudget
        },
        modules: modulesWithChapters,
        // Only include chapters array if specific module requested
        chapters: moduleId ? (dashboardData.moduleChapters || []) : [],
        selectedModule: dashboardData.selectedModule || null
      };
    });

    // Handle deduplication errors
    if (result.error) {
      return res.status(result.status).json({ message: result.error });
    }

    // Cache the result for a short time (30 seconds for dashboard data)
    if (!bypass) {
      cache.set(cacheKey, result, 1000 * 30); // 30 seconds cache
    }

    // Return dashboard data
    res.json(result);
  } catch (err) {
    console.error('Error in novel dashboard route:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 