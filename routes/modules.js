import express from 'express';
import Module from '../models/Module.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';
import Chapter from '../models/Chapter.js';

const router = express.Router();

// Get all modules for a novel
router.get('/:novelId/modules', async (req, res) => {
  try {
    const modules = await Module.find({ novelId: req.params.novelId })
      .sort('order')
      .populate('chapters');
    res.json(modules);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get a specific module
router.get('/:novelId/modules/:moduleId', async (req, res) => {
  try {
    const module = await Module.findOne({
      _id: req.params.moduleId,
      novelId: req.params.novelId
    }).populate('chapters');
    
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }
    
    res.json(module);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Reorder modules - MOVED UP before other module-specific routes
router.put('/:novelId/modules/reorder', auth, admin, async (req, res) => {
  try {
    console.log('Backend - Received reorder request:', {
      body: req.body,
      params: req.params
    });

    const { moduleId, direction } = req.body;
    const novelId = req.params.novelId;

    // Get all modules for this novel
    const modules = await Module.find({ novelId }).sort('order');
    console.log('Backend - Current modules:', modules.map(m => ({
      id: m._id.toString(),
      title: m.title,
      order: m.order
    })));
    
    // Find the module to move and its index
    const currentIndex = modules.findIndex(m => m._id.toString() === moduleId);
    console.log('Backend - Current module index:', currentIndex);
    
    if (currentIndex === -1) {
      console.log('Backend - Module not found:', moduleId);
      return res.status(404).json({ message: 'Module not found' });
    }

    // Calculate target index
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    console.log('Backend - Target index:', targetIndex);
    
    // Check if move is possible
    if (targetIndex < 0 || targetIndex >= modules.length) {
      console.log('Backend - Invalid move:', { targetIndex, maxIndex: modules.length - 1 });
      return res.status(400).json({ message: 'Cannot move module further in that direction' });
    }

    // Get the two modules to swap
    const moduleToMove = modules[currentIndex];
    const moduleToSwap = modules[targetIndex];
    console.log('Backend - Swapping modules:', {
      moving: { id: moduleToMove._id.toString(), title: moduleToMove.title, order: moduleToMove.order },
      swapping: { id: moduleToSwap._id.toString(), title: moduleToSwap.title, order: moduleToSwap.order }
    });

    // Instead of directly swapping orders, we'll use a temporary order value
    // that's outside the range of existing orders to avoid conflicts
    const tempOrder = -1; // Temporary order value
    const originalOrder1 = moduleToMove.order;
    const originalOrder2 = moduleToSwap.order;

    // First, set one module to the temporary order
    moduleToMove.order = tempOrder;
    await moduleToMove.save();

    // Then set the second module to the first module's original order
    moduleToSwap.order = originalOrder1;
    await moduleToSwap.save();

    // Finally, set the first module to the second module's original order
    moduleToMove.order = originalOrder2;
    await moduleToMove.save();

    console.log('Backend - After swap:', {
      moving: { id: moduleToMove._id.toString(), title: moduleToMove.title, order: moduleToMove.order },
      swapping: { id: moduleToSwap._id.toString(), title: moduleToSwap.title, order: moduleToSwap.order }
    });

    res.json({ message: 'Modules reordered successfully' });
  } catch (err) {
    console.error('Backend - Error during reorder:', err);
    res.status(400).json({ message: err.message });
  }
});

// Create a new module
router.post('/:novelId/modules', auth, admin, async (req, res) => {
  try {
    const lastModule = await Module.findOne({ novelId: req.params.novelId })
      .sort('-order');
    const order = lastModule ? lastModule.order + 1 : 0;

    const module = new Module({
      novelId: req.params.novelId,
      title: req.body.title,
      coverImage: req.body.coverImage,
      order: order
    });

    const newModule = await module.save();
    res.status(201).json(newModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update a module
router.put('/:novelId/modules/:moduleId', auth, admin, async (req, res) => {
  try {
    const module = await Module.findById(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }

    if (req.body.title) module.title = req.body.title;
    if (req.body.coverImage) module.coverImage = req.body.coverImage;
    
    const updatedModule = await module.save();
    res.json(updatedModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete a module
router.delete('/:novelId/modules/:moduleId', auth, admin, async (req, res) => {
  try {
    const module = await Module.findByIdAndDelete(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }
    res.json({ message: 'Module deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add chapter to module
router.post('/:novelId/modules/:moduleId/chapters/:chapterId', auth, admin, async (req, res) => {
  try {
    const module = await Module.findById(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }

    module.chapters.push(req.params.chapterId);
    const updatedModule = await module.save();
    res.json(updatedModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Remove chapter from module
router.delete('/:novelId/modules/:moduleId/chapters/:chapterId', auth, admin, async (req, res) => {
  try {
    const module = await Module.findById(req.params.moduleId);
    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }

    module.chapters = module.chapters.filter(
      chapter => chapter.toString() !== req.params.chapterId
    );
    const updatedModule = await module.save();
    res.json(updatedModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Reorder chapters within a module
router.put('/:novelId/modules/:moduleId/chapters/reorder', auth, admin, async (req, res) => {
  try {
    const { chapterId, direction } = req.body;
    const { moduleId } = req.params;

    // Get all chapters for this module
    const chapters = await Chapter.find({ moduleId }).sort('order');

    // Find the chapter to move
    const currentIndex = chapters.findIndex(ch => ch._id.toString() === chapterId);
    if (currentIndex === -1) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // Calculate target index
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= chapters.length) {
      return res.status(400).json({ message: 'Invalid move direction' });
    }

    // Get the chapters to swap
    const chapterToMove = chapters[currentIndex];
    const chapterToSwap = chapters[targetIndex];

    // Use a temporary order to avoid conflicts during swap
    const tempOrder = -1;
    const orderA = chapterToMove.order;
    const orderB = chapterToSwap.order;

    // First set one chapter to temp order
    chapterToMove.order = tempOrder;
    await chapterToMove.save();

    // Then set the other chapter to first chapter's order
    chapterToSwap.order = orderA;
    await chapterToSwap.save();

    // Finally set first chapter to second chapter's original order
    chapterToMove.order = orderB;
    await chapterToMove.save();

    // Get updated chapters list with proper sorting
    const updatedChapters = await Chapter.find({ moduleId }).sort('order');
    
    // Add prev/next chapter information for each chapter
    const chaptersWithNavigation = updatedChapters.map((chapter, index) => {
      return {
        ...chapter.toObject(),
        prevChapter: index > 0 ? updatedChapters[index - 1] : null,
        nextChapter: index < updatedChapters.length - 1 ? updatedChapters[index + 1] : null
      };
    });

    res.json({
      message: 'Chapters reordered successfully',
      chapters: chaptersWithNavigation
    });
  } catch (err) {
    console.error('Error during chapter reorder:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router;