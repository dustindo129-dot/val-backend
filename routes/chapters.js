import express from 'express';
import Chapter from '../models/Chapter.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';
import Module from '../models/Module.js';
import Novel from '../models/Novel.js';
import mongoose from 'mongoose';
import UserChapterInteraction from '../models/UserChapterInteraction.js';

// Import the novel cache clearing function
import { clearNovelCaches, clearChapterCaches, notifyAllClients } from '../utils/cacheUtils.js';
import { createNewChapterNotifications } from '../services/notificationService.js';
import { populateStaffNames } from '../utils/populateStaffNames.js';

const router = express.Router();

// Simple in-memory cache for slug lookups to avoid repeated DB queries
const slugCache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes
const MAX_CACHE_SIZE = 1000;

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

/**
 * Server-side word counting function that replicates TinyMCE's algorithm
 * @param {string} htmlContent - HTML content to count words in
 * @returns {number} Word count using TinyMCE-compatible algorithm
 */
const calculateWordCount = (htmlContent) => {
  if (!htmlContent || typeof htmlContent !== 'string') return 0;
  
  // Step 1: Extract text from HTML exactly like TinyMCE
  const tempDiv = { innerHTML: htmlContent };
  // Simple HTML tag removal for server-side processing
  let text = htmlContent.replace(/<[^>]*>/g, ' ');
  
  if (!text.trim()) return 0;
  
  // Step 2: Handle HTML entities
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'")
             .replace(/&apos;/g, "'");
  
  // Step 3: Use TinyMCE's word counting approach
  const wordRegex = /[\w\u00C0-\u024F\u1E00-\u1EFF\u0100-\u017F\u0180-\u024F\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF]+/g;
  
  // Step 4: Find all word matches
  const matches = text.match(wordRegex);
  
  if (!matches) return 0;
  
  // Step 5: Filter matches like TinyMCE does
  const filteredMatches = matches.filter(match => {
    // Filter out single standalone digits
    if (match.length === 1 && /^\d$/.test(match)) {
      return false;
    }
    
    // Filter out single standalone letters that are likely not words
    if (match.length === 1 && /^[a-zA-Z]$/.test(match)) {
      return false;
    }
    
    return true;
  });
  
  return filteredMatches.length;
};

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
          $match: { _id: mongoose.Types.ObjectId.createFromHexString(req.params.id) }
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

    // Populate staff ObjectIds with user display names
    const populatedChapter = await populateStaffNames(chapterData);

    // We don't need to increment views here anymore.
    // The view increment is now handled by the dedicated endpoint
    // in userChapterInteractions.js that respects the 8-hour window.
    // This prevents double-counting of views.

    res.json({ chapter: populatedChapter });
  } catch (err) {
    console.error('Error fetching chapter:', err);
    res.status(500).json({ message: err.message });
  }
});

// Create a new chapter (admin, moderator, or pj_user managing the novel)
router.post('/', auth, async (req, res) => {
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
    
    // Check if user has permission (admin, moderator, or pj_user managing this novel)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      // For pj_user, check if they manage this novel
      if (req.user.role === 'pj_user') {
        const novel = await Novel.findById(novelId).lean();
        if (!novel) {
          return res.status(404).json({ message: 'Novel not found' });
        }
        
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
    
    // Use aggregation to get the module and determine order in a single query
    const [moduleData] = await Module.aggregate([
      { $match: { _id: mongoose.Types.ObjectId.createFromHexString(moduleId) } },
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

    // Calculate word count for the chapter content
    const calculatedWordCount = calculateWordCount(content);

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
      chapterBalance: mode === 'paid' ? (chapterBalance || 0) : 0,
      wordCount: calculatedWordCount
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
    const novel = await Novel.findById(novelId).select('title');

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
      
      // IMPORTANT: Clear all relevant caches after auto-unlock to prevent stale data
      clearChapterCaches(newChapter._id.toString());
      
      // Clear slug cache entries for this chapter to prevent stale mode caching
      const chapterIdString = newChapter._id.toString();
      const keysToDelete = [];
      for (const [key, value] of slugCache.entries()) {
        if (value.data && value.data.id && value.data.id.toString() === chapterIdString) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => slugCache.delete(key));
      
      // Clear query deduplication cache for this chapter
      pendingQueries.delete(`chapter:${newChapter._id}`);
    }

    // Fetch the final chapter state AFTER auto-unlock (if it happened)
    // This ensures we return the correct mode to the client
    const finalChapter = await Chapter.findById(newChapter._id).populate('moduleId', 'title');
    const populatedChapter = await populateStaffNames(finalChapter.toObject());

    res.status(201).json(populatedChapter);
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(400).json({ message: err.message });
  }
});

/**
 * Helper function to recalculate and update novel word count
 * @param {string} novelId - The novel ID
 * @param {object} session - MongoDB session (optional)
 */
const recalculateNovelWordCount = async (novelId, session = null) => {
  try {
    // Ensure novelId is a proper ObjectId (handle both string and ObjectId inputs)
    const novelObjectId = mongoose.Types.ObjectId.isValid(novelId) 
      ? (typeof novelId === 'string' ? mongoose.Types.ObjectId.createFromHexString(novelId) : novelId)
      : null;
    
    if (!novelObjectId) {
      throw new Error('Invalid novelId provided to recalculateNovelWordCount');
    }
    
    // Aggregate total word count from all chapters in this novel
    const result = await Chapter.aggregate([
      { $match: { novelId: novelObjectId } },
      { 
        $group: {
          _id: null,
          totalWordCount: { $sum: '$wordCount' }
        }
      }
    ]).session(session);

    const totalWordCount = result.length > 0 ? result[0].totalWordCount : 0;

    // Update the novel with the new word count
    await Novel.findByIdAndUpdate(
      novelObjectId,
      { wordCount: totalWordCount },
      { session }
    );

    return totalWordCount;
  } catch (error) {
    console.error('Error recalculating novel word count:', error);
    throw error;
  }
};

/**
 * Update a chapter
 * @route PUT /api/chapters/:id
 */
router.put('/:id', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const chapterId = req.params.id;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(chapterId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Invalid chapter ID format' });
    }

    const {
      title,
      content,
      translator,
      editor,
      proofreader,
      mode,
      chapterBalance = 0,
      footnotes = [],
      wordCount = 0
    } = req.body;
    
    // Find the existing chapter
    const existingChapter = await Chapter.findById(chapterId).session(session);
    if (!existingChapter) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Chapter not found' });
    }
    


    // Check if user has permission to edit this chapter
    const novel = await Novel.findById(existingChapter.novelId).session(session);
    if (!novel) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Novel not found' });
    }

    // Permission check: admin, moderator, or pj_user managing this novel
    let hasPermission = false;
    if (req.user.role === 'admin' || req.user.role === 'moderator') {
      hasPermission = true;
    } else if (req.user.role === 'pj_user') {
      // Check if user manages this novel
      const isAuthorized = novel.active?.pj_user?.includes(req.user._id.toString()) || 
                          novel.active?.pj_user?.includes(req.user.username);
      hasPermission = isAuthorized;
    }

    if (!hasPermission) {
      await session.abortTransaction();
      return res.status(403).json({ 
        message: 'Access denied. You do not have permission to edit this chapter.' 
      });
    }

    // Prevent pj_users from changing paid mode (only when actually changing, not when keeping the same)
    if (req.user.role === 'pj_user' && mode && mode !== existingChapter.mode && (existingChapter.mode === 'paid' || mode === 'paid')) {
      await session.abortTransaction();
      return res.status(403).json({ 
        message: 'Bạn không có quyền thay đổi chế độ trả phí. Chỉ admin mới có thể thay đổi.' 
      });
    }

    // Validate chapter balance for paid chapters
    // Only enforce minimum balance validation when:
    // 1. User is admin (who can actually set the balance), AND
    // 2. Mode is being changed TO paid (not already paid), AND 
    // 3. Balance is less than 1
    if (req.user.role === 'admin' && mode === 'paid' && existingChapter.mode !== 'paid' && chapterBalance < 1) {
      await session.abortTransaction();
      return res.status(400).json({ 
        message: 'Số lúa chương tối thiểu là 1 🌾 cho chương trả phí.' 
      });
    }
    
    // Determine the final chapter balance
    let finalChapterBalance;
    if (req.user.role === 'admin') {
      // Admins can set the balance
      finalChapterBalance = mode === 'paid' ? Math.max(0, chapterBalance || 0) : 0;
    } else {
      // Non-admins preserve existing balance for paid chapters, 0 for others
      finalChapterBalance = mode === 'paid' ? existingChapter.chapterBalance : 0;
    }

    // Check if content changed and calculate word count accordingly
    const contentChanged = content && content !== existingChapter.content;
    let finalWordCount = existingChapter.wordCount;
    
    if (contentChanged) {
      // If content changed, recalculate word count server-side
      finalWordCount = calculateWordCount(content);
    } else if (wordCount !== undefined && wordCount !== existingChapter.wordCount) {
      // If word count was explicitly provided (from TinyMCE), use that
      finalWordCount = Math.max(0, wordCount);
    }
    
    const shouldRecalculateWordCount = contentChanged || finalWordCount !== existingChapter.wordCount;

    // Update the chapter
    const updatedChapter = await Chapter.findByIdAndUpdate(
      chapterId,
      {
        ...(title && { title }),
        ...(content && { content }),
        ...(translator !== undefined && { translator }),
        ...(editor !== undefined && { editor }),
        ...(proofreader !== undefined && { proofreader }),
        ...(mode && { mode }),
        chapterBalance: finalChapterBalance,
        footnotes,
        wordCount: finalWordCount, // Use calculated or provided word count
        updatedAt: new Date()
      },
      { 
        new: true, 
        session,
        runValidators: true 
      }
    );

    // Only recalculate novel word count if content or word count actually changed
    if (shouldRecalculateWordCount) {
      await recalculateNovelWordCount(existingChapter.novelId, session);
    }

    // Only update novel's timestamp for significant changes that should affect "latest updates"
    // Don't update for simple content edits or manual mode changes
    // Novel timestamp will be updated automatically when paid content is unlocked via contributions
    const shouldUpdateNovelTimestamp = 
      (req.user.role === 'admin' && chapterBalance !== existingChapter.chapterBalance); // Admin changed chapter balance (for accounting purposes)

    if (shouldUpdateNovelTimestamp) {
      await Novel.findByIdAndUpdate(
        existingChapter.novelId,
        { updatedAt: new Date() },
        { session }
      );
    }

    await session.commitTransaction();

    // Clear novel caches
    clearNovelCaches();

    // Notify clients of the update
    notifyAllClients('update', {
      type: 'chapter_updated',
      novelId: existingChapter.novelId,
      chapterId: updatedChapter._id,
      chapterTitle: updatedChapter.title,
      timestamp: new Date().toISOString()
    });

    // Populate and return the updated chapter
    const populatedChapter = await populateStaffNames(updatedChapter.toObject());
    res.json(populatedChapter);

  } catch (err) {
    await session.abortTransaction();
    console.error('Error updating chapter:', err);
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
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
      { chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId) },
      { session }
    );

    // Recalculate novel word count
    await recalculateNovelWordCount(novelId, session);

    // Don't update novel's timestamp when deleting chapters
    // Chapter deletion is a management action, not new content

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
        { '$match': { _id: mongoose.Types.ObjectId.createFromHexString(chapterId) } },
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
          $match: { chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId) }
        },
        {
          $group: {
            _id: null,
            totalLikes: {
              $sum: { $cond: [{ $eq: ['$liked', true] }, 1, 0] }
            }
          }
        }
      ]),

      // Get user-specific interaction data if user is logged in
      userId ? UserChapterInteraction.findOne({ 
        userId, 
        chapterId: mongoose.Types.ObjectId.createFromHexString(chapterId) 
      }).lean() : null
    ]);

    if (!chapterResult.length) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    const chapter = chapterResult[0];
    const stats = interactionStats[0];

    // Populate staff ObjectIds with user display names
    const populatedChapter = await populateStaffNames(chapter);

    // Build interaction response
    const interactions = {
      totalLikes: stats?.totalLikes || 0,
      userInteraction: {
        liked: userInteraction?.liked || false,
        bookmarked: userInteraction?.bookmarked || false
      }
    };

    // Combine everything into a single response
    res.json({
      chapter: populatedChapter,
      interactions
    });
  } catch (err) {
    console.error('Error getting full chapter data:', err);
    res.status(500).json({ message: err.message });
    }
});

/**
 * Batch update word counts for chapters with 0 word count
 * @route POST /api/chapters/batch-update-wordcount
 */
router.post('/batch-update-wordcount', auth, async (req, res) => {
  // Only allow admins to run this batch operation
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
  }

  try {
    // Find all chapters with 0 word count but have content
    const chaptersToUpdate = await Chapter.find({
      wordCount: 0,
      content: { $exists: true, $ne: '' }
    }).select('_id content novelId').lean();

    if (chaptersToUpdate.length === 0) {
      return res.json({ 
        message: 'No chapters found with 0 word count that have content.',
        updated: 0 
      });
    }

    console.log(`Found ${chaptersToUpdate.length} chapters to update word counts for.`);

    let updatedCount = 0;
    const batchSize = 50; // Process in batches to avoid overwhelming the database
    
    for (let i = 0; i < chaptersToUpdate.length; i += batchSize) {
      const batch = chaptersToUpdate.slice(i, i + batchSize);
      const bulkOps = [];

      for (const chapter of batch) {
        const wordCount = calculateWordCount(chapter.content);
        if (wordCount > 0) {
          bulkOps.push({
            updateOne: {
              filter: { _id: chapter._id },
              update: { $set: { wordCount: wordCount, updatedAt: new Date() } }
            }
          });
        }
      }

      if (bulkOps.length > 0) {
        const result = await Chapter.bulkWrite(bulkOps);
        updatedCount += result.modifiedCount;
      }

      console.log(`Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(chaptersToUpdate.length / batchSize)}`);
    }

    // Recalculate novel word counts for affected novels
    const affectedNovels = [...new Set(chaptersToUpdate.map(ch => ch.novelId.toString()))];
    console.log(`Recalculating word counts for ${affectedNovels.length} novels...`);

    for (const novelId of affectedNovels) {
      try {
        await recalculateNovelWordCount(novelId);
      } catch (error) {
        console.error(`Failed to recalculate word count for novel ${novelId}:`, error);
      }
    }

    // Clear caches
    clearNovelCaches();

    res.json({
      message: `Successfully updated word counts for ${updatedCount} chapters and recalculated ${affectedNovels.length} novel word counts.`,
      updated: updatedCount,
      novelsRecalculated: affectedNovels.length
    });

  } catch (error) {
    console.error('Error in batch word count update:', error);
    res.status(500).json({ 
      message: 'Error updating word counts', 
      error: error.message 
    });
  }
});

export default router; 