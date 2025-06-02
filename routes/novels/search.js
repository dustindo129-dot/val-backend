import express from "express";
import Novel from "../../models/Novel.js";
import Chapter from "../../models/Chapter.js";
import { cache, shouldBypassCache } from '../../utils/cacheUtils.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Search novels by title
 * Supports partial matches and case-insensitive search
 * @route GET /api/novels/search
 */
router.get("/search", async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) {
      return res.status(400).json({ message: "Search query is required" });
    }

    // Split search terms and create regex pattern
    const searchTerms = title.split(" ").filter((term) => term.length > 0);
    const searchPattern = searchTerms.map((term) => `(?=.*${term})`).join("");

    const novels = await Novel.aggregate([
      {
        $match: {
          $or: [
            // Match main title
            { title: { $regex: searchPattern, $options: "i" } },
            // Match alternative titles if they exist
            { alternativeTitles: { $regex: searchPattern, $options: "i" } },
          ],
        }
      },
      // Lookup chapters to get accurate count
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
            {
              $count: 'total'
            }
          ],
          as: 'chapterCount'
        }
      },
      // Add chapter count field
      {
        $addFields: {
          totalChapters: {
            $cond: {
              if: { $gt: [{ $size: '$chapterCount' }, 0] },
              then: { $arrayElemAt: ['$chapterCount.total', 0] },
              else: 0
            }
          }
        }
      },
      {
        $project: {
          title: 1,
          illustration: 1,
          author: 1,
          status: 1,
          totalChapters: 1
        }
      },
      { $limit: 10 }
    ]);

    res.json(novels);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get hot novels (most viewed in specific time range)
 * @route GET /api/novels/hot
 */
router.get("/hot", async (req, res) => {
  try {
    const timeRange = req.query.timeRange || 'today';
    
    // Check if we should bypass the cache
    const bypass = shouldBypassCache(req.path, req.query);
    
    // Only check cache if not bypassing
    const cacheKey = `hot_novels_${timeRange}`;
    const cachedData = bypass ? null : cache.get(cacheKey);
    
    if (cachedData && !bypass) {
      return res.json(cachedData);
    }

    console.log(`Fetching fresh hot novels data for ${timeRange} from database`);
    
    // Set date range based on timeRange parameter
    const now = new Date();
    let startDate;
    
    if (timeRange === 'today') {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
    } else if (timeRange === 'week') {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
    }
    
    let hotNovels = [];
    
    // First try to get novels based on view count
    if (timeRange === 'today' || timeRange === 'week') {
      // For today and week timeframes
      try {
        // Find novels with views in the selected time range
        hotNovels = await Novel.aggregate([
          // Only include novels with daily views
          { $match: { "views.daily": { $exists: true, $ne: [] } } },
          // Unwind daily views array
          { $unwind: "$views.daily" },
          // Match views from selected time range
          {
            $match: {
              "views.daily.date": { $gte: startDate }
            }
          },
          // Group by novel ID to prevent duplicates and sum the view counts
          {
            $group: {
              _id: "$_id",
              title: { $first: "$title" },
              illustration: { $first: "$illustration" },
              status: { $first: "$status" },
              updatedAt: { $first: "$updatedAt" },
              dailyViews: { $sum: "$views.daily.count" }
            }
          },
          // Sort by the summed daily views
          { $sort: { dailyViews: -1 } },
          // Limit to top 5
          { $limit: 5 },
          // Lookup latest chapters
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
                { $limit: 1 },
                {
                  $project: {
                    _id: 1,
                    title: 1,
                    createdAt: 1
                  }
                }
              ],
              as: 'chapters'
            }
          },
          // Project final fields
          {
            $project: {
              _id: 1,
              title: 1,
              illustration: 1,
              status: 1,
              updatedAt: 1,
              chapters: 1,
              dailyViews: 1,
              source: { $literal: "views" }
            }
          }
        ]);
      } catch (err) {
        console.error("Error fetching novels by views:", err);
        // Continue with empty array if this fails
        hotNovels = [];
      }
    } else {
      // For alltime, use total views
      try {
        hotNovels = await Novel.aggregate([
          // Match only novels with total views
          { $match: { "views.total": { $exists: true, $gt: 0 } } },
          // Sort by total views
          { $sort: { "views.total": -1 } },
          // Limit to top 5
          { $limit: 5 },
          // Lookup latest chapters
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
                { $limit: 1 },
                {
                  $project: {
                    _id: 1,
                    title: 1,
                    createdAt: 1
                  }
                }
              ],
              as: 'chapters'
            }
          },
          // Project final fields
          {
            $project: {
              _id: 1,
              title: 1,
              illustration: 1,
              status: 1,
              updatedAt: 1,
              chapters: 1,
              dailyViews: "$views.total",
              source: { $literal: "views" }
            }
          }
        ]);
      } catch (err) {
        console.error("Error fetching novels by all-time views:", err);
        // Continue with empty array if this fails
        hotNovels = [];
      }
    }
    
    // Check if we need to add more novels
    if (hotNovels.length < 5) {
      // Calculate how many more novels we need
      const remainingCount = 5 - hotNovels.length;
      
      // Get IDs of novels we already have to exclude them
      const existingNovelIds = hotNovels.map(novel => novel._id);
      
      try {
        // Find most recently updated novels that aren't already in our list
        const recentNovels = await Novel.aggregate([
          {
            $match: {
              _id: { $nin: existingNovelIds.map(id => new mongoose.Types.ObjectId(id)) }
            }
          },
          // Sort by updatedAt (most recent first)
          { $sort: { updatedAt: -1 } },
          // Limit to what we need
          { $limit: remainingCount },
          // Lookup latest chapters
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
                { $limit: 1 },
                {
                  $project: {
                    _id: 1,
                    title: 1,
                    createdAt: 1
                  }
                }
              ],
              as: 'chapters'
            }
          },
          // Project the same fields as hotNovels
          {
            $project: {
              _id: 1,
              title: 1,
              illustration: 1,
              status: 1,
              updatedAt: 1,
              chapters: 1,
              dailyViews: { $literal: 0 },
              source: { $literal: "recent" }
            }
          }
        ]);
        
        // Combine the two sets of novels
        hotNovels = [...hotNovels, ...recentNovels];
      } catch (err) {
        console.error("Error fetching recent novels:", err);
      }
    }
    
    const result = { novels: hotNovels };
    
    // Cache the result only if not bypassing
    if (!bypass) {
      cache.set(cacheKey, result);
    }
    
    res.json(result);
  } catch (err) {
    console.error("Error in GET /api/novels/hot:", err);
    res.status(500).json({
      novels: [],
      error: err.message
    });
  }
});

export default router; 