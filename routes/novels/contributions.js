import express from "express";
import Novel from "../../models/Novel.js";
import { auth } from "../../middleware/auth.js";
import Module from "../../models/Module.js";
import Chapter from "../../models/Chapter.js";
import { notifyAllClients } from '../../utils/cacheUtils.js';
import Request from '../../models/Request.js';
import Contribution from '../../models/Contribution.js';
import { createNovelTransaction } from '../novelTransactions.js';
import ContributionHistory from '../../models/ContributionHistory.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Auto-unlock content based on novel budget
 * This function checks if any paid modules/chapters can be unlocked in sequential order
 * It stops at the first paid content that cannot be afforded
 */
export async function checkAndUnlockContent(novelId) {
  try {
    const novel = await Novel.findById(novelId);
    if (!novel || novel.novelBudget <= 0) return;

    // Get all modules for this novel, sorted by order
    const modules = await Module.find({ novelId })
      .sort({ order: 1 })
      .lean();

    let remainingBudget = novel.novelBudget;
    let unlocked = false;

    for (const module of modules) {
      // If module is paid, try to unlock it first
      if (module.mode === 'paid') {
        if (remainingBudget >= module.moduleBalance) {
          // Unlock the module by changing mode to published
          await Module.findByIdAndUpdate(module._id, { mode: 'published' });
          remainingBudget -= module.moduleBalance;
          unlocked = true;

          // Create system contribution record
          await ContributionHistory.create({
            novelId,
            userId: null, // System action
            amount: -module.moduleBalance,
            note: `Mở khóa tự động: ${module.title}`,
            budgetAfter: remainingBudget,
            type: 'system'
          });

          // Notify clients
          notifyAllClients('module_unlocked', { 
            novelId, 
            moduleId: module._id,
            moduleTitle: module.title 
          });

          // Continue to check chapters in this now-unlocked module
        } else {
          // Cannot afford this module, stop here (sequential unlock)
          break;
        }
      }

      // If module is published (free or just unlocked), check its chapters in order
      if (module.mode === 'published') {
        // Get chapters for this module, sorted by order
        const chapters = await Chapter.find({ moduleId: module._id })
          .sort({ order: 1 })
          .lean();

        for (const chapter of chapters) {
          // If chapter is paid, try to unlock it
          if (chapter.mode === 'paid') {
            if (remainingBudget >= chapter.chapterBalance) {
              // Unlock the chapter by changing mode to published
              await Chapter.findByIdAndUpdate(chapter._id, { mode: 'published' });
              remainingBudget -= chapter.chapterBalance;
              unlocked = true;

              // Create system contribution record
              await ContributionHistory.create({
                novelId,
                userId: null, // System action
                amount: -chapter.chapterBalance,
                note: `Mở khóa tự động: ${chapter.title}`,
                budgetAfter: remainingBudget,
                type: 'system'
              });

              // Notify clients
              notifyAllClients('chapter_unlocked', { 
                novelId, 
                moduleId: module._id,
                chapterId: chapter._id,
                chapterTitle: chapter.title 
              });
            } else {
              // Cannot afford this chapter, stop here (sequential unlock)
              // This means we cannot proceed to the next module either
              return await Novel.findByIdAndUpdate(novelId, { novelBudget: remainingBudget });
            }
          }
          // If chapter is already published, continue to next chapter
        }
      }
    }

    // Update novel budget if anything was unlocked
    if (unlocked) {
      await Novel.findByIdAndUpdate(novelId, { novelBudget: remainingBudget });
    }

  } catch (error) {
    console.error('Error in auto-unlock:', error);
  }
}

// Add this route to get approved contributions and requests for a novel
router.get('/:novelId/contributions', async (req, res) => {
  try {
    const novelId = req.params.novelId;
    
    // Find the novel
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }
    
    // PART 1: Find approved contributions for open and web requests
    // Find requests for this novel (open and web types)
    const openWebRequests = await Request.find({ 
      novel: novelId, 
      type: { $in: ['open', 'web'] }
    })
    .select('_id')
    .lean();
    
    let contributions = [];
    if (openWebRequests && openWebRequests.length > 0) {
      // Get request IDs
      const requestIds = openWebRequests.map(req => req._id);
      
      // Find approved contributions for these requests
      contributions = await Contribution.find({ 
        request: { $in: requestIds },
        status: 'approved'
      })
      .populate('user', 'username avatar')
      .populate('request', 'type title')
      .sort({ updatedAt: -1 })
      .lean();
    }
    
    // PART 2: Find approved 'new' requests for this novel
    const approvedNewRequests = await Request.find({ 
      novel: novelId, 
      type: 'new',
      status: 'approved'
    })
    .populate('user', 'username avatar')
    .lean();
    
    // Handle 'new' request deposits as contributions
    const newRequestDeposits = approvedNewRequests.map(request => ({
      _id: request._id + '_deposit', // Create unique ID
      user: request.user,
      amount: request.deposit,
      status: 'approved',
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      request: {
        _id: request._id,
        type: 'new',
        title: 'Yêu cầu truyện mới'
      },
      note: 'Tiền cọc yêu cầu truyện mới',
      isDeposit: true
    }));
    
    // Find approved contributions for all 'new' requests
    let newRequestContributions = [];
    if (approvedNewRequests.length > 0) {
      const newRequestIds = approvedNewRequests.map(req => req._id);
      
      newRequestContributions = await Contribution.find({ 
        request: { $in: newRequestIds },
        status: 'approved'
      })
      .populate('user', 'username avatar')
      .populate('request', 'type title')
      .lean();
    }
    
    // PART 3: Find approved open requests for this novel with module/chapter info
    const approvedOpenRequests = await Request.find({ 
      novel: novelId, 
      type: 'open',
      status: 'approved'
    })
    .populate('user', 'username avatar')
    .populate('module', 'title')
    .populate('chapter', 'title')
    .sort({ updatedAt: -1 })
    .lean();
    
    // Combine all contributions
    const allContributions = [
      ...contributions,
      ...newRequestContributions,
      ...newRequestDeposits
    ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    // Return all data
    return res.json({ 
      contributions: allContributions,
      requests: approvedOpenRequests
    });
  } catch (error) {
    console.error('Error fetching novel contributions:', error);
    return res.status(500).json({ message: 'Failed to fetch contributions' });
  }
});

/**
 * Contribute to novel budget
 * @route POST /api/novels/:id/contribute
 */
router.post("/:id/contribute", auth, async (req, res) => {
  try {
    const novelId = req.params.id;
    const userId = req.user._id;
    const { amount, note } = req.body;

    // Validate amount
    if (!amount || amount < 10) {
      return res.status(400).json({ message: "Số lượng đóng góp tối thiểu là 10 🌾" });
    }

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Check user balance
    const User = mongoose.model('User');
    const user = await User.findById(userId);
    if (!user || user.balance < amount) {
      return res.status(400).json({ message: "Số dư không đủ để thực hiện đóng góp này" });
    }

    // Start transaction
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Deduct from user balance
      await User.findByIdAndUpdate(userId, {
        $inc: { balance: -amount }
      }, { session });

      // Add to novel budget and balance
      const updatedNovel = await Novel.findByIdAndUpdate(novelId, {
        $inc: { 
          novelBudget: amount,
          novelBalance: amount 
        }
      }, { session, new: true });

      // Create contribution record
      await ContributionHistory.create([{
        novelId,
        userId,
        amount,
        note: note || 'Đóng góp cho truyện',
        budgetAfter: updatedNovel.novelBudget,
        type: 'user'
      }], { session });

      // Create novel transaction record
      await createNovelTransaction({
        novel: novelId,
        amount,
        type: 'contribution',
        description: note || 'Đóng góp cho truyện',
        balanceAfter: updatedNovel.novelBalance,
        performedBy: userId
      }, session);

      await session.commitTransaction();

      // Check for auto-unlock after contribution
      await checkAndUnlockContent(novelId);

      // Notify clients of the update
      notifyAllClients('novel_budget_updated', { 
        novelId, 
        newBudget: updatedNovel.novelBudget,
        newBalance: updatedNovel.novelBalance 
      });

      res.json({ 
        success: true, 
        novelBudget: updatedNovel.novelBudget,
        novelBalance: updatedNovel.novelBalance,
        message: "Đóng góp thành công!" 
      });

    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }

  } catch (err) {
    console.error("Error contributing to novel:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get contribution history for a novel
 * @route GET /api/novels/:id/contribution-history
 */
router.get("/:id/contribution-history", async (req, res) => {
  try {
    const novelId = req.params.id;

    // Check if novel exists
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: "Novel not found" });
    }

    // Find contribution history for this novel
    const contributions = await ContributionHistory.find({ novelId })
      .populate('userId', 'username avatar')
      .sort({ createdAt: -1 })
      .limit(50) // Limit to last 50 contributions
      .lean();

    // Format the response
    const formattedContributions = contributions.map(contribution => ({
      _id: contribution._id,
      user: contribution.userId,
      amount: contribution.amount,
      note: contribution.note,
      budgetAfter: contribution.budgetAfter,
      type: contribution.type,
      createdAt: contribution.createdAt,
      updatedAt: contribution.updatedAt
    }));

    res.json({ contributions: formattedContributions });

  } catch (err) {
    console.error("Error fetching contribution history:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router; 