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
import { createNewChapterNotifications } from '../services/notificationService.js';

const router = express.Router();

// Simple in-memory cache for slug lookups to avoid repeated DB queries
const slugCache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes
const MAX_CACHE_SIZE = 1000;

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

// Helper function to manage cache
const getCachedSlug = (slug) => {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedSlug = (slug, data) => {
  // Remove oldest entries if cache is too large
  if (slugCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = slugCache.keys().next().value;
    slugCache.delete(oldestKey);
  }
  
  slugCache.set(slug, {
    data,
    timestamp: Date.now()
  });
};

// Query deduplication helper
const dedupQuery = async (key, queryFn) => {
  // If query is already pending, wait for it
  if (pendingQueries.has(key)) {
    return await pendingQueries.get(key);
  }
  
  // Start new query
  const queryPromise = queryFn();
  pendingQueries.set(key, queryPromise);
  
  try {
    const result = await queryPromise;
    return result;
  } finally {
    // Clean up pending query
    pendingQueries.delete(key);
  }
};

/**
 * Lookup chapter ID by slug
 * @route GET /api/chapters/slug/:slug
 * 
 * PERFORMANCE NOTE: For optimal performance, ensure these indexes exist:
 * - db.chapters.createIndex({ "_id": 1 }) // Usually exists by default
 * - db.chapters.createIndex({ "title": 1 }) // For title searches
 * 
 * This optimized version uses ObjectId range queries for efficient lookups.
 */
router.get("/slug/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Check cache first
    const cached = getCachedSlug(slug);
    if (cached) {
      return res.json(cached);
    }
    
    // Extract the short ID from the slug (last 8 characters after final hyphen)
    const parts = slug.split('-');
    const shortId = parts[parts.length - 1];
    
    let result = null;
    
    // If it's already a full MongoDB ID, return it
    if (/^[0-9a-fA-F]{24}$/.test(slug)) {
      const chapter = await Chapter.findById(slug).select('_id title').lean();
      if (chapter) {
        result = { id: chapter._id, title: chapter.title };
      }
    } 
    // If we have a short ID (8 hex characters), find the chapter using ObjectId range query
    else if (/^[0-9a-fA-F]{8}$/.test(shortId)) {
      const shortIdLower = shortId.toLowerCase();
      
      // Create ObjectId range for efficient query
      // ObjectIds are 24 hex characters, so we want to find all IDs ending with our 8 characters
      // This means IDs from xxxxxxxxxxxxxxxx[shortId] to xxxxxxxxxxxxxxxx[shortId+1]
      
      // Create the lower bound: pad with zeros at the beginning
      const lowerBound = '0'.repeat(16) + shortIdLower;
      
      // Create the upper bound: increment the last character and pad
      let upperHex = shortIdLower;
      let carry = 1;
      let upperBoundArray = upperHex.split('').reverse();
      
      for (let i = 0; i < upperBoundArray.length && carry; i++) {
        let val = parseInt(upperBoundArray[i], 16) + carry;
        if (val > 15) {
          upperBoundArray[i] = '0';
          carry = 1;
        } else {
          upperBoundArray[i] = val.toString(16);
          carry = 0;
        }
      }
      
      let upperBound;
      if (carry) {
        // Overflow case - use max possible value
        upperBound = 'f'.repeat(24);
      } else {
        upperBound = '0'.repeat(16) + upperBoundArray.reverse().join('');
      }
      
      try {
        // Use a more targeted aggregation that's still efficient
        const [chapter] = await Chapter.aggregate([
          {
            $addFields: {
              idString: { $toString: "$_id" }
            }
          },
          {
            $match: {
              idString: { $regex: new RegExp(shortIdLower + '$', 'i') }
            }
          },
          {
            $project: {
              _id: 1,
              title: 1
            }
          },
          {
            $limit: 1
          }
        ]);
        
        if (chapter) {
          result = { id: chapter._id, title: chapter.title };
        }
      } catch (aggregationError) {
        console.warn('Aggregation failed, falling back to alternative method:', aggregationError);
        
        // Fallback: fetch chapters in batches and check suffix
        let skip = 0;
        const batchSize = 100;
        let found = false;
        
        while (!found) {
          const chapters = await Chapter.find({}, { _id: 1, title: 1 })
            .lean()
            .skip(skip)
            .limit(batchSize);
          
          if (chapters.length === 0) break; // No more chapters to check
          
          const matchingChapter = chapters.find(chapter => 
            chapter._id.toString().toLowerCase().endsWith(shortIdLower)
          );
          
          if (matchingChapter) {
            result = { id: matchingChapter._id, title: matchingChapter.title };
            found = true;
          }
          
          skip += batchSize;
        }
      }
    }
    
    if (result) {
      // Cache the result for future requests
      setCachedSlug(slug, result);
      return res.json(result);
    }
    
    res.status(404).json({ message: "Chapter not found" });
  } catch (err) {
    console.error('Error in chapter slug lookup:', err);
    res.status(500).json({ message: err.message });
  }
});

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
    
    // Use query deduplication to prevent multiple identical requests
    const chapterData = await dedupQuery(`chapter:${req.params.id}`, async () => {
      // Get chapter and its siblings in a single aggregation pipeline
      const [chapter] = await Chapter.aggregate([
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

      return chapter;
    });

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
      footnotes,
      chapterBalance
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
          mode: 1,
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

    // Validate that paid chapters cannot be created in paid modules
    if (mode === 'paid' && moduleData.mode === 'paid') {
      return res.status(400).json({ 
        message: 'Không thể tạo chương trả phí trong tập đã trả phí. Tập trả phí đã bao gồm tất cả chương bên trong.' 
      });
    }

    // Validate minimum chapter balance for paid chapters
    if (mode === 'paid' && parseInt(chapterBalance) < 1) {
      return res.status(400).json({ 
        message: 'Số lúa chương tối thiểu là 1 🌾 cho chương trả phí.' 
      });
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
      footnotes: footnotes || [],
      chapterBalance: mode === 'paid' ? (chapterBalance || 0) : 0
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

    // Create notifications for users who bookmarked this novel
    await createNewChapterNotifications(
      novelId.toString(),
      newChapter._id.toString(),
      newChapter.title
    );

    // Notify all clients about the new chapter
    notifyAllClients('new_chapter', {
      chapterId: newChapter._id,
      chapterTitle: newChapter.title,
      novelId: novelId,
      novelTitle: novel?.title || 'Unknown Novel',
      timestamp: new Date().toISOString()
    });

    // Check for auto-unlock if a paid chapter was created
    if (mode === 'paid') {
      // Import the checkAndUnlockContent function from novels.js
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(novelId);
    }

    res.status(201).json(populatedChapter);
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(400).json({ message: err.message });
  }
});

// Update a chapter
router.put('/:id', auth, async (req, res) => {
  try {
    const { 
      title, 
      content, 
      moduleId,
      translator,
      editor,
      proofreader,
      footnotes,
      chapterBalance
    } = req.body;
    const chapterId = req.params.id;

    // Get the original chapter data to check for mode changes and permissions
    const originalChapter = await Chapter.findById(chapterId, 'mode novelId moduleId').populate('novelId', 'active');
    if (!originalChapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // Check if user has permission (admin, moderator, or pj_user managing this novel)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      // For pj_user, check if they manage this novel
      if (req.user.role === 'pj_user') {
        const novel = originalChapter.novelId;
        
        // Check if user is in the novel's active pj_user array (handle both ObjectIds and usernames)
        const isAuthorized = novel.active?.pj_user?.includes(req.user._id.toString()) || 
                            novel.active?.pj_user?.includes(req.user.username);
        
        if (!isAuthorized) {
          return res.status(403).json({ message: 'Access denied. You do not manage this novel.' });
        }
      } else {
        return res.status(403).json({ message: 'Access denied. Admin, moderator, or project user privileges required.' });
      }
    }

    // If trying to set mode to paid, check if the module is paid
    if (req.body.mode === 'paid') {
      const targetModuleId = moduleId || originalChapter.moduleId;
      const module = await Module.findById(targetModuleId, 'mode');
      
      if (module && module.mode === 'paid') {
        return res.status(400).json({ 
          message: 'Không thể đặt chương thành trả phí trong tập đã trả phí. Tập trả phí đã bao gồm tất cả chương bên trong.' 
        });
      }

      // Validate minimum chapter balance for paid chapters
      if (parseInt(chapterBalance) < 1) {
        return res.status(400).json({ 
          message: 'Số lúa chương tối thiểu là 1 🌾 cho chương trả phí.' 
        });
      }
    }
    
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
                  chapterBalance: req.body.mode === 'paid' ? (chapterBalance || 0) : 0,
                  updatedAt: new Date()
                }
              },
              { 
                new: true,
                session }
            ),
            
          ]);
          
          // Commit transaction
          await session.commitTransaction();
          
          // Clear novel caches to ensure fresh data
          clearNovelCaches();

          // Check for auto-unlock if chapter was changed to paid mode
          if (req.body.mode === 'paid' && originalChapter.mode !== 'paid') {
            // Import the checkAndUnlockContent function from novels.js
            const { checkAndUnlockContent } = await import('./novels.js');
            await checkAndUnlockContent(originalChapter.novelId);
          }
          
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
        ...(req.body.mode === 'paid' ? { chapterBalance: chapterBalance || 0 } : {}),
        // Only update timestamp if content or title changes, not just mode
        ...(title || content ? { updatedAt: new Date() } : {})
      }
    };

    // Reset chapterBalance to 0 if mode is not paid
    if (req.body.mode && req.body.mode !== 'paid') {
      updateData.$set.chapterBalance = 0;
    }

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
      // Clear novel caches
      clearNovelCaches();
    }

    // Check for auto-unlock if chapter was changed to paid mode
    if (req.body.mode === 'paid' && originalChapter.mode !== 'paid') {
      // Import the checkAndUnlockContent function from novels.js
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(originalChapter.novelId);
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
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const chapterId = req.params.id;

    // Validate chapter ID format
    if (!mongoose.Types.ObjectId.isValid(chapterId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Invalid chapter ID format' });
    }

    // Find the chapter to delete
    const chapter = await Chapter.findById(chapterId).session(session);
    if (!chapter) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // Store IDs for cleanup operations
    const { novelId, moduleId } = chapter;

    // Delete the chapter
    await Chapter.findByIdAndDelete(chapterId).session(session);

    // Remove chapter reference from module
    await Module.findByIdAndUpdate(
      moduleId,
      { 
        $pull: { chapters: chapterId },
        $set: { updatedAt: new Date() }
      },
      { session }
    );

    // Delete all user interactions for this chapter
    await UserChapterInteraction.deleteMany(
      { chapterId: new mongoose.Types.ObjectId(chapterId) },
      { session }
    );

    // Update novel's timestamp
    await Novel.findByIdAndUpdate(
      novelId,
      { $set: { updatedAt: new Date() } },
      { session }
    );

    await session.commitTransaction();

    // Clear novel caches
    clearNovelCaches();

    // Notify clients of the chapter deletion
    notifyAllClients('update', {
      type: 'chapter_deleted',
      novelId: novelId,
      chapterId: chapterId,
      chapterTitle: chapter.title,
      timestamp: new Date().toISOString()
    });

    res.json({ 
      message: 'Chapter deleted successfully',
      deletedChapter: {
        id: chapterId,
        title: chapter.title
      }
    });

  } catch (err) {
    await session.abortTransaction();
    console.error('Error deleting chapter:', err);
    res.status(500).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

/**
 * Get full chapter data with all related information
 * @route GET /api/chapters/:id/full
 */
router.get('/:id/full', async (req, res) => {
  try {
    const chapterId = req.params.id;
    const userId = req.user ? req.user._id : null;
    
    // Execute all queries in parallel for better performance
    const [chapterResult, interactionStats, userInteraction] = await Promise.all([
      // Fetch chapter with novel info and navigation data (existing aggregation)
      Chapter.aggregate([
        { '$match': { _id: new mongoose.Types.ObjectId(chapterId) } },
        { '$lookup': { 
            from: 'novels', 
            localField: 'novelId', 
            foreignField: '_id', 
            pipeline: [ { '$project': { title: 1, illustration: 1, active: 1 } } ], 
            as: 'novel' 
        }},
        { '$lookup': { 
            from: 'chapters', 
            let: { moduleId: '$moduleId', currentOrder: '$order', chapterId: '$_id' }, 
            pipeline: [ 
              { '$match': { 
                  '$expr': { '$and': [ 
                    { '$eq': [ '$moduleId', '$$moduleId' ] }, 
                    { '$ne': [ '$_id', '$$chapterId' ] } 
                  ]} 
              }}, 
              { '$project': { _id: 1, title: 1, order: 1 } }, 
              { '$sort': { order: 1 } } 
            ], 
            as: 'siblingChapters' 
        }},
        { '$addFields': { 
            novel: { '$arrayElemAt': [ '$novel', 0 ] },
            prevChapter: { 
              '$let': { 
                vars: { 
                  prevChapters: { 
                    '$filter': { 
                      input: '$siblingChapters', 
                      as: 'sibling', 
                      cond: { '$lt': [ '$$sibling.order', '$order' ] } 
                    } 
                  } 
                }, 
                in: { '$arrayElemAt': [ { '$sortArray': { input: '$$prevChapters', sortBy: { order: -1 } } }, 0 ] } 
              } 
            },
            nextChapter: { 
              '$let': { 
                vars: { 
                  nextChapters: { 
                    '$filter': { 
                      input: '$siblingChapters', 
                      as: 'sibling', 
                      cond: { '$gt': [ '$$sibling.order', '$order' ] } 
                    } 
                  } 
                }, 
                in: { '$arrayElemAt': [ { '$sortArray': { input: '$$nextChapters', sortBy: { order: 1 } } }, 0 ] } 
              } 
            } 
        }},
        { '$project': { siblingChapters: 0 } }
      ]),

      // Get interaction statistics
      UserChapterInteraction.aggregate([
        {
          $match: { chapterId: new mongoose.Types.ObjectId(chapterId) }
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

      // Get user-specific interaction data if user is logged in
      userId ? UserChapterInteraction.findOne({ 
        userId, 
        chapterId: new mongoose.Types.ObjectId(chapterId) 
      }).lean() : null
    ]);

    if (!chapterResult.length) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    const chapter = chapterResult[0];
    const stats = interactionStats[0];

    // Build interaction response
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

    // Combine everything into a single response
    res.json({
      chapter,
      interactions
    });
  } catch (err) {
    console.error('Error getting full chapter data:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Create a new chapter
 * @route POST /api/chapters
 */
router.post('/', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { 
      title, 
      content, 
      novelId, 
      moduleId, 
      order, 
      translator, 
      editor, 
      proofreader,
      mode = 'free',
      chapterBalance = 0,
      footnotes = []
    } = req.body;

    // Validate required fields
    if (!title || !content || !novelId || !moduleId) {
      await session.abortTransaction();
      return res.status(400).json({ 
        message: 'Title, content, novelId, and moduleId are required' 
      });
    }

    // Verify the novel exists
    const novel = await Novel.findById(novelId).session(session);
    if (!novel) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Novel not found' });
    }

    // Verify the module exists
    const module = await Module.findById(moduleId).session(session);
    if (!module) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Module not found' });
    }

    // Determine the order if not provided
    let chapterOrder = order;
    if (!chapterOrder) {
      const lastChapter = await Chapter.findOne(
        { moduleId },
        { order: 1 }
      ).sort({ order: -1 }).session(session);
      chapterOrder = lastChapter ? lastChapter.order + 1 : 1;
    }

    // Create the new chapter
    const chapter = new Chapter({
      title,
      content,
      novelId,
      moduleId,
      order: chapterOrder,
      translator,
      editor,
      proofreader,
      mode,
      chapterBalance: mode === 'paid' ? chapterBalance : 0,
      footnotes
    });

    // Save the chapter
    await chapter.save({ session });

    // Add chapter to module's chapters array
    await Module.findByIdAndUpdate(
      moduleId,
      { 
        $addToSet: { chapters: chapter._id },
        $set: { updatedAt: new Date() }
      },
      { session }
    );

    // Update novel's timestamp
    await Novel.findByIdAndUpdate(
      novelId,
      { $set: { updatedAt: new Date() } },
      { session }
    );

    await session.commitTransaction();

    // Create notifications for users who bookmarked this novel
    await createNewChapterNotifications(
      novelId.toString(),
      chapter._id.toString(),
      title
    );

    // Clear novel caches
    clearNovelCaches();

    // Notify clients of the new chapter
    notifyAllClients('update', {
      type: 'chapter_created',
      novelId: novelId,
      chapterId: chapter._id,
      chapterTitle: title,
      timestamp: new Date().toISOString()
    });

    // Populate and return the created chapter
    await chapter.populate('novelId', 'title');
    res.status(201).json(chapter);

  } catch (err) {
    await session.abortTransaction();
    console.error('Error creating chapter:', err);
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

export default router; 