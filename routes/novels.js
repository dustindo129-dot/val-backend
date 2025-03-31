import express from 'express';
import Novel from '../models/Novel.js';
import { uploadImage } from '../utils/imageUpload.js';
import { auth } from '../middleware/auth.js';
import Chapter from '../models/Chapter.js';

const router = express.Router();

/**
 * Search novels by title
 * Supports partial matches and case-insensitive search
 * @route GET /api/novels/search
 */
router.get('/search', async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) {
      return res.status(400).json({ message: 'Search query is required' });
    }

    // Split search terms and create regex pattern
    const searchTerms = title.split(' ').filter(term => term.length > 0);
    const searchPattern = searchTerms.map(term => 
      `(?=.*${term})`
    ).join('');

    const novels = await Novel.find({
      $or: [
        // Match main title
        { title: { $regex: searchPattern, $options: 'i' } },
        // Match alternative titles if they exist
        { alternativeTitles: { $regex: searchPattern, $options: 'i' } }
      ]
    })
    .select('title illustration author status chapters alternativeTitles')
    .limit(10);

    res.json(novels);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get hot novels (most viewed in last 24 hours)
 * @route GET /api/novels/hot
 */
router.get('/hot', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get hot novels with optimized query
    const hotNovels = await Novel.aggregate([
      // Unwind daily views array
      { $unwind: '$views.daily' },
      // Match views from today
      {
        $match: {
          'views.daily.date': {
            $gte: today
          }
        }
      },
      // Sort by today's view count
      {
        $sort: {
          'views.daily.count': -1
        }
      },
      // Limit to top 5
      { $limit: 5 },
      // Project only needed fields
      {
        $project: {
          _id: 1,
          title: 1,
          illustration: 1,
          status: 1,
          updatedAt: 1
        }
      }
    ]);

    // Get latest chapters for each novel in parallel
    const novelsWithChapters = await Promise.all(
      hotNovels.map(async (novel) => {
        const chapters = await Chapter.find({ novelId: novel._id })
          .sort({ createdAt: -1 })
          .limit(1)
          .select('chapterNumber title createdAt')
          .lean();
        return {
          ...novel,
          chapters
        };
      })
    );

    res.json(novelsWithChapters);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get all novels with pagination
 * @route GET /api/novels
 */
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Get total count and novels with optimized query
    const [total, novels] = await Promise.all([
      Novel.countDocuments(),
      Novel.find()
        .select('title illustration author status genres alternativeTitles updatedAt createdAt description')
        .lean()
    ]);

    // Get all latest chapters in a single query
    const latestChapters = await Chapter.aggregate([
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: '$novelId',
          chapters: {
            $push: {
              _id: '$_id',
              title: '$title',
              createdAt: '$createdAt'
            }
          }
        }
      },
      {
        $project: {
          chapters: { $slice: ['$chapters', 0, 3] }
        }
      }
    ]);

    // Create a map for quick chapter lookup
    const chaptersMap = latestChapters.reduce((acc, item) => {
      acc[item._id.toString()] = item.chapters;
      return acc;
    }, {});

    // Combine novel data with their chapters
    const novelsWithChapters = novels.map(novel => {
      const novelId = novel._id.toString();
      const moduleChapters = chaptersMap[novelId] || [];
      const novelChapters = novel.chapters || [];

      // Combine and sort all chapters
      const allChapters = [...moduleChapters, ...novelChapters]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 3);

      // Calculate latest activity
      const latestChapter = allChapters[0];
      const latestActivity = latestChapter
        ? Math.max(
            new Date(latestChapter.createdAt).getTime(),
            new Date(novel.updatedAt || novel.createdAt).getTime()
          )
        : new Date(novel.updatedAt || novel.createdAt).getTime();

      return {
        ...novel,
        latestActivity,
        chapters: allChapters
      };
    });

    // Sort novels by their latest activity time
    novelsWithChapters.sort((a, b) => b.latestActivity - a.latestActivity);

    // Apply pagination after sorting
    const paginatedNovels = novelsWithChapters.slice(skip, skip + limit);

    res.json({
      novels: paginatedNovels,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total
      }
    });
  } catch (err) {
    console.error('Error in GET /api/novels:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Create a new novel
 * @route POST /api/novels
 */
router.post('/', auth, async (req, res) => {
  try {
    const { title, author, description, illustration, genres, alternativeTitles, staff, note } = req.body;
    
    const novel = new Novel({
      title,
      author,
      description,
      illustration,
      genres: genres || [],
      alternativeTitles: alternativeTitles || [],
      staff,
      note,
      chapters: []
    });

    const newNovel = await novel.save();
    res.status(201).json(newNovel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Get single novel and increment view count
 * @route GET /api/novels/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }
    
    // Increment views
    await novel.incrementViews();
    
    res.json(novel);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Update a novel
 * @route PUT /api/novels/:id
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const { title, author, description, illustration, genres, alternativeTitles, status, staff, note } = req.body;
    
    const updateData = {
      ...(title && { title }),
      ...(author && { author }),
      ...(description && { description }),
      ...(illustration && { illustration }),
      ...(genres && { genres }),
      ...(alternativeTitles && { alternativeTitles }),
      ...(status && { status }),
      ...(staff && { staff }),
      ...(note !== undefined && { note })
    };

    const novel = await Novel.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    res.json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Delete a novel
 * @route DELETE /api/novels/:id
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const novel = await Novel.findByIdAndDelete(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }
    res.json({ message: 'Novel deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get a specific chapter of a novel
 * @route GET /api/novels/:id/chapters/:chapterId
 */
router.get('/:id/chapters/:chapterId', async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    const chapter = novel.chapters.find(ch => ch._id.toString() === req.params.chapterId);
    if (!chapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    res.json(chapter);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Add a new chapter to a novel
 * @route POST /api/novels/:id/chapters
 */
router.post('/:id/chapters', auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    const { title, content } = req.body;
    
    const newChapter = {
      title,
      content,
      createdAt: new Date()
    };

    novel.chapters.push(newChapter);
    novel.updatedAt = new Date();
    
    await novel.save();
    res.status(201).json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Update a chapter
 * @route PUT /api/novels/:id/chapters/:chapterId
 */
router.put('/:id/chapters/:chapterId', auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    const chapterIndex = novel.chapters.findIndex(
      ch => ch._id.toString() === req.params.chapterId
    );

    if (chapterIndex === -1) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    const { title, content } = req.body;
    novel.chapters[chapterIndex].title = title;
    novel.chapters[chapterIndex].content = content;
    novel.chapters[chapterIndex].updatedAt = new Date();

    await novel.save();
    res.json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * Delete a chapter
 * @route DELETE /api/novels/:id/chapters/:chapterId
 */
router.delete('/:id/chapters/:chapterId', auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    const chapterIndex = novel.chapters.findIndex(
      ch => ch._id.toString() === req.params.chapterId
    );

    if (chapterIndex === -1) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    novel.chapters.splice(chapterIndex, 1);
    await novel.save();
    res.json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router; 