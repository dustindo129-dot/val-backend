import express from "express";
import Novel from "../../models/Novel.js";
import { auth } from "../../middleware/auth.js";

const router = express.Router();

/**
 * Get a specific chapter of a novel
 * @route GET /api/novels/:id/chapters/:chapterId
 */
router.get("/:id/chapters/:chapterId", async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const chapter = novel.chapters.find(
      (ch) => ch._id.toString() === req.params.chapterId
    );
    if (!chapter) {
      return res.status(404).json({ message: "Chapter not found" });
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
router.post("/:id/chapters", auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const { title, content } = req.body;

    const newChapter = {
      title,
      content,
      createdAt: new Date(),
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
router.put("/:id/chapters/:chapterId", auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const chapterIndex = novel.chapters.findIndex(
      (ch) => ch._id.toString() === req.params.chapterId
    );

    if (chapterIndex === -1) {
      return res.status(404).json({ message: "Chapter not found" });
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
router.delete("/:id/chapters/:chapterId", auth, async (req, res) => {
  try {
    const novel = await Novel.findById(req.params.id);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    const chapterIndex = novel.chapters.findIndex(
      (ch) => ch._id.toString() === req.params.chapterId
    );

    if (chapterIndex === -1) {
      return res.status(404).json({ message: "Chapter not found" });
    }

    novel.chapters.splice(chapterIndex, 1);
    await novel.save();
    res.json(novel);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router; 