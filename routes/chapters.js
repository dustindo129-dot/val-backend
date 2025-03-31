import express from 'express';
import Chapter from '../models/Chapter.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';

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
    const chapter = await Chapter.findById(req.params.id);
    
    if (!chapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }
    
    res.json(chapter);
  } catch (err) {
    console.error('Error fetching chapter:', err);
    res.status(500).json({ message: err.message });
  }
});

// Create a new chapter (admin only)
router.post('/', [auth, admin], async (req, res) => {
  try {
    const { novelId, moduleId, title, content } = req.body;

    // Get the highest order value for chapters in this module
    const lastChapter = await Chapter.findOne({ moduleId })
      .sort('-order');
    
    // If no chapters exist or last chapter has order -1, start from 0
    const lastOrder = lastChapter && lastChapter.order >= 0 ? lastChapter.order : -1;
    const order = lastOrder + 1;

    const chapter = new Chapter({
      novelId,
      moduleId,
      title,
      content,
      order
    });

    const newChapter = await chapter.save();
    res.status(201).json(newChapter);
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(400).json({ message: err.message });
  }
});

// Update a chapter (admin only)
router.put('/:id', [auth, admin], async (req, res) => {
  try {
    const { title, content } = req.body;
    const chapter = await Chapter.findById(req.params.id);

    if (!chapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    chapter.title = title || chapter.title;
    chapter.content = content || chapter.content;
    chapter.updatedAt = new Date();

    const updatedChapter = await chapter.save();
    res.json(updatedChapter);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete a chapter (admin only)
router.delete('/:id', [auth, admin], async (req, res) => {
  try {
    const chapter = await Chapter.findByIdAndDelete(req.params.id);
    if (!chapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }
    res.json({ message: 'Chapter deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router; 