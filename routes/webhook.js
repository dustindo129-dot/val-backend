import express from 'express';
import TopUpRequest from '../models/TopUpRequest.js';
import User from '../models/User.js';
import { verifyMomoSignature, verifyZaloPaySignature } from '../utils/paymentUtils.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * MoMo payment webhook handler
 * Receives payment confirmation from MoMo
 * 
 * @route POST /api/webhook/momo
 */
router.post('/momo', async (req, res) => {
  console.log('Received MoMo webhook:', req.body);
  
  try {
    // Validate signature
    if (!verifyMomoSignature(req.body)) {
      console.error('Invalid MoMo signature');
      return res.status(400).json({ message: 'Invalid signature' });
    }
    
    const { orderId, resultCode, amount, extraData, transId } = req.body;
    
    // Decode extraData (contains userId)
    let userId;
    try {
      const decodedData = JSON.parse(Buffer.from(extraData, 'base64').toString());
      userId = decodedData.userId;
    } catch (error) {
      console.error('Failed to decode extraData:', error);
    }
    
    // Find the corresponding top-up request
    const request = await TopUpRequest.findById(orderId);
    
    if (!request) {
      console.error(`MoMo webhook: Request not found for orderId ${orderId}`);
      return res.status(404).json({ message: 'Request not found' });
    }
    
    // Check if request is already processed
    if (request.status !== 'Pending') {
      console.log(`MoMo webhook: Request ${orderId} already processed with status ${request.status}`);
      return res.status(200).json({ message: 'Request already processed' });
    }
    
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      // Process based on result code (0 = success)
      if (resultCode === 0 || resultCode === '0') {
        // Payment successful
        request.status = 'Completed';
        request.completedAt = new Date();
        request.notes = `MoMo transaction completed. TransID: ${transId}`;
        await request.save({ session });
        
        // Update user balance
        await User.findByIdAndUpdate(
          request.user,
          { $inc: { balance: request.balance + request.bonus } },
          { session }
        );
        
        console.log(`MoMo webhook: Successfully processed payment for request ${orderId}`);
      } else {
        // Payment failed
        request.status = 'Failed';
        request.notes = `MoMo transaction failed with code: ${resultCode}`;
        await request.save({ session });
        
        console.log(`MoMo webhook: Payment failed for request ${orderId} with code ${resultCode}`);
      }
      
      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      console.error('MoMo webhook transaction error:', error);
      return res.status(500).json({ message: 'Internal server error' });
    } finally {
      session.endSession();
    }
    
    // Always return success to MoMo, even if we had internal issues
    // This prevents MoMo from retrying the webhook constantly
    res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('MoMo webhook error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * ZaloPay payment webhook handler
 * Receives payment confirmation from ZaloPay
 * 
 * @route POST /api/webhook/zalopay
 */
router.post('/zalopay', async (req, res) => {
  console.log('Received ZaloPay webhook:', req.body);
  
  try {
    // Validate signature (mac in ZaloPay terms)
    if (!verifyZaloPaySignature(req.body)) {
      console.error('Invalid ZaloPay signature');
      return res.status(400).json({ message: 'Invalid signature' });
    }
    
    const { app_trans_id, amount, status, zp_trans_id } = req.body;
    
    // Extract our order ID from app_trans_id
    // In our implementation, app_trans_id should start with 'ZLP' followed by a timestamp and the orderId
    const matches = app_trans_id.match(/^ZLP\d+_(.+)$/);
    const orderId = matches ? matches[1] : app_trans_id;
    
    // Find the corresponding top-up request
    const request = await TopUpRequest.findById(orderId);
    
    if (!request) {
      console.error(`ZaloPay webhook: Request not found for appTransId ${app_trans_id}`);
      return res.status(404).json({ message: 'Request not found' });
    }
    
    // Check if request is already processed
    if (request.status !== 'Pending') {
      console.log(`ZaloPay webhook: Request ${orderId} already processed with status ${request.status}`);
      return res.status(200).json({ message: 'Request already processed' });
    }
    
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      // Process based on status (1 = success)
      if (status === 1 || status === '1') {
        // Payment successful
        request.status = 'Completed';
        request.completedAt = new Date();
        request.notes = `ZaloPay transaction completed. TransID: ${zp_trans_id}`;
        await request.save({ session });
        
        // Update user balance
        await User.findByIdAndUpdate(
          request.user,
          { $inc: { balance: request.balance + request.bonus } },
          { session }
        );
        
        console.log(`ZaloPay webhook: Successfully processed payment for request ${orderId}`);
      } else {
        // Payment failed
        request.status = 'Failed';
        request.notes = `ZaloPay transaction failed with status: ${status}`;
        await request.save({ session });
        
        console.log(`ZaloPay webhook: Payment failed for request ${orderId} with status ${status}`);
      }
      
      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      console.error('ZaloPay webhook transaction error:', error);
      return res.status(500).json({ message: 'Internal server error' });
    } finally {
      session.endSession();
    }
    
    // Return appropriate response to ZaloPay
    res.status(200).json({ 
      return_code: 1, 
      return_message: 'success'
    });
  } catch (error) {
    console.error('ZaloPay webhook error:', error);
    res.status(500).json({ 
      return_code: 0,
      return_message: 'Internal server error'
    });
  }
});

export default router; 