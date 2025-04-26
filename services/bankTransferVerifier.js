import TopUpRequest from '../models/TopUpRequest.js';
import User from '../models/User.js';

/**
 * Service to verify bank transfers by checking for matches
 * In a real implementation, this would connect to a bank API
 * or use a reconciliation service
 */

/**
 * Verify pending bank transfers
 * This function would be called on a schedule (e.g., hourly)
 * 
 * @returns {Promise<Object>} Summary of verified transactions
 */
export const verifyBankTransfers = async () => {
  try {
    // Get all pending bank transfer requests
    const pendingRequests = await TopUpRequest.find({
      paymentMethod: 'bank',
      status: 'Pending'
    }).populate('user', 'username');
    
    if (pendingRequests.length === 0) {
      return { 
        success: true, 
        message: 'No pending bank transfers found',
        verified: 0,
        total: 0
      };
    }
    
    console.log(`Checking ${pendingRequests.length} pending bank transfers`);
    
    // Get recent bank transactions
    // In a real implementation, this would fetch from a bank API
    const bankTransactions = await mockGetBankTransactions();
    
    let verifiedCount = 0;
    
    // Process each pending request
    for (const request of pendingRequests) {
      try {
        // Look for matching transaction
        const match = findMatchingTransaction(request, bankTransactions);
        
        if (match) {
          // Transaction matched, update request
          await processMatchedTransaction(request, match);
          verifiedCount++;
        }
      } catch (error) {
        console.error(`Error processing request ${request._id}:`, error);
      }
    }
    
    return {
      success: true,
      verified: verifiedCount,
      total: pendingRequests.length,
      message: `Verified ${verifiedCount} of ${pendingRequests.length} pending bank transfers`
    };
  } catch (error) {
    console.error('Bank transfer verification error:', error);
    return {
      success: false,
      error: error.message || 'Failed to verify bank transfers'
    };
  }
};

/**
 * Find a matching bank transaction for a top-up request
 * 
 * @param {Object} request - TopUpRequest document
 * @param {Array} transactions - Bank transactions
 * @returns {Object|null} Matching transaction or null if not found
 */
const findMatchingTransaction = (request, transactions) => {
  // Look for exact amount match and reference in description
  return transactions.find(tx => {
    // Check amount matches
    const amountMatches = tx.amount === request.amount;
    
    // Check for reference code in description
    const referenceCode = request.details.transferContent;
    const usernameFound = request.user && request.user.username && 
      tx.description.toLowerCase().includes(request.user.username.toLowerCase());
    const referenceFound = referenceCode && 
      tx.description.toLowerCase().includes(referenceCode.toLowerCase());
    
    return amountMatches && (usernameFound || referenceFound);
  });
};

/**
 * Process a matched transaction
 * 
 * @param {Object} request - TopUpRequest document
 * @param {Object} transaction - Matching bank transaction
 * @returns {Promise<void>}
 */
const processMatchedTransaction = async (request, transaction) => {
  // Start session for transaction
  const session = await mongoose.connection.startSession();
  session.startTransaction();
  
  try {
    // Update request status
    request.status = 'Completed';
    request.completedAt = new Date();
    request.notes = `Matched with bank transaction: ${transaction.id}`;
    await request.save({ session });
    
    // Update user balance
    await User.findByIdAndUpdate(
      request.user._id,
      { $inc: { balance: request.balance + request.bonus } },
      { session }
    );
    
    await session.commitTransaction();
    console.log(`Successfully processed bank transfer for request ${request._id}`);
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Mock function to get bank transactions
 * In production, this would be replaced with a real bank API call
 * 
 * @returns {Promise<Array>} List of bank transactions
 */
const mockGetBankTransactions = async () => {
  // This is a mock function for demonstration
  // In a real implementation, you would integrate with your bank's API
  
  // For testing, we'll return some sample transactions
  return [
    {
      id: 'BT' + Date.now().toString().substring(5),
      amount: 20000,
      description: 'Topup-testuser123',
      date: new Date(),
      sender: {
        name: 'Test User',
        account: '9876543210'
      }
    },
    {
      id: 'BT' + (Date.now() - 100000).toString().substring(5),
      amount: 50000,
      description: 'Chuyen khoan cho user456',
      date: new Date(Date.now() - 3600000),
      sender: {
        name: 'Another User',
        account: '1234567890'
      }
    },
    // Add more mock transactions as needed
  ];
};

/**
 * Manually verify a specific bank transfer request
 * This would be called from an admin interface
 * 
 * @param {string} requestId - ID of the request to verify
 * @param {Object} adminUser - Admin user performing the verification
 * @param {boolean} approve - Whether to approve or reject the request
 * @param {string} notes - Optional notes from the admin
 * @returns {Promise<Object>} Result of verification
 */
export const manuallyVerifyBankTransfer = async (requestId, adminUser, approve, notes = '') => {
  const session = await mongoose.connection.startSession();
  session.startTransaction();
  
  try {
    // Find the request
    const request = await TopUpRequest.findById(requestId).session(session);
    
    if (!request) {
      await session.abortTransaction();
      return {
        success: false,
        message: 'Request not found'
      };
    }
    
    if (request.status !== 'Pending') {
      await session.abortTransaction();
      return {
        success: false,
        message: `Request is already ${request.status}`
      };
    }
    
    if (request.paymentMethod !== 'bank') {
      await session.abortTransaction();
      return {
        success: false,
        message: 'This is not a bank transfer request'
      };
    }
    
    // Update request status
    request.status = approve ? 'Completed' : 'Failed';
    request.completedAt = approve ? new Date() : undefined;
    request.adminId = adminUser._id;
    request.notes = notes;
    
    await request.save({ session });
    
    // If approved, update user balance
    if (approve) {
      await User.findByIdAndUpdate(
        request.user,
        { $inc: { balance: request.balance + request.bonus } },
        { session }
      );
    }
    
    await session.commitTransaction();
    
    return {
      success: true,
      message: approve ? 'Request approved and balance updated' : 'Request rejected',
      request: request
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Manual verification error:', error);
    return {
      success: false,
      error: error.message || 'Failed to process verification'
    };
  } finally {
    session.endSession();
  }
}; 