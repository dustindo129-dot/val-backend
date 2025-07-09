import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';
import TopUpRequest from '../models/TopUpRequest.js';
import TransactionInfo from '../models/TransactionInfo.js';
import mongoose from 'mongoose';
import { validatePrepaidCard } from '../integrations/cardProvider.js';
import { getBankAccountInfo } from '../utils/paymentUtils.js';
import paymentConfig from '../config/paymentConfig.js';
import { createTransaction } from './userTransaction.js';
import { broadcastEventToUser } from '../services/sseService.js';

const router = express.Router();

// Set expiration time for pending requests (30 minutes)
const PENDING_REQUEST_EXPIRY_TIME = 30 * 60 * 1000; // 30 minutes in milliseconds

/**
 * Calculate balance to add based on amount paid
 * Uses the pricing tiers defined in the system
 */
function calculateBalanceFromAmount(amountPaid) {
  // Pricing tiers from the system
  const pricingTiers = [
    { price: 12000, balance: 100 },
    { price: 20000, balance: 200 },
    { price: 50000, balance: 520 },
    { price: 100000, balance: 1100 },
    { price: 200000, balance: 2250 },
    { price: 350000, balance: 4000 }
  ];
  
  // Find exact match first
  const exactMatch = pricingTiers.find(tier => tier.price === amountPaid);
  if (exactMatch) {
    return exactMatch.balance;
  }
  
  // Find the closest tier (for approximate amounts)
  let closestTier = pricingTiers[0];
  let smallestDifference = Math.abs(amountPaid - closestTier.price);
  
  for (const tier of pricingTiers) {
    const difference = Math.abs(amountPaid - tier.price);
    if (difference < smallestDifference) {
      smallestDifference = difference;
      closestTier = tier;
    }
  }
  
  // If the difference is reasonable (within 10%), use the tier's balance
  const percentageDifference = smallestDifference / closestTier.price;
  if (percentageDifference <= 0.1) { // Within 10%
    return closestTier.balance;
  }
  
  // Fallback: calculate proportionally based on the base rate (100 VND = ~1 rice)
  return Math.floor(amountPaid / 100);
}

/**
 * User-initiated top-up request
 * @route POST /api/topup/request
 * @description Users can request to top up their account balance
 */
router.post('/request', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { amount, balance, paymentMethod, details } = req.body;
    
    // Validate request data
    if (!amount || !balance || !paymentMethod) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Create top-up request (removed bonus calculation)
    const topUpRequest = new TopUpRequest({
      user: req.user._id,
      amount,
      balance,
      bonus: 0, // Set bonus to 0 for all requests
      paymentMethod,
      status: 'Pending',
      expiresAt: new Date(Date.now() + PENDING_REQUEST_EXPIRY_TIME) // Set expiration time
    });
    
    // Handle different payment methods
    if (paymentMethod === 'bank') {
      if (!details || !details.accountNumber || !details.accountName || !details.bankName) {
        return res.status(400).json({ message: 'Missing bank transfer details' });
      }
      
      // Generate a reference code if not provided
      const transferContent = details.transferContent || `Topup-${req.user.username}`;
      
      topUpRequest.details = {
        bankName: details.bankName,
        accountName: details.accountName,
        accountNumber: details.accountNumber,
        transferContent
      };
      
      // Get bank account information for display
      const bankAccount = getBankAccountInfo();
      
      // Save the request
      await topUpRequest.save({ session });
      
      // Check for unmatched transactions that can now be matched
      const unmatched = await TransactionInfo.findOne({ 
        extractedContent: transferContent,
        processed: false
      });
      
      if (unmatched) {
        console.log(`Found matching unprocessed transaction for new request: ${unmatched.transactionId}`);
        
        // Create transaction data format
        const transactionData = {
          transactionId: unmatched.transactionId,
          amount: unmatched.amount,
          description: unmatched.description,
          date: unmatched.date,
          matched: true
        };
        
        // Mark transaction as processed and matched
        unmatched.processed = true;
        unmatched.status = 'matched';
        await unmatched.save({ session });
        
        // Update the request with transaction info
        topUpRequest.bankTransactions.push(transactionData);
        topUpRequest.receivedAmount = unmatched.amount;
        topUpRequest.status = 'Completed';
        topUpRequest.completedAt = new Date();
        topUpRequest.details.bankReference = unmatched.transactionId;
        topUpRequest.details.autoProcessed = true;
        
        // Remove expiration to prevent TTL deletion of completed requests
        topUpRequest.expiresAt = undefined;
        
        await topUpRequest.save({ session });
        
        // Update user balance
        await User.findByIdAndUpdate(
          req.user._id,
          { $inc: { balance: topUpRequest.balance } },
          { session }
        );
        
        // Record in transaction ledger
        await createTransaction({
          userId: req.user._id,
          amount: topUpRequest.balance,
          type: 'topup',
          description: `Nạp tiền qua chuyển khoản ngân hàng (tự động - khớp với giao dịch trước đó)`,
          sourceId: topUpRequest._id,
          sourceModel: 'TopUpRequest',
          performedById: null, // Automatic process
          balanceAfter: req.user.balance + topUpRequest.balance
        }, session);
        
        await session.commitTransaction();
        
        // Broadcast balance update event to user via SSE
        broadcastEventToUser('balance_updated', {
          userId: req.user._id,
          balanceAdded: topUpRequest.balance,
          newBalance: req.user.balance + topUpRequest.balance,
          reason: 'topup',
          description: 'Nạp tiền qua chuyển khoản ngân hàng (tự động - khớp với giao dịch trước đó)'
        }, req.user._id);
        
        return res.status(200).json({ 
          message: 'Đã tìm thấy giao dịch chuyển khoản khớp với mã của bạn. Tài khoản đã được cập nhật.',
          requestId: topUpRequest._id,
          status: 'Completed',
          balanceAdded: topUpRequest.balance
        });
      }
      
      await session.commitTransaction();
      
      return res.status(200).json({ 
        message: 'Top-up request received. Please complete the bank transfer with the exact amount and reference.',
        requestId: topUpRequest._id,
        status: 'Pending',
        transferDetails: {
          amount: amount,
          reference: transferContent,
          bankName: bankAccount.bank,
          accountNumber: bankAccount.accountNumber,
          accountName: bankAccount.accountName
        }
      });
    } else if (paymentMethod === 'prepaidCard') {
      if (!details || !details.cardNumber || !details.cardPin || !details.provider) {
        return res.status(400).json({ message: 'Missing prepaid card details' });
      }
      
      topUpRequest.details = {
        provider: details.provider,
        cardNumber: details.cardNumber,
        cardPin: details.cardPin
      };
      
      // Validate the card immediately
      const validationResult = await validatePrepaidCard(
        details.provider,
        details.cardNumber,
        details.cardPin
      );
      
      // Store masked card number for security
      topUpRequest.details.cardNumber = validationResult.cardNumber;
      
      if (!validationResult.valid) {
        // Save the failed request for record keeping
        topUpRequest.status = 'Failed';
        topUpRequest.notes = validationResult.message;
        await topUpRequest.save({ session });
        await session.commitTransaction();
        
        return res.status(400).json({ 
          message: validationResult.message || 'Invalid card details',
          requestId: topUpRequest._id,
          status: 'Failed'
        });
      }
      
      // If card value doesn't match expected amount, adjust or reject
      if (validationResult.amount !== amount) {
        // Option 2: Reject the card
        topUpRequest.status = 'Failed';
        topUpRequest.notes = `Card value (${validationResult.amount}) does not match expected amount (${amount})`;
        await topUpRequest.save({ session });
        await session.commitTransaction();
        
        return res.status(400).json({
          message: `Card value (${validationResult.amount}) does not match expected amount (${amount})`,
          requestId: topUpRequest._id,
          status: 'Failed'
        });
      }
      
      // Card is valid, update request and user balance
      topUpRequest.status = 'Completed';
      topUpRequest.completedAt = new Date();
      
      // Remove expiration to prevent TTL deletion of completed requests
      topUpRequest.expiresAt = undefined;
      
      await topUpRequest.save({ session });
      
      // Update user balance (no bonus)
      await User.findByIdAndUpdate(
        req.user._id,
        { $inc: { balance: topUpRequest.balance } },
        { session }
      );
      
      await session.commitTransaction();
      
      // Broadcast balance update event to user via SSE
      broadcastEventToUser('balance_updated', {
        userId: req.user._id,
        balanceAdded: topUpRequest.balance,
        newBalance: req.user.balance + topUpRequest.balance,
        reason: 'topup',
        description: 'Nạp tiền qua thẻ trả trước'
      }, req.user._id);
      
      return res.status(200).json({ 
        message: 'Card accepted and balance added to your account',
        requestId: topUpRequest._id,
        status: 'Completed',
        balanceAdded: topUpRequest.balance
      });
    } else {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Invalid payment method' });
    }
  } catch (error) {
    await session.abortTransaction();
    console.error('Top-up request error:', error);
    res.status(500).json({ message: 'Failed to process top-up request' });
  } finally {
    session.endSession();
  }
});

/**
 * Get user's pending top-up requests
 * @route GET /api/topup/pending
 * @description Users can view their pending top-up requests
 */
router.get('/pending', auth, async (req, res) => {
  try {
    // Get current time
    const now = new Date();
    
    // Find expired pending requests and update their status
    const expiredRequests = await TopUpRequest.find({
      user: req.user._id,
      status: 'Pending',
      expiresAt: { $lt: now }
    });
    
    // Update expired requests if any found
    if (expiredRequests.length > 0) {
      const expiredIds = expiredRequests.map(req => req._id);
      
      await TopUpRequest.updateMany(
        { _id: { $in: expiredIds } },
        { 
          $set: { 
            status: 'Cancelled',
            notes: 'Automatically cancelled due to expiration'
          }
        }
      );
      
      console.log(`Cancelled ${expiredRequests.length} expired top-up requests`);
    }
    
    // Get remaining pending requests
    const pendingRequests = await TopUpRequest.find({
      user: req.user._id,
      status: 'Pending'
    }).sort({ createdAt: -1 });
    
    // Format response for different payment methods
    const formattedRequests = pendingRequests.map(request => {
      let formattedRequest = {
        _id: request._id,
        amount: request.amount,
        balance: request.balance,
        bonus: request.bonus,
        paymentMethod: request.paymentMethod,
        status: request.status,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt
      };
      
      // Add payment method specific details
      if (request.paymentMethod === 'bank') {
        formattedRequest.bankInfo = {
          transferContent: request.details.transferContent
        };
        
        // Add bank account info for convenience
        formattedRequest.ourBankAccount = getBankAccountInfo();
      }
      
      return formattedRequest;
    });
    
    res.json(formattedRequests);
  } catch (error) {
    console.error('Failed to fetch pending requests:', error);
    res.status(500).json({ message: 'Failed to fetch pending requests' });
  }
});

/**
 * Get user's top-up history
 * @route GET /api/topup/history
 * @description Users can view their top-up history
 */
router.get('/history', auth, async (req, res) => {
  try {
    const history = await TopUpRequest.find({
      user: req.user._id
    }).sort({ createdAt: -1 });
    
    // Mask sensitive data
    const formattedHistory = history.map(item => {
      const formattedItem = {
        _id: item._id,
        amount: item.amount,
        balance: item.balance,
        bonus: item.bonus,
        paymentMethod: item.paymentMethod,
        status: item.status,
        createdAt: item.createdAt,
        completedAt: item.completedAt
      };
      
      // Add payment method specific details but mask sensitive info
      if (item.paymentMethod === 'prepaidCard' && item.details) {
        formattedItem.cardInfo = {
          provider: item.details.provider,
          cardNumber: item.details.cardNumber // Already masked during processing
        };
      } else if (item.paymentMethod === 'bank' && item.details) {
        formattedItem.bankInfo = {
          bankName: item.details.bankName,
          transferContent: item.details.transferContent
        };
      }
      
      return formattedItem;
    });
    
    res.json(formattedHistory);
  } catch (error) {
    console.error('Failed to fetch top-up history:', error);
    res.status(500).json({ message: 'Failed to fetch top-up history' });
  }
});

/**
 * Cancel a pending top-up request
 * @route DELETE /api/topup/request/:requestId
 * @description Users can cancel their pending top-up requests
 */
router.delete('/request/:requestId', auth, async (req, res) => {
  try {
    const requestId = req.params.requestId;
    
    // Find the request and ensure it belongs to the user
    const request = await TopUpRequest.findOne({
      _id: requestId,
      user: req.user._id,
      status: 'Pending'
    });
    
    if (!request) {
      return res.status(404).json({ 
        message: 'Request not found or cannot be cancelled' 
      });
    }
    
    // Update request status
    request.status = 'Cancelled';
    request.notes = 'Cancelled by user';
    await request.save();
    
    res.json({ 
      message: 'Request cancelled successfully',
      requestId
    });
  } catch (error) {
    console.error('Failed to cancel request:', error);
    res.status(500).json({ message: 'Failed to cancel request' });
  }
});

/**
 * Get pricing options
 * @route GET /api/topup/pricing
 * @description Get available pricing options for top-up
 */
router.get('/pricing', async (req, res) => {
  try {
    // In a real implementation, these might come from a database
    const pricingOptions = [
      { price: 12000, balance: 100, note: "Gói chặn quảng cáo vĩnh viễn 🛡️" },
      { price: 20000, balance: 200, note: "Gói bim bim 🍟" },
      { price: 50000, balance: 520, note: "Gói cốc cà phê ☕" },
      { price: 100000, balance: 1100, note: "Gói bát phở 🍜" },
      { price: 200000, balance: 2250, note: "Gói bao trọn 1 vol tiếng Anh/Trung 💸" },
      { price: 350000, balance: 4000, note: "Gói siêu VIP bao trọn 1 vol tiếng Nhật 👑" }
    ];
    
    res.json(pricingOptions);
  } catch (error) {
    console.error('Failed to fetch pricing options:', error);
    res.status(500).json({ message: 'Failed to fetch pricing options' });
  }
});

/**
 * Get bank account information
 * @route GET /api/topup/bank-info
 * @description Get bank account information for bank transfers
 */
router.get('/bank-info', async (req, res) => {
  try {
    const bankAccount = getBankAccountInfo();
    res.json(bankAccount);
  } catch (error) {
    console.error('Failed to fetch bank information:', error);
    res.status(500).json({ message: 'Failed to fetch bank information' });
  }
});

/**
 * Automatic bank transfer processing API for Casso
 * @route POST /api/topup/process-bank-transfer
 * @description Automatically process a bank transfer when payment is received via Casso
 * @access Private - Should only be accessible by the Casso webhook
 */
router.post('/process-bank-transfer', async (req, res) => {
  try {
    // Log the incoming webhook for debugging
    console.log('---------- CASSO WEBHOOK RECEIVED ----------');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    console.log('----------------------------------------------');

    // Verify Casso API key (check both header options)
    const apiKey = req.headers['x-api-key'] || req.headers['secure-token'];
    if (!apiKey || apiKey !== process.env.BANK_WEBHOOK_API_KEY) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Handle Casso webhook format
    const { data } = req.body;
    
    // Casso sends an array of transactions
    if (!data || !Array.isArray(data)) {
      return res.status(400).json({ message: 'Invalid webhook data format' });
    }
    
    // Process each transaction in the webhook
    const results = [];
    
    for (const transaction of data) {
      // Extract necessary information from Casso transaction format
      const { 
        description,    // Transfer content/description
        amount,         // Amount (in test data)
        tid,            // Transaction ID (tid in test data, transId in production)
        bank_sub_acc_id, // Bank account ID (different naming in test vs production)
      } = transaction;
      
      // Use either creditAmount (production) or amount (test)
      const creditAmount = transaction.creditAmount || amount;
      // Use either transId (production) or tid (test)
      const transId = transaction.transId || tid;
      
      // Skip if important data is missing
      if (!description || !creditAmount || !transId) {
        results.push({
          transId: transId || 'unknown',
          status: 'failed',
          message: 'Missing required transaction data'
        });
        continue;
      }

      // Extract the transfer content using regex to find isolated 8-character alphanumeric strings
      // Look for 8-character alphanumeric strings that are surrounded by delimiters or at start/end
      const transferContentRegex = /(^|[^a-zA-Z0-9])([a-zA-Z0-9]{8})([^a-zA-Z0-9]|$)/g;
      let matches = [];
      let match;
      
      // Extract all potential matches
      while ((match = transferContentRegex.exec(description)) !== null) {
        matches.push(match[2]); // The actual match is in the 2nd capture group
      }
      
      // If no matches found with delimiter approach, fallback to simple 8-char detection
      if (matches.length === 0) {
        const simpleRegex = /[a-zA-Z0-9]{8}/g;
        matches = description.match(simpleRegex) || [];
      }
      
      let actualTransferContent = '';
      
      if (matches && matches.length > 0) {
        // Prioritize matches that have mixed case and numbers
        const idealMatch = matches.find(m => 
          /[a-z]/.test(m) && 
          /[A-Z]/.test(m) && 
          /[0-9]/.test(m)
        );
        
        // If no ideal match, use the last match as fallback
        actualTransferContent = idealMatch || matches[matches.length - 1];
        
        console.log(`Found potential transfer content: ${actualTransferContent} from description: ${description}`);
      } else {
        // Fallback to the old method if no 8-char codes found
        actualTransferContent = description.split('-').pop();
        console.log(`Using fallback method, extracted: ${actualTransferContent} from: ${description}`);
      }
      
      // Additional fallback: Check if any 8-character sequence matches an existing transfer content
      if (!actualTransferContent || actualTransferContent.length !== 8) {
        try {
          // Find all pending bank transfer requests to match against their transfer contents
          const pendingRequests = await TopUpRequest.find({
            'paymentMethod': 'bank',
            'status': 'Pending'
          }).select('details.transferContent').lean();
          
          // Extract all transfer contents to match against
          const existingTransferContents = pendingRequests
            .map(req => req.details?.transferContent)
            .filter(Boolean);
          
          if (existingTransferContents.length > 0) {
            console.log(`Checking for matches against ${existingTransferContents.length} existing transfer contents`);
            
            // Check if any part of the description matches an existing transfer content
            const foundMatch = existingTransferContents.find(transferContent => 
              description.includes(transferContent) && transferContent.length === 8
            );
            
            if (foundMatch) {
              actualTransferContent = foundMatch;
              console.log(`Found exact match with existing transfer content: ${actualTransferContent}`);
            }
          }
        } catch (err) {
          console.error('Error checking for existing transfer content matches:', err);
        }
      }

      // Check if this transaction has already been processed (idempotency)
      const existingTransaction = await TopUpRequest.findOne({
        'bankTransactions.transactionId': transId
      });

      if (existingTransaction) {
        results.push({
          transId,
          status: 'skipped',
          message: 'Transaction already processed',
          requestId: existingTransaction._id
        });
        continue;
      }

      // First, try to find a request with matching transfer content
      let pendingRequest = await TopUpRequest.findOne({
        'details.transferContent': actualTransferContent,
        'status': 'Pending',
        'paymentMethod': 'bank'
      });

      // Store transaction data regardless of whether we find a matching request
      const transactionData = {
        transactionId: transId,
        amount: creditAmount,
        description: description,
        date: new Date(transaction.when || Date.now()),
        matched: !!pendingRequest
      };

      if (!pendingRequest) {
        console.log(`Unmatched bank transfer: ${description}, amount: ${creditAmount}, transaction: ${transId}`);
        
        // Store unmatched transaction for future matching
        try {
          await TransactionInfo.create({
            transactionId: transId,
            description: description,
            extractedContent: actualTransferContent,
            amount: creditAmount,
            bankName: transaction.bankName || 'Unknown',
            bankAccount: bank_sub_acc_id,
            date: new Date(transaction.when || Date.now())
          });
          
          console.log(`Stored unmatched transaction ${transId} with reference ${actualTransferContent} for future matching`);
        } catch (err) {
          // Handle duplicate transaction ID (idempotency)
          if (err.code === 11000) {
            console.log(`Transaction ${transId} already stored`);
          } else {
            console.error(`Error storing unmatched transaction: ${err.message}`);
          }
        }
        
        // Create a TopUpRequest record for this standalone bank transaction
        // so it appears in the admin's "Giao dịch gần đây" section
        const session = await mongoose.startSession();
        session.startTransaction();
        
        try {
          // Try to find a user based on the transfer content or use a default system user
          let targetUser = null;
          
          // Try to extract username from transfer content (if it follows pattern like "Topup-username")
          if (actualTransferContent && actualTransferContent.includes('Topup-')) {
            const extractedUsername = actualTransferContent.replace('Topup-', '');
            targetUser = await User.findOne({ username: extractedUsername }).session(session);
          }
          
          // If no user found from transfer content, try to find any user that might have this transfer content in recent requests
          if (!targetUser) {
            const recentRequest = await TopUpRequest.findOne({
              'details.transferContent': actualTransferContent,
              'paymentMethod': 'bank'
            }).populate('user').session(session);
            
            if (recentRequest) {
              targetUser = recentRequest.user;
            }
          }
          
          // If still no user found, skip creating TopUpRequest but log it
          if (!targetUser) {
            await session.abortTransaction();
            results.push({
              transId,
              status: 'pending_review',
              message: 'No matching user found, stored for manual review'
            });
            continue;
          }
          
          // Calculate balance to add (using standard conversion rate)
          const balanceToAdd = calculateBalanceFromAmount(creditAmount);
          
          // Create a standalone TopUpRequest for this bank transaction
          const standaloneRequest = new TopUpRequest({
            user: targetUser._id,
            amount: creditAmount,
            receivedAmount: creditAmount,
            balance: balanceToAdd,
            bonus: 0,
            paymentMethod: 'bank',
            status: 'Completed',
            completedAt: new Date(),
            expiresAt: undefined, // Ensure completed requests don't expire
            details: {
              bankName: transaction.bankName || 'Unknown',
              accountName: targetUser.username,
              accountNumber: bank_sub_acc_id || 'Unknown',
              transferContent: actualTransferContent,
              bankReference: transId,
              autoProcessed: true,
              cassoProcessed: true,
              standaloneTransaction: true // Flag to indicate this wasn't user-initiated
            },
            notes: 'Tự động tạo từ giao dịch ngân hàng'
          });
          
          // Add the bank transaction data
          standaloneRequest.bankTransactions.push(transactionData);
          
          await standaloneRequest.save({ session });
          
          // Update user balance
          const prevBalance = targetUser.balance || 0;
          targetUser.balance = prevBalance + balanceToAdd;
          await targetUser.save({ session });
          
          // Create UserTransaction record
          await createTransaction({
            userId: targetUser._id,
            amount: balanceToAdd,
            type: 'topup',
            description: `Nạp tiền qua chuyển khoản ngân hàng (tự động)`,
            sourceId: standaloneRequest._id,
            sourceModel: 'TopUpRequest',
            performedById: null, // Automatic process
            balanceAfter: targetUser.balance
          }, session);
          
          await session.commitTransaction();
          
          // Broadcast balance update event to user via SSE
          broadcastEventToUser('balance_updated', {
            userId: targetUser._id,
            balanceAdded: balanceToAdd,
            newBalance: targetUser.balance,
            reason: 'topup',
            description: 'Nạp tiền qua chuyển khoản ngân hàng (tự động)'
          }, targetUser._id);
          
          results.push({
            transId,
            status: 'success',
            message: 'Standalone bank transfer processed successfully',
            requestId: standaloneRequest._id,
            username: targetUser.username,
            balanceAdded: balanceToAdd
          });
          
        } catch (error) {
          await session.abortTransaction();
          console.error('Error creating standalone TopUpRequest:', error);
          results.push({
            transId,
            status: 'failed',
            message: 'Failed to create standalone request'
          });
        } finally {
          session.endSession();
        }
        
        continue;
      }

      // Verify the amount matches (allowing for minor differences)
      const amountDifference = Math.abs(pendingRequest.amount - creditAmount);
      const isDifferent = amountDifference > 100; // Allow for small variance (e.g., 100 VND)

      // Log amount mismatch for monitoring
      if (isDifferent) {
        console.log(`Amount mismatch for transfer: ${description}, expected: ${pendingRequest.amount}, received: ${creditAmount}, request ID: ${pendingRequest._id}`);
      }

      // Start a transaction for data consistency
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        if (isDifferent) {
          // If amount doesn't match, add a note but still process
          pendingRequest.notes = `Auto-processed with amount mismatch. Expected: ${pendingRequest.amount}, Received: ${creditAmount}`;
        }

        // Add transaction to the request's transaction history
        pendingRequest.bankTransactions.push(transactionData);
        
        // Update the receivedAmount
        pendingRequest.receivedAmount = creditAmount;

        // Update the request
        pendingRequest.status = 'Completed';
        pendingRequest.completedAt = new Date();
        pendingRequest.details.bankReference = transId;
        pendingRequest.details.autoProcessed = true;
        pendingRequest.details.cassoProcessed = true;
        
        // Remove expiration to prevent TTL deletion of completed requests
        pendingRequest.expiresAt = undefined;
        
        await pendingRequest.save({ session });

        // Get the user and previous balance
        const user = await User.findById(pendingRequest.user).session(session);
        if (!user) {
          await session.abortTransaction();
          results.push({
            transId,
            status: 'failed',
            message: 'User not found'
          });
          continue;
        }

        const prevBalance = user.balance || 0;
        user.balance = prevBalance + pendingRequest.balance;
        await user.save({ session });

        // Record in UserTransaction ledger
        let description = `Nạp tiền qua chuyển khoản ngân hàng (tự động)`;
        if (isDifferent) {
          description += ` (Ghi nhận chênh lệch số tiền)`;
        }

        await createTransaction({
          userId: user._id,
          amount: pendingRequest.balance,
          type: 'topup',
          description,
          sourceId: pendingRequest._id,
          sourceModel: 'TopUpRequest',
          performedById: null, // Automatic process
          balanceAfter: user.balance
        }, session);

        await session.commitTransaction();

        // Broadcast balance update event to user via SSE
        broadcastEventToUser('balance_updated', {
          userId: user._id,
          balanceAdded: pendingRequest.balance,
          newBalance: user.balance,
          reason: 'topup',
          description: description
        }, user._id);

        results.push({
          transId,
          status: 'success',
          message: 'Bank transfer processed successfully',
          requestId: pendingRequest._id,
          username: user.username,
          balanceAdded: pendingRequest.balance
        });
      } catch (error) {
        await session.abortTransaction();
        console.error('Error processing bank transfer:', error);
        results.push({
          transId,
          status: 'failed',
          message: 'Failed to process bank transfer'
        });
      } finally {
        session.endSession();
      }
    }

    // Return summary of all processed transactions
    return res.status(200).json({
      message: 'Casso webhook processed',
      results
    });
  } catch (error) {
    console.error('Casso webhook processing error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * Get unmatched transactions
 * @route GET /api/topup/unmatched-transactions
 * @description Admin endpoint to get unmatched transactions
 */
router.get('/unmatched-transactions', auth, async (req, res) => {
  // Ensure user is an admin
  if (!req.user.role || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Unauthorized' });
  }
  
  try {
    const unmatched = await TransactionInfo.find({ 
      status: 'pending',
      processed: false 
    }).sort({ date: -1 });
    
    res.json(unmatched);
  } catch (error) {
    console.error('Failed to fetch unmatched transactions:', error);
    res.status(500).json({ message: 'Failed to fetch unmatched transactions' });
  }
});

/**
 * Dismiss an unmatched transaction
 * @route POST /api/topup/dismiss-unmatched/:transactionId
 * @description Admin endpoint to dismiss an unmatched transaction
 */
router.post('/dismiss-unmatched/:transactionId', auth, async (req, res) => {
  // Ensure user is an admin
  if (!req.user.role || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Unauthorized' });
  }
  
  const { transactionId } = req.params;
  
  try {
    // Find the unmatched transaction
    const transaction = await TransactionInfo.findOne({ 
      transactionId,
      status: 'pending',
      processed: false 
    });
    
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found or already processed' });
    }
    
    // Update transaction status to dismissed
    transaction.status = 'dismissed';
    transaction.dismissedBy = req.user._id;
    transaction.dismissedAt = new Date();
    
    await transaction.save();
    
    res.status(200).json({
      message: 'Transaction dismissed successfully',
      transactionId
    });
  } catch (error) {
    console.error('Failed to dismiss transaction:', error);
    res.status(500).json({ message: 'Failed to dismiss transaction' });
  }
});

/**
 * Get dismissed/processed transactions history
 * @route GET /api/topup/dismissed-transactions
 * @description Admin endpoint to get dismissed and matched transactions history
 */
router.get('/dismissed-transactions', auth, async (req, res) => {
  // Ensure user is an admin
  if (!req.user.role || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Unauthorized' });
  }
  
  try {
    const dismissed = await TransactionInfo.find({ 
      status: { $in: ['dismissed', 'matched'] }
    })
    .populate('dismissedBy', 'username displayName')
    .sort({ dismissedAt: -1, updatedAt: -1 })
    .limit(100); // Limit to last 100 for performance
    
    res.json(dismissed);
  } catch (error) {
    console.error('Failed to fetch dismissed transactions:', error);
    res.status(500).json({ message: 'Failed to fetch dismissed transactions' });
  }
});

/**
 * Manually process an unmatched transaction
 * @route POST /api/topup/process-unmatched/:transactionId
 * @description Admin endpoint to manually process an unmatched transaction
 */
router.post('/process-unmatched/:transactionId', auth, async (req, res) => {
  // Ensure user is an admin
  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Unauthorized' });
  }
  
  const { userId, amount, balance } = req.body;
  const { transactionId } = req.params;
  
  if (!userId || !amount || !balance) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Find the unmatched transaction
    const transaction = await TransactionInfo.findOne({ 
      transactionId,
      processed: false 
    }).session(session);
    
    if (!transaction) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Transaction not found or already processed' });
    }
    
    // Find user
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Create a new TopUpRequest
    const topUpRequest = new TopUpRequest({
      user: userId,
      amount,
      balance,
      bonus: 0,
      paymentMethod: 'bank',
      status: 'Completed',
      completedAt: new Date(),
      expiresAt: undefined, // Ensure completed requests don't expire
      receivedAmount: transaction.amount,
      details: {
        bankName: transaction.bankName || 'Unknown',
        accountName: user.username,
        accountNumber: transaction.bankAccount || 'Unknown',
        transferContent: transaction.extractedContent,
        bankReference: transaction.transactionId,
        manuallyProcessed: true
      },
      adminId: req.user._id,
      notes: `Manually processed from unmatched transaction by admin ${req.user.username}`
    });
    
    // Add transaction to the request
    topUpRequest.bankTransactions.push({
      transactionId: transaction.transactionId,
      amount: transaction.amount,
      description: transaction.description,
      date: transaction.date,
      matched: true
    });
    
    await topUpRequest.save({ session });
    
    // Update user balance
    const prevBalance = user.balance || 0;
    user.balance = prevBalance + balance;
    await user.save({ session });
    
    // Mark transaction as processed and matched
    transaction.processed = true;
    transaction.status = 'matched';
    await transaction.save({ session });
    
    // Create transaction record
    await createTransaction({
      userId: user._id,
      amount: balance,
      type: 'topup',
      description: `Nạp tiền qua chuyển khoản ngân hàng (xử lý thủ công bởi admin)`,
      sourceId: topUpRequest._id,
      sourceModel: 'TopUpRequest',
      performedById: req.user._id,
      balanceAfter: user.balance
    }, session);
    
    await session.commitTransaction();
    
    // Broadcast balance update event to user via SSE
    broadcastEventToUser('balance_updated', {
      userId: user._id,
      balanceAdded: balance,
      newBalance: user.balance,
      reason: 'topup',
      description: 'Nạp tiền qua chuyển khoản ngân hàng (xử lý thủ công bởi admin)'
    }, user._id);
    
    res.status(200).json({
      message: 'Transaction processed successfully',
      requestId: topUpRequest._id
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Failed to process transaction:', error);
    res.status(500).json({ message: 'Failed to process transaction' });
  } finally {
    session.endSession();
  }
});

export default router; 