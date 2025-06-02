import express from 'express';
import Module from '../models/Module.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';
import Chapter from '../models/Chapter.js';
import { clearNovelCaches } from '../utils/cacheUtils.js';
import Novel from '../models/Novel.js';
import mongoose from 'mongoose';

const router = express.Router();

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

// Helper function for query deduplication
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
 * Lookup module ID by slug
 * @route GET /api/modules/slug/:slug
 */
router.get("/slug/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Use query deduplication for this lookup
    const result = await dedupQuery(`module-slug:${slug}`, async () => {
      // Extract the short ID from the slug (last 8 characters after final hyphen)
      const parts = slug.split('-');
      const shortId = parts[parts.length - 1];
      
      // If it's already a full MongoDB ID, return it
      if (/^[0-9a-fA-F]{24}$/.test(slug)) {
        const module = await Module.findById(slug).select('_id title').lean();
        if (module) {
          return { id: module._id, title: module.title };
        }
        return null;
      }
      
      // If we have a short ID (8 hex characters), find the module using efficient aggregation
      if (/^[0-9a-fA-F]{8}$/.test(shortId)) {
        const shortIdLower = shortId.toLowerCase();
        
        try {
          // Use efficient aggregation similar to chapters and novels
          const [module] = await Module.aggregate([
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
          
          if (module) {
            return { id: module._id, title: module.title };
          }
        } catch (aggregationError) {
          console.warn('Module aggregation failed, falling back to batch method:', aggregationError);
          
          // Fallback: Use a more targeted approach by querying in batches
          // This is still better than loading all modules at once
          let skip = 0;
          const batchSize = 100;
          
          while (true) {
            const modules = await Module.find({}, { _id: 1, title: 1 })
              .lean()
              .skip(skip)
              .limit(batchSize);
            
            if (modules.length === 0) break; // No more modules to check
            
            const matchingModule = modules.find(module => 
              module._id.toString().toLowerCase().endsWith(shortIdLower)
            );
            
            if (matchingModule) {
              return { id: matchingModule._id, title: matchingModule.title };
            }
            
            skip += batchSize;
          }
        }
      }
      
      return null;
    });
    
    if (result) {
      return res.json(result);
    }
    
    res.status(404).json({ message: "Module not found" });
  } catch (err) {
    console.error('Error in module slug lookup:', err);
    res.status(500).json({ message: err.message });
  }
});

// New optimized route to get all modules with chapters for a novel
router.get('/:novelId/modules-with-chapters', async (req, res) => {
  try {
    // First get all modules for the novel
    const modules = await Module.find({ novelId: req.params.novelId })
      .sort('order')
      .lean(); // Use lean() for better performance since we're modifying the objects

    // Get all chapters for this novel in one query
    const chapters = await Chapter.find({ 
      novelId: req.params.novelId 
    }).sort('order').lean();

    // Create a map of moduleId to chapters for efficient lookup
    const chaptersByModule = chapters.reduce((acc, chapter) => {
      if (!acc[chapter.moduleId]) {
        acc[chapter.moduleId] = [];
      }
      acc[chapter.moduleId].push(chapter);
      return acc;
    }, {});

    // Attach chapters to their respective modules
    const modulesWithChapters = modules.map(module => ({
      ...module,
      chapters: chaptersByModule[module._id.toString()] || []
    }));

    res.json(modulesWithChapters);
  } catch (err) {
    console.error('Error fetching modules with chapters:', err);
    res.status(500).json({ message: err.message });
  }
});

// Get all modules for a novel (keeping for backward compatibility)
router.get('/:novelId/modules', async (req, res) => {
  try {
    const modules = await Module.find({ novelId: req.params.novelId })
      .sort('order')
      .populate({
        path: 'chapters',
        options: { sort: { order: 1 } }
      });
    res.json(modules);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get a specific module
router.get('/:novelId/modules/:moduleId', async (req, res) => {
  try {
    const { novelId, moduleId } = req.params;
    
    // Use query deduplication to prevent multiple identical requests
    const module = await dedupQuery(`module:${novelId}:${moduleId}`, async () => {
      return await Module.findOne({
        _id: moduleId,
        novelId: novelId
      }).populate({
        path: 'chapters',
        options: { sort: { order: 1 } }
      });
    });
    
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }
    
    res.json(module);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Reorder modules - MOVED UP before other module-specific routes
router.put('/:novelId/modules/reorder', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { moduleId, direction } = req.body;
    const novelId = req.params.novelId;

    // Get all modules for this novel
    const modules = await Module.find({ novelId }).sort('order');
    
    // Find the module to move and its index
    const currentIndex = modules.findIndex(m => m._id.toString() === moduleId);
    
    if (currentIndex === -1) {
      throw new Error('Module not found');
    }

    // Calculate target index
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    
    // Check if move is possible
    if (targetIndex < 0 || targetIndex >= modules.length) {
      throw new Error('Cannot move module further in that direction');
    }

    // Get current and target modules
    const moduleToMove = modules[currentIndex];
    const otherModule = modules[targetIndex];
    
    // Store original order values
    const originalOrder = moduleToMove.order;
    const targetOrder = otherModule.order;
    
    // STEP 1: First set the moving module to a temporary negative order
    await Module.findByIdAndUpdate(
      moduleToMove._id,
      { $set: { order: -9999 } },
      { session }
    );
    
    // STEP 2: Update the target module
    await Module.findByIdAndUpdate(
      otherModule._id,
      { $set: { order: originalOrder } },
      { session }
    );
    
    // STEP 3: Finally, set the moving module to its target position
    await Module.findByIdAndUpdate(
      moduleToMove._id,
      { $set: { order: targetOrder } },
      { session }
    );

    // Update novel's timestamp
    await Novel.findByIdAndUpdate(
      novelId,
      { updatedAt: new Date() },
      { session }
    );

    // Commit the transaction
    await session.commitTransaction();
    
    // Clear novel caches
    clearNovelCaches();

    // Return the updated modules order
    const updatedModules = await Module.find({ novelId }).sort('order');
    
    res.json({
      message: 'Modules reordered successfully',
      modules: updatedModules
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Backend - Error during reorder:', err);
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

// Create a new module
router.post('/:novelId/modules', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  try {
    // Validate paid module balance
    if (req.body.mode === 'paid') {
      const moduleBalance = parseInt(req.body.moduleBalance) || 0;
      if (moduleBalance < 1) {
        return res.status(400).json({ 
          message: 'Số lượng lúa cần phải tối thiểu là 1 🌾' 
        });
      }
    }

    // Find the highest order number for this novel
    const modules = await Module.find({ novelId: req.params.novelId })
      .sort('-order')
      .limit(1)
      .lean();
    
    // Calculate next order number
    const nextOrder = modules.length > 0 ? modules[0].order + 1 : 0;

    // Create the new module
    const module = new Module({
      novelId: req.params.novelId,
      title: req.body.title,
      illustration: req.body.illustration,
      order: nextOrder,
      chapters: [],
      mode: req.body.mode || 'published',
      moduleBalance: req.body.mode === 'paid' ? (parseInt(req.body.moduleBalance) || 0) : 0
    });

    // Save the module
    const newModule = await module.save();
    
    // Update the novel's timestamp and view count in one operation
    await Novel.findByIdAndUpdate(
      req.params.novelId,
      { 
        updatedAt: new Date(),
        $inc: { 'views.total': 1 }
      }
    );
    
    // Clear novel caches in one operation
    clearNovelCaches();

    // Check for auto-unlock if a paid module was created
    if (req.body.mode === 'paid') {
      // Import the checkAndUnlockContent function from novels.js
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(req.params.novelId);
    }
    
    // Return the created module
    res.status(201).json(newModule);
  } catch (err) {
    console.error('Error creating module:', err);
    if (err.code === 11000) {
      // Handle duplicate key error
      return res.status(400).json({ 
        message: 'A module with this order number already exists. Please try again.' 
      });
    }
    res.status(400).json({ message: err.message });
  }
});

// Update a module
router.put('/:novelId/modules/:moduleId', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  try {
    // Get the current module to check if mode is changing to paid
    const currentModule = await Module.findById(req.params.moduleId);
    if (!currentModule) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Validate paid module balance
    if (req.body.mode === 'paid') {
      const moduleBalance = parseInt(req.body.moduleBalance) || 0;
      if (moduleBalance < 1) {
        return res.status(400).json({ 
          message: 'Số lượng lúa cần phải tối thiểu là 1 🌾' 
        });
      }
    }

    const updateData = {
      title: req.body.title,
      illustration: req.body.illustration,
      mode: req.body.mode || 'published',
      moduleBalance: req.body.mode === 'paid' ? (parseInt(req.body.moduleBalance) || 0) : 0,
      updatedAt: new Date()
    };

    const updatedModule = await Module.findByIdAndUpdate(
      req.params.moduleId,
      { $set: updateData },
      { new: true }
    );

    if (!updatedModule) {
      return res.status(404).json({ message: 'Module not found' });
    }
    
    // Update the novel's updatedAt timestamp to bring it to the top of latest updates
    await Novel.findByIdAndUpdate(
      req.params.novelId,
      { updatedAt: new Date() }
    );
    
    // Clear novel caches to ensure fresh data on next request
    clearNovelCaches();

    // Check for auto-unlock if module was changed to paid mode
    if (req.body.mode === 'paid' && currentModule.mode !== 'paid') {
      // Import the checkAndUnlockContent function from novels.js
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(req.params.novelId);
    }
    
    res.json(updatedModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete a module
router.delete('/:novelId/modules/:moduleId', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  try {
    // Use findOneAndDelete to ensure we only run one query operation
    // Also check that the moduleId belongs to the correct novel for security
    const module = await Module.findOneAndDelete({
      _id: req.params.moduleId,
      novelId: req.params.novelId
    });
    
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }
    
    // If the module has chapters, update their moduleId or delete them
    if (module.chapters && module.chapters.length > 0) {
      // Delete all chapters associated with this module in one operation
      await Chapter.deleteMany({ 
        moduleId: req.params.moduleId,
        novelId: req.params.novelId
      });
    }
    
    // Update novel updatedAt timestamp and increment view in one operation
    await Novel.findByIdAndUpdate(
      req.params.novelId,
      { 
        updatedAt: new Date(),
        // Using $inc for views.total to avoid a separate query
        $inc: { 'views.total': 1 },
        // Add a conditional update for daily views
        $push: {
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
                            { $gte: ['$$day.date', new Date(new Date().setHours(0, 0, 0, 0))] },
                            { $lt: ['$$day.date', new Date(new Date().setHours(23, 59, 59, 999))] }
                          ]
                        }
                      }
                    }
                  },
                  0
                ]
              },
              // If entry exists, don't push new one
              then: { $each: [] },
              // If no entry for today, add a new one
              else: {
                $each: [{ date: new Date(), count: 1 }],
                $sort: { date: -1 },
                $slice: 7  // Keep only the last 7 days
              }
            }
          }
        }
      },
      { new: true } // Return the updated document
    );
    
    // Clear novel caches to ensure fresh data on next request
    clearNovelCaches();
    
    // Return success with minimal data to reduce response size
    res.json({ 
      message: 'Module deleted successfully',
      _id: module._id
    });
  } catch (err) {
    console.error('Error deleting module:', err);
    res.status(500).json({ message: err.message });
  }
});

// Add chapter to module - update to maintain chapters array
router.post('/:novelId/modules/:moduleId/chapters/:chapterId', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  try {
    const module = await Module.findById(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Add chapter to module's chapters array if not already present
    if (!module.chapters.includes(req.params.chapterId)) {
      module.chapters.push(req.params.chapterId);
      await module.save();
    }

    // Update chapter's moduleId
    await Chapter.findByIdAndUpdate(req.params.chapterId, {
      moduleId: req.params.moduleId
    });

    const updatedModule = await Module.findById(req.params.moduleId)
      .populate({
        path: 'chapters',
        options: { sort: { order: 1 } }
      });

    // Clear novel caches to ensure fresh data on next request
    clearNovelCaches();

    res.json(updatedModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Remove chapter from module
router.delete('/:novelId/modules/:moduleId/chapters/:chapterId', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  try {
    const module = await Module.findById(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }

    module.chapters = module.chapters.filter(
      chapter => chapter.toString() !== req.params.chapterId
    );
    const updatedModule = await module.save();
    
    // Clear novel caches to ensure fresh data on next request
    clearNovelCaches();
    
    res.json(updatedModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Reorder chapters within a module
router.put('/:novelId/modules/:moduleId/chapters/:chapterId/reorder', auth, async (req, res) => {
  // Check if user is admin or moderator
  if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
    return res.status(403).json({ message: 'Access denied. Admin or moderator privileges required.' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { direction } = req.body;
    const { novelId, moduleId, chapterId } = req.params;
    const skipUpdateTimestamp = req.query.skipUpdateTimestamp === 'true';

    // Get all chapters for this module
    const chapters = await Chapter.find({ moduleId }).sort('order');
    
    // Find the chapter to move and its index
    const currentIndex = chapters.findIndex(c => c._id.toString() === chapterId);
    
    if (currentIndex === -1) {
      throw new Error('Chapter not found');
    }

    // Calculate target index
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    
    // Check if move is possible
    if (targetIndex < 0 || targetIndex >= chapters.length) {
      throw new Error('Cannot move chapter further in that direction');
    }

    // Get current and target chapters
    const chapterToMove = chapters[currentIndex];
    const otherChapter = chapters[targetIndex];

    // Store original order values
    const originalOrder = chapterToMove.order;
    const targetOrder = otherChapter.order;
    
    // STEP 1: First set the moving chapter to a temporary negative order
    await Chapter.findByIdAndUpdate(
      chapterToMove._id,
      { $set: { order: -9999 } },
      { session }
    );
    
    // STEP 2: Update the target chapter
    await Chapter.findByIdAndUpdate(
      otherChapter._id,
      { $set: { order: originalOrder } },
      { session }
    );
    
    // STEP 3: Finally, set the moving chapter to its target position
    await Chapter.findByIdAndUpdate(
      chapterToMove._id,
      { $set: { order: targetOrder } },
      { session }
    );

    // Update module's chapters array to reflect new order
    await Module.findByIdAndUpdate(
      moduleId,
      { 
        $set: { 
          chapters: chapters.map(c => 
            c._id.toString() === chapterToMove._id.toString() ? chapterToMove._id :
            c._id.toString() === otherChapter._id.toString() ? otherChapter._id :
            c._id
          )
        }
      },
      { session }
    );

    // Only update novel's timestamp if not skipping
    if (!skipUpdateTimestamp) {
      await Novel.findByIdAndUpdate(
        novelId,
        { updatedAt: new Date() },
        { session }
      );
    }

    // Commit the transaction
    await session.commitTransaction();
    
    // Clear novel caches
    clearNovelCaches();

    // Get updated chapters list
    const updatedChapters = await Chapter.find({ moduleId }).sort('order');
    
    res.json({
      message: 'Chapters reordered successfully',
      chapters: updatedChapters
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Backend - Error during chapter reorder:', err);
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

export default router;