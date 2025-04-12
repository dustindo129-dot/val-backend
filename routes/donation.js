import express from 'express';
import { check, validationResult } from 'express-validator';
import Donation from '../models/Donation.js';
import { auth } from '../middleware/auth.js';
import admin from '../middleware/admin.js';

const router = express.Router();

/**
 * @route   GET /api/donation
 * @desc    Get donation content
 * @access  Public
 */
router.get('/', async (req, res) => {
  try {
    let donation = await Donation.findOne();

    if (!donation) {
      donation = await Donation.create({ content: '' });
    }

    // Only populate after we're sure we have a donation
    await donation.populate('lastUpdatedBy', 'username');
    res.json(donation);
  } catch (error) {
    console.error('Error in GET /api/donation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route   PUT /api/donation
 * @desc    Update donation content
 * @access  Admin only
 */
router.put('/', [
  auth,
  admin,
  check('content').notEmpty().withMessage('Content cannot be empty')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { content } = req.body;
    let donation = await Donation.findOne();
    
    if (!donation) {
      donation = new Donation();
    }
    
    donation.content = content;
    donation.lastUpdatedBy = req.user.id;
    await donation.save();
    
    await donation.populate('lastUpdatedBy', 'username');
    
    res.json(donation);
  } catch (error) {
    console.error('Error in PUT /api/donation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router; 