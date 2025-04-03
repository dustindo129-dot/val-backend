import express from 'express';
import Chapter from '../models/Chapter.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';
import Module from '../models/Module.js';
import Novel from '../models/Novel.js';
import mongoose from 'mongoose';

// Import the novel cache clearing function
import { clearNovelCaches, notifyAllClients } from '../utils/cacheUtils.js';

const router = express.Router();

/**
 * Updates the daily view count for a novel
 * @param {string} novelId - The ID of the novel
 */
async function updateDailyViewCount(novelId) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Use findOneAndUpdate with MongoDB operators to safely update the view count
    // without needing to fetch the document first
    await Novel.updateOne(
      { _id: novelId },
      { 
        // Increment total views
        $inc: { 'views.total': 1 },
        
        // Use aggregation operators to handle the daily views
        $push: {
          // First filter out any existing entry for today
          // Then add the new/incremented entry
          'views.daily': {
            $cond: {
              if: {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: '$views.daily',
                        as: 'day',
                        cond: {
                          $and: [
                            { $gte: ['$$day.date', today] },
                            { $lt: ['$$day.date', new Date(today.getTime() + 24 * 60 * 60 * 1000)] }
                          ]
                        }
                      }
                    }
                  },
                  0
                ]
              },
              // If entry exists, use $each with empty array (no push)
              then: { $each: [] },
              // If no entry for today, add a new one
              else: {
                $each: [{ date: today, count: 1 }],
                $sort: { date: -1 },
                $slice: 7  // Keep only the last 7 days
              }
            }
          }
        }
      }
    );
    
    // Use a separate query to increment an existing entry for today
    await Novel.updateOne(
      { 
        _id: novelId,
        'views.daily.date': {
          $gte: today,
          $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
        }
      },
      { $inc: { 'views.daily.$.count': 1 } }
    );
  } catch (err) {
    console.error('Error updating daily view count:', err);
  }
}

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
      
      // Then, lookup all chapters from the same novel
      {
        $lookup: {
          from: 'chapters',
          let: { novelId: '$novelId', currentOrder: '$order', chapterId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$novelId', '$$novelId'] },
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
          // Modified to ensure we get the highest order chapter that's still less than current
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
          // Modified to ensure we get the lowest order chapter that's still greater than current
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

    // Increment view count in background without blocking response
    Novel.findByIdAndUpdate(chapterData.novelId, {
      $inc: { 'views.total': 1 }
    }).exec();

    // Also update daily views count
    updateDailyViewCount(chapterData.novelId).catch(err => 
      console.error('Error updating daily view count:', err)
    );

    res.json({ chapter: chapterData });
  } catch (err) {
    console.error('Error fetching chapter:', err);
    res.status(500).json({ message: err.message });
  }
});

// Create a new chapter (admin only)
router.post('/', [auth, admin], async (req, res) => {
  try {
    const { novelId, moduleId, title, content } = req.body;
    
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

    // Create the new chapter
    const chapter = new Chapter({
      novelId,
      moduleId,
      title,
      content,
      order
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
      
      // Update novel's updatedAt timestamp and increment view count in one operation
      Novel.findByIdAndUpdate(
        novelId,
        { 
          updatedAt: new Date(),
          $inc: { 'views.total': 1 }
        }
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
    const { title, content, moduleId } = req.body;
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
                  updatedAt: new Date()
                }
              },
              { 
                new: true,
                session
              }
            ),
            
            // 5. Update novel's timestamp and view count
            Novel.findByIdAndUpdate(
              chapter.novelId,
              { 
                updatedAt: new Date(),
                $inc: { 'views.total': 1 }
              },
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

    // If moduleId is not changing, just update the chapter content and title
    const updatedChapter = await Chapter.findByIdAndUpdate(
      chapterId,
      { 
        $set: {
          title: title,
          content: content,
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    if (!updatedChapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // Update novel's updatedAt timestamp and view count in one operation
    await Novel.findByIdAndUpdate(
      updatedChapter.novelId,
      { 
        updatedAt: new Date(),
        $inc: { 'views.total': 1 }
      }
    );
    
    // Clear novel caches
    clearNovelCaches();
    
    res.json(updatedChapter);
  } catch (err) {
    console.error('Error updating chapter:', err);
    res.status(400).json({ message: err.message });
  }
});

// Delete a chapter (admin only)
router.delete('/:id', [auth, admin], async (req, res) => {
  // Start a session for transaction
  const session = await mongoose.startSession();
  
  try {
    // Start transaction
    await session.withTransaction(async () => {
      // Find the chapter with minimal projection to get only what we need
      const chapter = await Chapter.findById(req.params.id)
        .select('novelId moduleId order')
        .session(session);
        
      if (!chapter) {
        throw new Error('Chapter not found');
      }

      // Save needed references
      const { novelId, moduleId, order } = chapter;

      // Perform operations in parallel for efficiency
      await Promise.all([
        // 1. Remove the chapter reference from module and delete the chapter in one operation
        Module.findByIdAndUpdate(
          moduleId,
          { 
            $pull: { chapters: chapter._id },
            updatedAt: new Date()
          },
          { session }
        ),

        // 2. Delete the chapter
        Chapter.findByIdAndDelete(chapter._id, { session }),

        // 3. Update order of remaining chapters
        Chapter.updateMany(
          { 
            novelId,
            moduleId,
            order: { $gt: order }
          },
          { $inc: { order: -1 } },
          { session }
        ),

        // 4. Update novel's timestamp and view count
        Novel.findByIdAndUpdate(
          novelId,
          { 
            updatedAt: new Date(),
            $inc: { 'views.total': 1 }
          },
          { session }
        )
      ]);
      
      // Clear novel caches - keep this outside the Promise.all to ensure it runs after DB operations
      await clearNovelCaches();
      
      // Notify clients about the update - more efficient to do this with the novel ID
      notifyAllClients('update', { 
        novelId,
        type: 'chapter_deleted',
        chapterId: req.params.id,
        timestamp: new Date().toISOString()
      });
    });

    // If we get here, the transaction was successful
    res.json({ message: 'Chapter deleted successfully' });
  } catch (err) {
    console.error('Error deleting chapter:', err);
    res.status(500).json({ message: err.message });
  } finally {
    // End the session
    session.endSession();
  }
});

export default router; 