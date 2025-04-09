import express from 'express';
import Report from '../models/Report.js';
import { auth, checkRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * @route POST /api/reports
 * @desc Submit a new report
 * @access Private
 */
router.post('/', auth, async (req, res) => {
  try {
    const { contentType, contentId, reportType, details, contentTitle, novelId } = req.body;
    
    // Validate required fields
    if (!contentType || !contentId || !reportType) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Create new report
    const report = new Report({
      reporter: req.user._id,
      contentType,
      contentId,
      reportType,
      details: details || '',
      contentTitle: contentTitle || 'Untitled Content',
      novelId: novelId || null
    });
    
    const savedReport = await report.save();
    
    // Return saved report but populate reporter for frontend use
    const populatedReport = await Report.findById(savedReport._id)
      .populate('reporter', 'username avatar')
      .exec();
    
    res.status(201).json(populatedReport);
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route GET /api/reports
 * @desc Get all reports (admin/moderator only)
 * @access Private/Admin/Moderator
 */
router.get('/', auth, checkRole(['admin', 'moderator']), async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    
    // Find reports with the specified status
    const reports = await Report.find({ status })
      .populate('reporter', 'username avatar')
      .sort({ createdAt: -1 });

    res.json(reports);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route PUT /api/reports/:id/resolve
 * @desc Resolve a report (admin/moderator only)
 * @access Private/Admin/Moderator
 */
router.put('/:id/resolve', auth, checkRole(['admin', 'moderator']), async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    
    report.status = 'resolved';
    await report.save();
    
    res.json({ message: 'Report resolved successfully' });
  } catch (error) {
    console.error('Error resolving report:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route DELETE /api/reports/:id
 * @desc Delete a report (admin only)
 * @access Private/Admin
 */
router.delete('/:id', auth, checkRole(['admin']), async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    
    await Report.deleteOne({ _id: req.params.id });
    
    res.json({ message: 'Report deleted successfully' });
  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router; 