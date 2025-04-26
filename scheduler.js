import cron from 'node-cron';
import { verifyBankTransfers } from './services/bankTransferVerifier.js';
import mongoose from 'mongoose';
import TopUpRequest from './models/TopUpRequest.js';

/**
 * Initialize all scheduled tasks
 */
export const initScheduler = () => {
  console.log('Initializing scheduled tasks...');
  
  // Run bank transfer verification hourly
  cron.schedule('0 * * * *', async () => {
    console.log('Running scheduled bank transfer verification...');
    try {
      const result = await verifyBankTransfers();
      console.log('Bank transfer verification completed:', result);
    } catch (error) {
      console.error('Error in scheduled bank transfer verification:', error);
    }
  });

  // Clean up expired requests daily at midnight
  cron.schedule('0 0 * * *', async () => {
    console.log('Running cleanup of expired requests...');
    try {
      await cleanupExpiredRequests();
    } catch (error) {
      console.error('Error in expired requests cleanup:', error);
    }
  });
  
  // Handle stuck requests daily at 1 AM
  cron.schedule('0 1 * * *', async () => {
    console.log('Checking for stuck payment requests...');
    try {
      await handleStuckRequests();
    } catch (error) {
      console.error('Error in handling stuck requests:', error);
    }
  });
  
  console.log('Scheduler initialized successfully');
};

/**
 * Clean up expired requests
 * This marks old pending requests as 'Failed'
 * 
 * @returns {Promise<Object>} Summary of cleanup operation
 */
export const cleanupExpiredRequests = async () => {
  try {
    // Find pending requests older than 72 hours (3 days)
    const cutoffDate = new Date(Date.now() - 72 * 60 * 60 * 1000);
    
    const expiredRequests = await TopUpRequest.updateMany(
      { 
        status: 'Pending',
        createdAt: { $lt: cutoffDate }
      },
      {
        $set: {
          status: 'Failed',
          notes: 'Automatically marked as failed due to expiration (72 hours timeout)'
        }
      }
    );
    
    console.log(`Cleaned up ${expiredRequests.modifiedCount} expired requests`);
    return {
      success: true,
      count: expiredRequests.modifiedCount,
      message: `${expiredRequests.modifiedCount} expired requests cleaned up`
    };
  } catch (error) {
    console.error('Expired requests cleanup error:', error);
    return {
      success: false,
      error: error.message || 'Failed to clean up expired requests'
    };
  }
};

/**
 * Handle stuck requests (e.g., payment initiated but not completed)
 * 
 * @returns {Promise<Object>} Summary of the operation
 */
export const handleStuckRequests = async () => {
  try {
    // Find e-wallet payments (Momo, ZaloPay) that are pending for more than 4 hours
    const cutoffDate = new Date(Date.now() - 4 * 60 * 60 * 1000);
    
    const stuckRequests = await TopUpRequest.find({
      status: 'Pending',
      paymentMethod: 'ewallet',
      createdAt: { $lt: cutoffDate }
    });
    
    console.log(`Found ${stuckRequests.length} stuck e-wallet requests`);
    
    let processedCount = 0;
    
    for (const request of stuckRequests) {
      try {
        // Here you would check the payment status with the e-wallet provider
        // For now, we'll just mark them as failed
        request.status = 'Failed';
        request.notes = 'Automatically marked as failed (payment not completed in 4 hours)';
        await request.save();
        processedCount++;
      } catch (error) {
        console.error(`Error processing stuck request ${request._id}:`, error);
      }
    }
    
    return {
      success: true,
      total: stuckRequests.length,
      processed: processedCount,
      message: `Processed ${processedCount} of ${stuckRequests.length} stuck requests`
    };
  } catch (error) {
    console.error('Stuck requests handling error:', error);
    return {
      success: false,
      error: error.message || 'Failed to handle stuck requests'
    };
  }
}; 