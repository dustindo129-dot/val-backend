import express from 'express';
import Chapter from '../models/Chapter.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';
import Module from '../models/Module.js';
import Novel from '../models/Novel.js';
import mongoose from 'mongoose';
import UserChapterInteraction from '../models/UserChapterInteraction.js';

// Import the novel cache clearing function
import { clearNovelCaches, notifyAllClients } from '../utils/cacheUtils.js';

const router = express.Router();

// Get all chapters for a module
router.get('/module/:moduleId', async (req, res) => {
  try {
    const chapters = await Chapter.find({ moduleId: req.params.moduleId })
      .sort({ order: 1 });
    res.json(chapters);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all chapters for a novel
router.get('/novel/:novelId', async (req, res) => {
  try {
    const chapters = await Chapter.find({ novelId: req.params.novelId })
      .sort({ order: 1 });
    res.json(chapters);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get a specific chapter
router.get('/:id', async (req, res) => {
  try {
    console.log(`Fetching chapter with ID: ${req.params.id}`);
    
    // Get chapter and its siblings in a single aggregation pipeline
    const [chapterData] = await Chapter.aggregate([
      // First, match the requested chapter by ID
      {
        $match: { _id: new mongoose.Types.ObjectId(req.params.id) }
      },
      
      // Next, lookup the novel info (just the title)
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
      
      // Then, lookup all chapters from the same module
      {
        $lookup: {
          from: 'chapters',
          let: { 
            moduleId: '$moduleId', 
            currentOrder: '$order', 
            chapterId: '$_id' 
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$moduleId', '$$moduleId'] }, // Only match chapters in same module
                    { $ne: ['$_id', '$$chapterId'] }
                  ]
                }
              }
            },
            { $project: { _id: 1, title: 1, order: 1 } },
            { $sort: { order: 1 } }
          ],
          as: 'siblingChapters'
        }
      },
      
      // Add fields for novel, prevChapter, and nextChapter
      {
        $addFields: {
          novel: { $arrayElemAt: ['$novel', 0] },
          prevChapter: {
            $let: {
              vars: {
                prevChapters: {
                  $filter: {
                    input: '$siblingChapters',
                    as: 'sibling',
                    cond: { $lt: ['$$sibling.order', '$order'] }
                  }
                }
              },
              in: {
                $arrayElemAt: [
                  { $sortArray: { input: '$$prevChapters', sortBy: { order: -1 } } },
                  0
                ]
              }
            }
          },
          nextChapter: {
            $let: {
              vars: {
                nextChapters: {
                  $filter: {
                    input: '$siblingChapters',
                    as: 'sibling',
                    cond: { $gt: ['$$sibling.order', '$order'] }
                  }
                }
              },
              in: {
                $arrayElemAt: [
                  { $sortArray: { input: '$$nextChapters', sortBy: { order: 1 } } },
                  0
                ]
              }
            }
          }
        }
      },
      
      // Remove the siblings field from the output
      {
        $project: {
          siblingChapters: 0
        }
      }
    ]);

    if (!chapterData) {
      console.log('Chapter not found');
      return res.status(404).json({ message: 'Chapter not found' });
    }

    console.log(`Found chapter: ${chapterData.title}`);
    console.log(`Navigation: prev=${chapterData.prevChapter?._id}, next=${chapterData.nextChapter?._id}`);

    // We don't need to increment views here anymore.
    // The view increment is now handled by the dedicated endpoint
    // in userChapterInteractions.js that respects the 8-hour window.
    // This prevents double-counting of views.

    res.json({ chapter: chapterData });
  } catch (err) {
    console.error('Error fetching chapter:', err);
    res.status(500).json({ message: err.message });
  }
});

// Create a new chapter (admin only)
router.post('/', [auth, admin], async (req, res) => {
  try {
    const { 
      novelId, 
      moduleId, 
      title, 
      content,
      translator,
      editor,
      proofreader,
      mode,
      footnotes
    } = req.body;
    
    // Use aggregation to get the module and determine order in a single query
    const [moduleData] = await Module.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(moduleId) } },
      {
        $lookup: {
          from: 'chapters',
          let: { moduleId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$moduleId', '$$moduleId'] } } },
            { $sort: { order: -1 } },
            { $limit: 1 },
            { $project: { order: 1 } }
          ],
          as: 'lastChapter'
        }
      },
      {
        $project: {
          lastChapterOrder: { 
            $cond: [
              { $gt: [{ $size: '$lastChapter' }, 0] },
              { $arrayElemAt: ['$lastChapter.order', 0] },
              -1
            ]
          }
        }
      }
    ]);

    if (!moduleData) {
      return res.status(404).json({ message: 'Module not found' });
    }

    const order = moduleData.lastChapterOrder + 1;

    // Create the new chapter with staff fields and footnotes
    const chapter = new Chapter({
      novelId,
      moduleId,
      title,
      content,
      order,
      translator,
      editor,
      proofreader,
      mode: mode || 'published',
      views: 0,
      footnotes: footnotes || []
    });

    // Save the chapter
    const newChapter = await chapter.save();

    // Perform multiple updates in parallel
    await Promise.all([
      // Update the module's chapters array
      Module.findByIdAndUpdate(
        moduleId,
        { $addToSet: { chapters: newChapter._id } }
      ),
      
      // Update novel's updatedAt timestamp ONLY (no view count updates)
      Novel.findByIdAndUpdate(
        novelId,
        { updatedAt: new Date() }
      ),
      
      // Clear novel caches
      clearNovelCaches()
    ]);

    // Get novel info for the notification
    const [novel, populatedChapter] = await Promise.all([
      Novel.findById(novelId).select('title'),
      Chapter.findById(newChapter._id).populate('moduleId', 'title')
    ]);

    // Notify all clients about the new chapter
    notifyAllClients('new_chapter', {
      chapterId: newChapter._id,
      chapterTitle: newChapter.title,
      novelId: novelId,
      novelTitle: novel?.title || 'Unknown Novel',
      timestamp: new Date().toISOString()
    });

    res.status(201).json(populatedChapter);
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(400).json({ message: err.message });
  }
});

// Update a chapter (admin only)
router.put('/:id', [auth, admin], async (req, res) => {
  try {
    const { 
      title, 
      content, 
      moduleId,
      translator,
      editor,
      proofreader,
      footnotes
    } = req.body;
    const chapterId = req.params.id;
    
    // If moduleId is changing, handle module transition logic
    if (moduleId) {
      // Find chapter with minimal projection to get only what we need
      const chapter = await Chapter.findById(chapterId, {
        moduleId: 1, novelId: 1, order: 1, _id: 1
      });

      if (!chapter) {
        return res.status(404).json({ message: 'Chapter not found' });
      }

      // If moduleId is changing, update the old and new modules' chapters arrays
      if (moduleId !== chapter.moduleId.toString()) {
        // Start a session for transaction
        const session = await mongoose.startSession();
        session.startTransaction();
        
        try {
          // Get the highest order value for chapters in the target module in one query
          const [lastChapterInTarget] = await Chapter.aggregate([
            { $match: { moduleId: new mongoose.Types.ObjectId(moduleId) } },
            { $sort: { order: -1 } },
            { $limit: 1 },
            { $project: { order: 1 } }
          ]).session(session);
          
          // Determine new order
          const newOrder = lastChapterInTarget ? lastChapterInTarget.order + 1 : 0;
          
          // Perform all module transition operations in parallel
          await Promise.all([
            // 1. Remove chapter from old module
            Module.findByIdAndUpdate(
              chapter.moduleId,
              { $pull: { chapters: chapter._id } },
              { session }
            ),
            
            // 2. Update chapter orders in old module
            Chapter.updateMany(
              { 
                novelId: chapter.novelId,
                moduleId: chapter.moduleId,
                order: { $gt: chapter.order }
              },
              { $inc: { order: -1 } },
              { session }
            ),

            // 3. Add chapter to new module
            Module.findByIdAndUpdate(
              moduleId,
              { $addToSet: { chapters: chapter._id } },
              { session }
            ),
            
            // 4. Update the chapter with all changes at once
            Chapter.findByIdAndUpdate(
              chapterId,
              { 
                $set: {
                  title: title || chapter.title,
                  content: content,
                  moduleId: moduleId,
                  order: newOrder,
                  translator: translator,
                  editor: editor,
                  proofreader: proofreader,
                  mode: req.body.mode,
                  footnotes: footnotes || [],
                  updatedAt: new Date()
                }
              },
              { 
                new: true,
                session }
            ),
            
            // 5. Update novel's timestamp and view count
            Novel.findByIdAndUpdate(
              chapter.novelId,
              { updatedAt: new Date() },
              { session }
            )
          ]);
          
          // Commit transaction
          await session.commitTransaction();
          
          // Clear novel caches to ensure fresh data
          clearNovelCaches();
          
          // Get updated chapter to return to client
          const updatedChapter = await Chapter.findById(chapterId);
          return res.json(updatedChapter);
        } catch (err) {
          // If anything fails, abort the transaction
          await session.abortTransaction();
          throw err;
        } finally {
          session.endSession();
        }
      }
    }

    // If moduleId is not changing, just update the chapter
    const updateData = {
      $set: {
        ...(title && { title }),
        ...(content && { content }),
        ...(translator && { translator }),
        ...(editor && { editor }),
        ...(proofreader && { proofreader }),
        ...(req.body.mode && { mode: req.body.mode }),
        ...(footnotes && { footnotes }),
        // Only update timestamp if content or title changes, not just mode
        ...(title || content ? { updatedAt: new Date() } : {})
      }
    };

    const updatedChapter = await Chapter.findByIdAndUpdate(
      chapterId,
      updateData,
      { new: true }
    );

    if (!updatedChapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // Only update novel if content or title changes, not just mode
    if (title || content) {
      await Novel.findByIdAndUpdate(
        updatedChapter.novelId,
        { updatedAt: new Date() }
      );
      
      // Clear novel caches
      clearNovelCaches();
    }
    
    res.json(updatedChapter);
  } catch (err) {
    console.error('Error updating chapter:', err);
    res.status(400).json({ message: err.message });
  }
});

/**
 * Delete a chapter
 * @route DELETE /api/chapters/:id
 */
router.delete('/:id', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Get chapter info before deletion
    const chapter = await Chapter.findOne(
      { _id: req.params.id },
      { novelId: 1, moduleId: 1, order: 1 }
    ).session(session);

    if (!chapter) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // Remove chapter from module's chapters array
    await Module.findOneAndUpdate(
      { _id: chapter.moduleId },
      {
        $setOnInsert: { createdAt: new Date() },
        $set: { updatedAt: new Date() },
        $pull: { chapters: chapter._id }
      },
      { session }
    );

    // Delete the chapter
    await Chapter.findOneAndDelete(
      { _id: req.params.id },
      { session }
    );

    // Update order of remaining chapters
    await Chapter.updateMany(
      {
        novelId: chapter.novelId,
        moduleId: chapter.moduleId,
        order: { $gt: chapter.order }
      },
      { $inc: { order: -1 } },
      { session }
    );

    // Update novel's timestamp and optionally increment view count
    const shouldSkipViewTracking = req.query.skipViewTracking === 'true';
    const novelUpdate = {
      $set: { updatedAt: new Date() }
    };
    
    // Removing view count increment completely
    // if (!shouldSkipViewTracking) {
    //   novelUpdate.$inc = { 'views.total': 1 };
    // }

    await Novel.findOneAndUpdate(
      { _id: chapter.novelId },
      novelUpdate,
      { session }
    );

    await session.commitTransaction();
    
    // Clear novel caches
    clearNovelCaches();
    
    // Notify clients of update
    notifyAllClients('update', {
      type: 'chapter_deleted',
      novelId: chapter.novelId,
      chapterId: chapter._id,
      timestamp: new Date().toISOString()
    });

    res.json({ message: 'Chapter deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

/**
 * Toggle like status for a chapter
 * @route POST /api/chapters/:id/like
 */
router.post("/:id/like", auth, async (req, res) => {
  try {
    const chapterId = req.params.id;
    const userId = req.user._id;

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find or create interaction
    let interaction = await UserChapterInteraction.findOne({ 
      userId, 
      chapterId,
      novelId: chapter.novelId 
    });
    
    if (!interaction) {
      // Create new interaction with liked=true
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        liked: true
      });
    } else {
      // Toggle existing interaction
      interaction.liked = !interaction.liked;
    }
    await interaction.save();

    // Get total likes count
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: mongoose.Types.ObjectId(chapterId), liked: true } },
      { $group: { _id: null, totalLikes: { $sum: 1 } } }
    ]);
    
    return res.json({ 
      liked: interaction.liked,
      totalLikes: stats?.totalLikes || 0
    });
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Rate a chapter
 * @route POST /api/chapters/:id/rate
 */
router.post("/:id/rate", auth, async (req, res) => {
  try {
    const chapterId = req.params.id;
    const userId = req.user._id;
    const { rating } = req.body;

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find or create interaction
    let interaction = await UserChapterInteraction.findOne({ 
      userId, 
      chapterId,
      novelId: chapter.novelId 
    });
    
    if (!interaction) {
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        rating
      });
    } else {
      interaction.rating = rating;
    }
    await interaction.save();

    // Calculate new rating statistics
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: mongoose.Types.ObjectId(chapterId), rating: { $exists: true, $ne: null } } },
      { 
        $group: { 
          _id: null, 
          totalRatings: { $sum: 1 },
          ratingSum: { $sum: "$rating" }
        } 
      }
    ]);

    const totalRatings = stats?.totalRatings || 0;
    const averageRating = totalRatings > 0 
      ? (stats.ratingSum / totalRatings).toFixed(1) 
      : '0.0';

    return res.json({
      rating,
      totalRatings,
      averageRating
    });
  } catch (err) {
    console.error("Error rating chapter:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Remove rating from a chapter
 * @route DELETE /api/chapters/:id/rate
 */
router.delete("/:id/rate", auth, async (req, res) => {
  try {
    const chapterId = req.params.id;
    const userId = req.user._id;

    // Check if chapter exists
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    // Find interaction
    const interaction = await UserChapterInteraction.findOne({ userId, chapterId });
    if (!interaction || !interaction.rating) {
      return res.status(404).json({ message: "No rating found for this chapter" });
    }

    // Remove rating
    interaction.rating = null;
    await interaction.save();

    // Calculate new rating statistics
    const [stats] = await UserChapterInteraction.aggregate([
      { $match: { chapterId: mongoose.Types.ObjectId(chapterId), rating: { $exists: true, $ne: null } } },
      { 
        $group: { 
          _id: null, 
          totalRatings: { $sum: 1 },
          ratingSum: { $sum: "$rating" }
        } 
      }
    ]);

    const totalRatings = stats?.totalRatings || 0;
    const averageRating = totalRatings > 0 
      ? (stats.ratingSum / totalRatings).toFixed(1) 
      : '0.0';

    return res.json({
      totalRatings,
      averageRating
    });
  } catch (err) {
    console.error("Error removing rating:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get user's interaction with a chapter
 * @route GET /api/chapters/:id/user-interaction
 */
router.get("/:id/user-interaction", auth, async (req, res) => {
  try {
    const chapterId = req.params.id;
    const userId = req.user._id;

    // Get user's interaction
    const interaction = await UserChapterInteraction.findOne({ userId, chapterId });
    
    if (!interaction) {
      return res.json({
        liked: false,
        rating: null
      });
    }

    return res.json({
      liked: interaction.liked || false,
      rating: interaction.rating || null
    });
  } catch (err) {
    console.error("Error getting user interaction:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get chapter interactions (likes, ratings)
 * @route GET /api/chapters/:id/interactions
 */
router.get('/:id/interactions', async (req, res) => {
  try {
    const chapterId = req.params.id;
    
    // Aggregate interactions data
    const [stats] = await UserChapterInteraction.aggregate([
      {
        $match: { chapterId: mongoose.Types.ObjectId(chapterId) }
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
    ]);

    // If no interactions exist yet, return default values
    if (!stats) {
      return res.json({
        totalLikes: 0,
        totalRatings: 0,
        averageRating: '0.0'
      });
    }

    const averageRating = stats.totalRatings > 0 
      ? (stats.ratingSum / stats.totalRatings).toFixed(1) 
      : '0.0';

    res.json({
      totalLikes: stats.totalLikes,
      totalRatings: stats.totalRatings,
      averageRating
    });
  } catch (err) {
    console.error('Error getting chapter interactions:', err);
    res.status(500).json({ message: err.message });
  }
});

// Bookmark/unbookmark a chapter
router.post('/:id/bookmark', auth, async (req, res) => {
  try {
    const chapterId = req.params.id;
    const userId = req.user._id;

    // Get the chapter to ensure it exists and get the novelId
    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // Find current interaction
    let interaction = await UserChapterInteraction.findOne({
      userId,
      chapterId,
      novelId: chapter.novelId
    });

    const currentlyBookmarked = interaction?.bookmarked || false;

    // If we're bookmarking (not unbookmarking), remove any existing bookmarks for this novel
    if (!currentlyBookmarked) {
      await UserChapterInteraction.updateMany(
        { 
          userId,
          novelId: chapter.novelId,
          bookmarked: true,
          chapterId: { $ne: chapterId }
        },
        { $set: { bookmarked: false } }
      );
    }

    // Update or create the interaction for this chapter
    if (!interaction) {
      interaction = new UserChapterInteraction({
        userId,
        chapterId,
        novelId: chapter.novelId,
        bookmarked: !currentlyBookmarked
      });
    } else {
      interaction.bookmarked = !currentlyBookmarked;
    }

    await interaction.save();

    res.json({ 
      bookmarked: interaction.bookmarked,
      chapterId: interaction.chapterId
    });
  } catch (err) {
    console.error('Error toggling chapter bookmark:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 