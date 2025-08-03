import express from 'express';
import Module from '../models/Module.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';
import Chapter from '../models/Chapter.js';
import { clearNovelCaches, notifyAllClients } from '../utils/cacheUtils.js';
import Novel from '../models/Novel.js';
import mongoose from 'mongoose';
import ModuleRental from '../models/ModuleRental.js';
import ContributionHistory from '../models/ContributionHistory.js';
import User from '../models/User.js';
import { createRentalTransactions } from './userTransaction.js';

/**
 * Calculate and update rentBalance for a module
 * rentBalance = (sum of all chapterBalance of paid chapters within that module) / 10
 * Auto-switches rent modules to published when total paid chapter balance ≤ 200
 * 
 * IMPORTANT: This function should ONLY be used when:
 * - Initially setting a module to 'rent' mode
 * - Adding paid chapters to a module
 * - Removing paid chapters from a module
 * - Moving paid chapters between modules
 * - Admin utility for recalculation
 * 
 * DO NOT use this function when chapters are unlocked (changed from 'paid' to 'published').
 * For that case, use checkAndSwitchRentModuleToPublished() instead.
 * 
 * @param {string} moduleId - The module ID
 * @param {object} session - MongoDB session (optional)
 * @returns {Promise<number>} The calculated rentBalance
 */
const calculateAndUpdateModuleRentBalance = async (moduleId, session = null) => {
  try {
    // Validate moduleId
    if (!moduleId || !mongoose.Types.ObjectId.isValid(moduleId)) {
      throw new Error(`Invalid module ID: ${moduleId}`);
    }

    // Convert moduleId to string if it's an ObjectId
    const moduleIdString = String(moduleId);

    // Get module info first to check current mode
    const module = await Module.findById(moduleIdString).session(session);
    if (!module) {
      console.warn(`Module ${moduleIdString} not found, skipping rentBalance calculation`);
      return 0;
    }

    // Create ObjectId for aggregation
    const moduleObjectId = mongoose.Types.ObjectId.createFromHexString(moduleIdString);

    // Get all paid chapters in this module using aggregation for better performance
    const paidChaptersResult = await Chapter.aggregate([
      {
        $match: {
          moduleId: moduleObjectId,
          mode: 'paid',
          chapterBalance: { $gt: 0 }
        }
      },
      {
        $group: {
          _id: null,
          totalBalance: { $sum: '$chapterBalance' },
          chapterCount: { $sum: 1 }
        }
      }
    ]).session(session);

    // Calculate total chapterBalance
    const totalChapterBalance = paidChaptersResult.length > 0 ? 
      (paidChaptersResult[0].totalBalance || 0) : 0;
    const chapterCount = paidChaptersResult.length > 0 ? 
      (paidChaptersResult[0].chapterCount || 0) : 0;

    // Calculate rentBalance = totalChapterBalance / 10 (rounded down)
    const calculatedRentBalance = Math.max(0, Math.floor(totalChapterBalance / 10));

    // Prepare update data
    const updateData = { 
      rentBalance: calculatedRentBalance,
      updatedAt: new Date()
    };

    // Auto-switch from rent to published if total paid chapter balance ≤ 200 OR ≤ current rentBalance
    if (module.mode === 'rent' && (totalChapterBalance <= 200 || totalChapterBalance <= module.rentBalance)) {
      updateData.mode = 'published';
      const reason = totalChapterBalance <= 200 ? 
        `total paid chapter balance: ${totalChapterBalance} ≤ 200 🌾` : 
        `total paid chapter balance: ${totalChapterBalance} ≤ current rentBalance: ${module.rentBalance} 🌾`;
    }

    // Update the module's rentBalance and potentially mode
    const updatedModule = await Module.findByIdAndUpdate(
      moduleIdString,
      updateData,
      { new: true, session }
    );

    if (!updatedModule) {
      throw new Error(`Failed to update module ${moduleIdString}`);
    }

    console.log(`Updated module ${moduleIdString} rentBalance: ${calculatedRentBalance} 🌾 (from ${chapterCount} paid chapters totaling ${totalChapterBalance} 🌾)${updateData.mode ? ` - Mode changed to: ${updateData.mode}` : ''}`);
    
    return calculatedRentBalance;
  } catch (error) {
    console.error(`Error calculating module rentBalance for ${moduleId}:`, error);
    throw error;
  }
};

/**
 * Check if a rent module should be auto-switched to published mode
 * This function checks if total paid chapter balance ≤ 200 OR ≤ current rentBalance and switches the module
 * WITHOUT recalculating the rentBalance (rentBalance should remain unchanged when chapters are unlocked)
 * @param {string} moduleId - The module ID
 * @param {object} session - MongoDB session (optional)
 * @returns {Promise<boolean>} Whether the module was switched to published mode
 */
const checkAndSwitchRentModuleToPublished = async (moduleId, session = null) => {
  try {
    // Validate moduleId
    if (!moduleId || !mongoose.Types.ObjectId.isValid(moduleId)) {
      throw new Error(`Invalid module ID: ${moduleId}`);
    }

    // Convert moduleId to string if it's an ObjectId
    const moduleIdString = String(moduleId);

    // Get module info first to check current mode
    const module = await Module.findById(moduleIdString).session(session);
    if (!module || module.mode !== 'rent') {
      // Only process rent modules
      return false;
    }

    // Create ObjectId for aggregation
    const moduleObjectId = mongoose.Types.ObjectId.createFromHexString(moduleIdString);

    // Get all paid chapters in this module to check total balance
    const paidChaptersResult = await Chapter.aggregate([
      {
        $match: {
          moduleId: moduleObjectId,
          mode: 'paid',
          chapterBalance: { $gt: 0 }
        }
      },
      {
        $group: {
          _id: null,
          totalBalance: { $sum: '$chapterBalance' }
        }
      }
    ]).session(session);

    // Calculate total chapterBalance
    const totalChapterBalance = paidChaptersResult.length > 0 ? 
      (paidChaptersResult[0].totalBalance || 0) : 0;

    // Auto-switch from rent to published if total paid chapter balance ≤ 200 OR ≤ current rentBalance
    if (totalChapterBalance <= 200 || totalChapterBalance <= module.rentBalance) {
      const updatedModule = await Module.findByIdAndUpdate(
        moduleIdString,
        { 
          mode: 'published',
          updatedAt: new Date()
        },
        { session, new: true }
      );
      
      const reason = totalChapterBalance <= 200 ? 
        `total paid chapter balance: ${totalChapterBalance} ≤ 200 🌾` : 
        `total paid chapter balance: ${totalChapterBalance} ≤ current rentBalance: ${module.rentBalance} 🌾`;
      console.log(`Auto-switched module ${moduleIdString} from rent to published mode (${reason})`);
      
      // Send real-time notification to clients about the mode change
      // Note: This is called within a transaction, so we'll send the notification after the transaction commits
      // For now, we'll return the module info so the caller can send the notification
      return { switched: true, module: updatedModule };
    }

    return { switched: false };
  } catch (error) {
    console.error(`Error checking rent module ${moduleId} for auto-switching:`, error);
    throw error;
  }
};

/**
 * Conditionally recalculate rent balance for a module based on its recalculateRentOnUnlock setting
 * This function should be called when chapters are unlocked via contribution
 * @param {string} moduleId - The module ID
 * @param {object} session - MongoDB session (optional)
 * @returns {Promise<number>} The calculated rentBalance (0 if not recalculated)
 */
const conditionallyRecalculateRentBalance = async (moduleId, session = null) => {
  try {
    // Validate moduleId
    if (!moduleId || !mongoose.Types.ObjectId.isValid(moduleId)) {
      throw new Error(`Invalid module ID: ${moduleId}`);
    }

    // Convert moduleId to string if it's an ObjectId
    const moduleIdString = String(moduleId);

    // Get module info first to check settings
    const module = await Module.findById(moduleIdString).session(session);
    if (!module) {
      console.warn(`Module ${moduleIdString} not found, skipping rent balance recalculation`);
      return 0;
    }

    // Only recalculate if module is in rent mode and has the recalculateRentOnUnlock flag enabled
    if (module.mode === 'rent' && module.recalculateRentOnUnlock) {
      console.log(`Recalculating rent balance for module ${moduleIdString} due to chapter unlock (recalculateRentOnUnlock enabled)`);
      return await calculateAndUpdateModuleRentBalance(moduleIdString, session);
    }

    // If not in rent mode or flag is disabled, still check for auto-switching to published
    if (module.mode === 'rent') {
      const switchResult = await checkAndSwitchRentModuleToPublished(moduleIdString, session);
      if (switchResult.switched) {
        console.log(`Module ${moduleIdString} switched to published mode due to chapter unlock`);
      }
    }

    return 0;
  } catch (error) {
    console.error(`Error conditionally recalculating rent balance for module ${moduleId}:`, error);
    throw error;
  }
};

/**
 * Export the new functions so they can be used by other route files
 */
export { calculateAndUpdateModuleRentBalance, checkAndSwitchRentModuleToPublished, conditionallyRecalculateRentBalance };

const router = express.Router();

// Query deduplication cache to prevent multiple identical requests
const pendingQueries = new Map();

// Cache for cleanup operations to avoid running them too frequently
let lastCleanupTime = 0;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const BACKGROUND_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes for background cleanup

/**
 * Runs cleanup if enough time has passed since last cleanup
 */
const runCleanupIfNeeded = async () => {
  const now = Date.now();
  if (now - lastCleanupTime > CLEANUP_INTERVAL) {
    try {
      const result = await ModuleRental.cleanupExpiredRentals();
      lastCleanupTime = now;
      if (result.modifiedCount > 0) {
        console.log(`Cleaned up ${result.modifiedCount} expired rentals`);
      }
    } catch (error) {
      console.error('Error during rental cleanup:', error);
    }
  }
};

/**
 * Starts background rental cleanup process
 * This ensures rentals are cleaned up regularly even without API calls
 */
const startBackgroundCleanup = () => {
  // Run initial cleanup after 1 minute
  setTimeout(async () => {
    console.log('Starting initial rental cleanup...');
    await runCleanupIfNeeded();
  }, 60000);

  // Then run cleanup every 30 minutes
  setInterval(async () => {
    console.log('Running scheduled rental cleanup...');
    await runCleanupIfNeeded();
  }, BACKGROUND_CLEANUP_INTERVAL);
  
  console.log(`Background rental cleanup started (interval: ${BACKGROUND_CLEANUP_INTERVAL / 60000} minutes)`);
};

// Start background cleanup when module loads
startBackgroundCleanup();

/**
 * Search modules with novel information
 * @route GET /api/modules/search
 */
router.get('/search', auth, async (req, res) => {
  try {
    const { query, limit = 5 } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.json([]);
    }
    
    // Split query into individual keywords for flexible matching
    const keywords = query.trim().toLowerCase().split(/\s+/);
    
    // Search modules and populate novel information
    const modules = await Module.aggregate([
      {
        $lookup: {
          from: 'novels',
          localField: 'novelId',
          foreignField: '_id',
          as: 'novel'
        }
      },
      {
        $unwind: '$novel'
      },
      {
        $addFields: {
          // Create search fields
          novelTitleLower: { $toLower: '$novel.title' },
          moduleTitleLower: { $toLower: '$title' },
          combinedText: {
            $toLower: {
              $concat: ['$novel.title', ' - ', '$title']
            }
          }
        }
      },
      {
        $match: {
          // More flexible matching: if the combined text contains all keywords, it's a match
          $expr: {
            $allElementsTrue: {
              $map: {
                input: keywords,
                as: 'keyword',
                in: {
                  $regexMatch: {
                    input: '$combinedText',
                    regex: '$$keyword',
                    options: 'i'
                  }
                }
              }
            }
          }
        }
      },
      {
        $addFields: {
          // Calculate relevance score based on keyword matches
          relevanceScore: {
            $add: [
              // Score for novel title matches
              {
                $multiply: [
                  {
                    $size: {
                      $filter: {
                        input: keywords,
                        as: 'keyword',
                        cond: {
                          $regexMatch: {
                            input: '$novelTitleLower',
                            regex: '$$keyword',
                            options: 'i'
                          }
                        }
                      }
                    }
                  },
                  3 // Novel title matches get 3x weight
                ]
              },
              // Score for module title matches
              {
                $multiply: [
                  {
                    $size: {
                      $filter: {
                        input: keywords,
                        as: 'keyword',
                        cond: {
                          $regexMatch: {
                            input: '$moduleTitleLower',
                            regex: '$$keyword',
                            options: 'i'
                          }
                        }
                      }
                    }
                  },
                  2 // Module title matches get 2x weight
                ]
              },
              1 // Base score for any match
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          title: 1,
          illustration: 1,
          order: 1,
          mode: 1,
          moduleBalance: 1,
          novelId: 1,
          'novel.title': 1,
          'novel.illustration': 1,
          relevanceScore: 1
        }
      },
      {
        $sort: {
          relevanceScore: -1,
          'novel.title': 1,
          order: 1
        }
      },
      {
        $limit: parseInt(limit)
      }
    ]);
    
    // If no results from aggregation, try fallback search
    if (modules.length === 0) {
      // Get all modules and populate novels
      const allModulesWithNovels = await Module.find({})
        .populate('novelId', 'title illustration')
        .lean()
        .limit(100); // Limit to prevent memory issues
      
      // Filter modules manually with enhanced matching
      const matchingModules = allModulesWithNovels.filter(module => {
        if (!module.novelId) return false;
        
        const combinedText = `${module.novelId.title} - ${module.title}`.toLowerCase();
        
        // Check if all keywords are present in combined text
        const keywordResults = keywords.map(keyword => {
          // Normalize the text by replacing various dash types with regular spaces
          const normalizedText = combinedText
            .replace(/[–—−]/g, ' ') // Replace em dash, en dash, minus with space
            .replace(/\s+/g, ' ')   // Replace multiple spaces with single space
            .trim();
          
          // Normalize both text and keyword for Vietnamese characters
          const normalizeVietnamese = (text) => {
            return text
              .normalize('NFD') // Decompose characters
              .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
              .normalize('NFC') // Recompose
              .toLowerCase();
          };
          
          // Try multiple matching strategies
          const strategies = [
            // Strategy 1: Direct match
            () => normalizedText.includes(keyword.toLowerCase()),
            
            // Strategy 2: Unicode normalized match
            () => normalizeVietnamese(normalizedText).includes(normalizeVietnamese(keyword)),
            
            // Strategy 3: Vietnamese character tolerant
            () => {
              if (keyword.toLowerCase() === 'tập' || keyword.toLowerCase() === 'tap') {
                return normalizedText.includes('tập') || normalizedText.includes('tap');
              }
              return false;
            }
          ];
          
          return strategies.some(strategy => strategy());
        });
        
        return keywordResults.every(result => result);
      });

      // Sort by relevance and return top results
      const sortedModules = matchingModules
        .map(module => ({
          _id: module._id,
          title: module.title,
          illustration: module.illustration,
          order: module.order,
          mode: module.mode,
          moduleBalance: module.moduleBalance,
          novelId: module.novelId._id,
          novel: {
            title: module.novelId.title,
            illustration: module.novelId.illustration
          }
        }))
        .slice(0, parseInt(limit));

      // Format the response
      const formattedModules = sortedModules.map(module => ({
        _id: module._id,
        title: module.title,
        illustration: module.illustration,
        order: module.order,
        mode: module.mode,
        moduleBalance: module.moduleBalance,
        novelId: module.novelId,
        novel: module.novel
      }));

      return res.json(formattedModules);
    }
    
    // Format the response
    const formattedModules = modules.map(module => ({
      _id: module._id,
      title: module.title,
      illustration: module.illustration,
      order: module.order,
      mode: module.mode,
      moduleBalance: module.moduleBalance,
      novelId: module.novelId,
      novel: {
        title: module.novel.title,
        illustration: module.novel.illustration
      }
    }));
    
    res.json(formattedModules);
  } catch (error) {
    console.error('Module search error:', error);
    res.status(500).json({ message: 'Failed to search modules' });
  }
});

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
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Check if user has permission (admin, moderator, or pj_user managing this novel)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      // For pj_user, check if they manage this novel
      if (req.user.role === 'pj_user') {
        const novel = await Novel.findById(req.params.novelId).lean();
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
  try {
    // Check if user has permission (admin, moderator, or pj_user managing this novel)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      // For pj_user, check if they manage this novel
      if (req.user.role === 'pj_user') {
        const novel = await Novel.findById(req.params.novelId).lean();
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
      moduleBalance: req.body.mode === 'paid' ? (parseInt(req.body.moduleBalance) || 0) : 0,
      recalculateRentOnUnlock: req.body.mode === 'rent' ? (req.body.recalculateRentOnUnlock || false) : false,
      rentBalance: 0 // Will be calculated automatically based on paid chapters
    });

    // Save the module
    const newModule = await module.save();
    
    // Only increment view count, don't update timestamp to avoid affecting latest updates
    await Novel.findByIdAndUpdate(
      req.params.novelId,
      { 
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
  try {
    // Check if user has permission (admin, moderator, or pj_user managing this novel)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      // For pj_user, check if they manage this novel
      if (req.user.role === 'pj_user') {
        const novel = await Novel.findById(req.params.novelId).lean();
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
      recalculateRentOnUnlock: req.body.mode === 'rent' ? (req.body.recalculateRentOnUnlock || false) : false,
      // rentBalance is calculated automatically, not set manually
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
    
    // Clear novel caches to ensure fresh data on next request
    clearNovelCaches();

    // Send real-time notification if module mode changed
    if (currentModule.mode !== req.body.mode) {
      notifyAllClients('module_mode_changed', { 
        novelId: req.params.novelId, 
        moduleId: req.params.moduleId,
        moduleTitle: updatedModule.title,
        oldMode: currentModule.mode,
        newMode: req.body.mode,
        reason: 'manual_update'
      });
      console.log(`Module mode changed manually: ${updatedModule.title} from ${currentModule.mode} to ${req.body.mode}`);
    }

    // Check for auto-unlock if module was changed to paid mode
    if (req.body.mode === 'paid' && currentModule.mode !== 'paid') {
      // Import the checkAndUnlockContent function from novels.js
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(req.params.novelId);
    }
    
    // Recalculate rent balance if module was changed to rent mode
    if (req.body.mode === 'rent' && currentModule.mode !== 'rent') {
      try {
        await calculateAndUpdateModuleRentBalance(req.params.moduleId);
        console.log(`Recalculated rent balance for module ${req.params.moduleId} after switching to rent mode`);
      } catch (rentBalanceError) {
        console.error('Error recalculating module rent balance after mode change to rent:', rentBalanceError);
        // Don't fail the module update if rent balance calculation fails
      }
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
    
    // Only increment view count if needed (no timestamp update for administrative actions)
    await Novel.findByIdAndUpdate(
      req.params.novelId,
      { 
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

    // Get chapter info to check if it's paid
    const chapter = await Chapter.findById(req.params.chapterId);
    const oldModuleId = chapter ? chapter.moduleId : null;

    // Update chapter's moduleId
    await Chapter.findByIdAndUpdate(req.params.chapterId, {
      moduleId: req.params.moduleId
    });

    // Recalculate rent balance for both modules if chapter is paid
    if (chapter && chapter.mode === 'paid' && chapter.chapterBalance > 0) {
      await Promise.all([
        // Recalculate for new module
        calculateAndUpdateModuleRentBalance(req.params.moduleId),
        // Recalculate for old module if it exists and is different
        oldModuleId && oldModuleId.toString() !== req.params.moduleId ? 
          calculateAndUpdateModuleRentBalance(oldModuleId) : Promise.resolve()
      ]);
    }

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

    // Get chapter info to check if it's paid before removing
    const chapter = await Chapter.findById(req.params.chapterId);
    const wasPaidChapter = chapter && chapter.mode === 'paid' && chapter.chapterBalance > 0;

    module.chapters = module.chapters.filter(
      chapter => chapter.toString() !== req.params.chapterId
    );
    const updatedModule = await module.save();
    
    // Recalculate rent balance if removed chapter was paid
    if (wasPaidChapter) {
      await calculateAndUpdateModuleRentBalance(req.params.moduleId);
    }
    
    // Clear novel caches to ensure fresh data on next request
    clearNovelCaches();
    
    res.json(updatedModule);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Reorder chapters within a module
router.put('/:novelId/modules/:moduleId/chapters/:chapterId/reorder', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Check if user has permission (admin, moderator, or pj_user managing this novel)
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      // For pj_user, check if they manage this novel
      if (req.user.role === 'pj_user') {
        const novel = await Novel.findById(req.params.novelId).lean();
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

    const { direction } = req.body;
    const { novelId, moduleId, chapterId } = req.params;
    const skipUpdateTimestamp = req.query.skipUpdateTimestamp === 'true';

    // Get the chapter to move (only fetch necessary fields)
    const chapterToMove = await Chapter.findById(chapterId, { order: 1, _id: 1 }).session(session);
    
    if (!chapterToMove) {
      throw new Error('Chapter not found');
    }

    // Find the adjacent chapter based on direction using targeted queries
    const isMovingUp = direction === 'up';
    const adjacentChapterQuery = {
      moduleId: moduleId,
      order: isMovingUp 
        ? { $lt: chapterToMove.order } // Find chapter with order less than current (moving up)
        : { $gt: chapterToMove.order }  // Find chapter with order greater than current (moving down)
    };
    
    // Get the target chapter (closest by order)
    const otherChapter = await Chapter.findOne(
      adjacentChapterQuery, 
      { order: 1, _id: 1 }
    )
    .sort({ order: isMovingUp ? -1 : 1 }) // Sort descending for up, ascending for down
    .session(session);
    
    if (!otherChapter) {
      throw new Error('Cannot move chapter further in that direction');
    }

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

    // Note: Module chapters array doesn't need reordering since order is determined by chapter.order field
    // The array is just a reference list, not positional. Skip expensive array rebuild.

    // Chapter reordering is an administrative action - don't update novel timestamp
    // (Novel timestamp should only be updated for new content, not reorganization)

    // Commit the transaction
    await session.commitTransaction();
    
    // Clear novel caches
    clearNovelCaches();

    // Return lightweight response with just the swapped chapters
    res.json({
      message: 'Chapters reordered successfully',
      swappedChapters: [
        { _id: chapterToMove._id, order: targetOrder },
        { _id: otherChapter._id, order: originalOrder }
      ]
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Backend - Error during chapter reorder:', err);
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

/**
 * Update module rent balance (Admin only)
 * @route PATCH /api/modules/:moduleId/rent-balance
 */
router.patch('/:moduleId/rent-balance', auth, admin, async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { rentBalance } = req.body;

    // Validate rent balance
    if (typeof rentBalance !== 'number' || rentBalance < 0) {
      return res.status(400).json({ message: 'Giá mở tạm thời phải là số không âm' });
    }

    const module = await Module.findByIdAndUpdate(
      moduleId,
      { rentBalance },
      { new: true, runValidators: true }
    );

    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Clear novel caches
    clearNovelCaches();

    res.json({ 
      message: 'Rent balance updated successfully',
      module: {
        _id: module._id,
        rentBalance: module.rentBalance
      }
    });
  } catch (err) {
    console.error('Error updating module rent balance:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Rent a module for 1 week
 * @route POST /api/modules/:moduleId/rent
 */
router.post('/:moduleId/rent', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { moduleId } = req.params;
    const userId = req.user._id;

    // Get module with novel information
    const module = await Module.findById(moduleId)
      .populate('novelId', 'novelBalance novelBudget')
      .session(session);

    if (!module) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Check if module is in rent mode (module-level rental control)
    if (module.mode !== 'rent') {
      return res.status(400).json({ message: 'Module is not available for rent' });
    }

    // Check if module has paid content (either paid mode or has paid chapters)
    const hasPaidChapters = await Chapter.exists({
      moduleId: moduleId,
      mode: 'paid',
      chapterBalance: { $gt: 0 }
    }).session(session);

    const isPaidModule = module.mode === 'paid' && module.moduleBalance > 0;

    if (!isPaidModule && !hasPaidChapters) {
      return res.status(400).json({ message: 'Module does not have paid content available for rent' });
    }

    // Check if module has rent balance set
    if (!module.rentBalance || module.rentBalance <= 0) {
      return res.status(400).json({ message: 'Module rent price not set' });
    }

    // Check if user already has an active rental for this module
    const existingRental = await ModuleRental.findActiveRentalForUserModule(userId, moduleId);
    if (existingRental) {
      return res.status(400).json({ 
        message: 'Bạn đã mở tạm thời tập này rồi',
        rental: {
          endTime: existingRental.endTime,
          timeRemaining: Math.max(0, existingRental.endTime - new Date())
        }
      });
    }

    // Get user and check balance
    const user = await User.findById(userId).session(session);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.balance < module.rentBalance) {
      return res.status(400).json({ 
        message: `Số dư không đủ. Cần ${module.rentBalance} 🌾, bạn có ${user.balance} 🌾` 
      });
    }

    // Deduct from user balance
    user.balance -= module.rentBalance;
    await user.save({ session });

    // Add to novel balance and budget
    const novel = module.novelId;
    novel.novelBalance += module.rentBalance;
    novel.novelBudget += module.rentBalance;
    await novel.save({ session });

    // Create rental record with explicit endTime (1 week from now)
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + (7 * 24 * 60 * 60 * 1000)); // 1 week from start
    
    const rental = new ModuleRental({
      userId: userId,
      moduleId: moduleId,
      novelId: novel._id,
      amountPaid: module.rentBalance,
      startTime: startTime,
      endTime: endTime
    });
    await rental.save({ session });

    // Create contribution history record
    const contributionHistory = new ContributionHistory({
      novelId: novel._id,
      userId: userId,
      amount: module.rentBalance,
      note: `Mở tạm thời ${module.title} trong 1 tuần`,
      budgetAfter: novel.novelBudget,
      balanceAfter: novel.novelBalance,
      type: 'user'
    });
    await contributionHistory.save({ session });

    // Link contribution history to rental
    rental.contributionHistoryId = contributionHistory._id;
    await rental.save({ session });

    // Create both user and novel transaction records for the rental
    await createRentalTransactions({
      userId: userId,
      novelId: novel._id,
      moduleTitle: module.title,
      rentalAmount: module.rentBalance,
      userBalanceAfter: user.balance,
      novelBalanceAfter: novel.novelBalance,
      rentalId: rental._id,
      username: user.displayName || user.username
    }, session);

    await session.commitTransaction();

    // Clear novel caches
    clearNovelCaches();

    // Check for auto-unlock since rental increases novelBudget
    try {
      const { checkAndUnlockContent } = await import('./novels.js');
      await checkAndUnlockContent(novel._id);
    } catch (unlockError) {
      console.error('Error checking auto-unlock after rental:', unlockError);
      // Don't fail the rental if auto-unlock check fails
    }

    res.json({
      message: 'Module rented successfully',
      rental: {
        _id: rental._id,
        moduleId: rental.moduleId,
        amountPaid: rental.amountPaid,
        startTime: rental.startTime,
        endTime: rental.endTime,
        timeRemaining: rental.endTime - new Date()
      },
      userBalance: user.balance
    });

  } catch (err) {
    await session.abortTransaction();
    console.error('Error renting module:', err);
    
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Bạn đã mở tạm thời tập này rồi' });
    }
    
    res.status(500).json({ message: err.message });
  } finally {
    session.endSession();
  }
});

/**
 * Get user's active rentals
 * @route GET /api/modules/rentals/active
 */
router.get('/rentals/active', auth, async (req, res) => {
  try {
    const userId = req.user._id;

    // Cleanup expired rentals if needed (cached to avoid frequent calls)
    await runCleanupIfNeeded();

    const rentals = await ModuleRental.findActiveRentalsForUser(userId)
      .populate('moduleId', 'title illustration rentBalance')
      .populate('novelId', 'title')
      .sort({ startTime: -1 });

    // Calculate time remaining for each rental
    const rentalsWithTimeRemaining = rentals.map(rental => ({
      _id: rental._id,
      module: rental.moduleId,
      novel: rental.novelId,
      amountPaid: rental.amountPaid,
      startTime: rental.startTime,
      endTime: rental.endTime,
      timeRemaining: Math.max(0, rental.endTime - new Date()),
      isValid: rental.isValid()
    }));

    res.json(rentalsWithTimeRemaining);
  } catch (err) {
    console.error('Error getting user rentals:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Check if user has active rental for a specific module
 * @route GET /api/modules/:moduleId/rental-status
 */
router.get('/:moduleId/rental-status', auth, async (req, res) => {
  try {
    const { moduleId } = req.params;
    const userId = req.user._id;

    const rental = await ModuleRental.findActiveRentalForUserModule(userId, moduleId);

    if (!rental) {
      return res.json({ hasActiveRental: false });
    }

    // Check if rental is still valid
    if (!rental.isValid()) {
      // Expire the rental
      await rental.expire();
      return res.json({ hasActiveRental: false });
    }

    res.json({
      hasActiveRental: true,
      rental: {
        _id: rental._id,
        startTime: rental.startTime,
        endTime: rental.endTime,
        timeRemaining: Math.max(0, rental.endTime - new Date()),
        amountPaid: rental.amountPaid
      }
    });
  } catch (err) {
    console.error('Error checking rental status:', err);
    res.status(500).json({ message: err.message });
  }
});



/**
 * Cleanup expired rentals (utility endpoint, can be called by cron jobs)
 * @route POST /api/modules/rentals/cleanup
 */
router.post('/rentals/cleanup', auth, admin, async (req, res) => {
  try {
    const result = await ModuleRental.cleanupExpiredRentals();
    
    res.json({
      message: 'Expired rentals cleaned up successfully',
      modifiedCount: result.modifiedCount
    });
  } catch (err) {
    console.error('Error cleaning up expired rentals:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Force cleanup of expired rentals regardless of cache (for system maintenance)
 * @route POST /api/modules/rentals/force-cleanup
 */
router.post('/rentals/force-cleanup', auth, admin, async (req, res) => {
  try {
    // Reset cleanup timer to force immediate cleanup
    lastCleanupTime = 0;
    await runCleanupIfNeeded();
    
    // Get the actual cleanup result
    const result = await ModuleRental.cleanupExpiredRentals();
    
    res.json({
      message: 'Force cleanup completed successfully',
      modifiedCount: result.modifiedCount,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error during force cleanup:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get rental cleanup status and next cleanup time
 * @route GET /api/modules/rentals/cleanup-status
 */
router.get('/rentals/cleanup-status', auth, admin, async (req, res) => {
  try {
    const now = Date.now();
    const timeSinceLastCleanup = now - lastCleanupTime;
    const timeUntilNextCleanup = Math.max(0, CLEANUP_INTERVAL - timeSinceLastCleanup);
    
    res.json({
      lastCleanupTime: lastCleanupTime ? new Date(lastCleanupTime).toISOString() : null,
      timeSinceLastCleanup: timeSinceLastCleanup,
      timeUntilNextCleanup: timeUntilNextCleanup,
      cleanupInterval: CLEANUP_INTERVAL,
      nextCleanupIn: Math.ceil(timeUntilNextCleanup / 60000) + ' minutes'
    });
  } catch (err) {
    console.error('Error getting cleanup status:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Recalculate rent balance for all modules (Admin utility endpoint)
 * @route POST /api/modules/recalculate-rent-balance
 */
router.post('/recalculate-rent-balance', auth, admin, async (req, res) => {
  try {
    // Get all modules
    const modules = await Module.find({}).select('_id title');
    
    let updatedCount = 0;
    const errors = [];
    
    // Process modules in batches to avoid overwhelming the database
    const batchSize = 10;
    for (let i = 0; i < modules.length; i += batchSize) {
      const batch = modules.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (module) => {
        try {
          await calculateAndUpdateModuleRentBalance(module._id);
          updatedCount++;
        } catch (error) {
          console.error(`Error updating module ${module._id}:`, error);
          errors.push({
            moduleId: module._id,
            title: module.title,
            error: error.message
          });
        }
      }));
    }
    
    res.json({
      message: 'Rent balance recalculation completed',
      totalModules: modules.length,
      updatedCount: updatedCount,
      errorCount: errors.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    console.error('Error recalculating all module rent balances:', err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * Get rental counts for rent-mode modules in a novel (admin/moderator/pj_user only)
 * 
 * Optimizations:
 * - Only queries modules in 'rent' mode to reduce database load
 * - Runs rental cleanup before fetching counts to ensure accuracy
 * - Returns empty object immediately if no rent-mode modules exist
 * 
 * @route GET /api/modules/:novelId/rental-counts
 */
router.get('/:novelId/rental-counts', auth, async (req, res) => {
  try {
    const { novelId } = req.params;
    const user = req.user;

    // Validate novelId
    if (!mongoose.Types.ObjectId.isValid(novelId)) {
      return res.status(400).json({ message: 'Invalid novel ID' });
    }

    // Get the novel to check permissions
    const novel = await Novel.findById(novelId);
    if (!novel) {
      return res.status(404).json({ message: 'Novel not found' });
    }

    // Helper function to check if user has pj_user access
    const checkPjUserAccess = (pjUserArray, user) => {
      if (!pjUserArray || !Array.isArray(pjUserArray) || !user) return false;
      
      return pjUserArray.some(pjUser => {
        // Handle case where pjUser is an object (new format)
        if (typeof pjUser === 'object' && pjUser !== null) {
          return (
            pjUser._id === user.id ||
            pjUser._id === user._id ||
            pjUser.username === user.username ||
            pjUser.displayName === user.displayName ||
            pjUser.userNumber === user.userNumber
          );
        }
        // Handle case where pjUser is a primitive value (old format)
        return (
          pjUser === user.id ||
          pjUser === user._id ||
          pjUser === user.username ||
          pjUser === user.displayName ||
          pjUser === user.userNumber
        );
      });
    };

    // Check permissions: admin, moderator, or pj_user for this novel
    const canSeeRentalStats = user && (
      user.role === 'admin' || 
      user.role === 'moderator' || 
      (user.role === 'pj_user' && checkPjUserAccess(novel.active?.pj_user, user))
    );

    if (!canSeeRentalStats) {
      return res.status(403).json({ message: 'Not authorized to view rental statistics' });
    }

    // Cleanup expired rentals if needed (cached to avoid frequent calls)
    await runCleanupIfNeeded();

    // Only get modules that are in 'rent' mode for this novel
    const rentModeModules = await Module.find({ 
      novelId, 
      mode: 'rent' 
    }).select('_id');
    
    // If no modules in rent mode, return empty object immediately
    if (rentModeModules.length === 0) {
      return res.json({});
    }
    
    const rentModeModuleIds = rentModeModules.map(m => m._id);

    // Get active rental counts only for rent-mode modules
    const rentalCounts = {};
    
    const rentalStats = await ModuleRental.aggregate([
      {
        $match: {
          moduleId: { $in: rentModeModuleIds },
          isActive: true,
          endTime: { $gt: new Date() }
        }
      },
      {
        $group: {
          _id: '$moduleId',
          count: { $sum: 1 }
        }
      }
    ]);

    // Convert to object with moduleId as key
    rentalStats.forEach(stat => {
      rentalCounts[stat._id.toString()] = stat.count;
    });

    res.json(rentalCounts);
  } catch (error) {
    console.error('Error fetching rental counts:', error);
    res.status(500).json({ message: 'Failed to fetch rental counts' });
  }
});

export default router;