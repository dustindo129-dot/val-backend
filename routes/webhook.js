import express from 'express';
import TopUpRequest from '../models/TopUpRequest.js';
import User from '../models/User.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Generic webhook handler for future payment methods
 * 
 * @route POST /api/webhook/payment
 */
router.post('/payment', async (req, res) => {
  console.log('Received payment webhook:', req.body);
  
  try {
    res.status(200).json({ message: 'Webhook endpoint ready for configuration' });
  } catch (error) {
    console.error('Payment webhook error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router; 