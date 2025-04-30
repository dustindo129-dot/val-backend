import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';
import TopUpRequest from '../models/TopUpRequest.js';
import mongoose from 'mongoose';
import { createMomoPayment, createZaloPayPayment } from '../integrations/ewallet.js';
import { validatePrepaidCard } from '../integrations/cardProvider.js';
import { getBankAccountInfo } from '../utils/paymentUtils.js';
import paymentConfig from '../config/paymentConfig.js';
import { createTransaction } from './userTransaction.js';

const router = express.Router();

/**
 * User-initiated top-up request
 * @route POST /api/topup/request
 * @description Users can request to top up their account balance
 */
router.post('/request', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { amount, balance, paymentMethod, subMethod, details } = req.body;
    
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
      status: 'Pending'
    });
    
    // Handle different payment methods
    if (paymentMethod === 'ewallet') {
      if (!subMethod || !details || !details.phoneNumber) {
        return res.status(400).json({ message: 'Missing e-wallet details' });
      }
      
      topUpRequest.subMethod = subMethod;
      topUpRequest.details = {
        phoneNumber: details.phoneNumber
      };
      
      // Save the request first to get an ID
      await topUpRequest.save({ session });
      
      // Generate payment URL based on the selected e-wallet
      let paymentResult;
      
      if (subMethod === 'momo') {
        paymentResult = await createMomoPayment(
          req.user._id.toString(),
          topUpRequest._id.toString(),
          amount,
          `Top-up ${amount}VND to account ${req.user.username}`
        );
      } else if (subMethod === 'zalopay') {
        paymentResult = await createZaloPayPayment(
          req.user._id.toString(),
          topUpRequest._id.toString(),
          amount,
          `Top-up ${amount}VND to account ${req.user.username}`
        );
      } else {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Invalid e-wallet method' });
      }
      
      if (!paymentResult.success) {
        await session.abortTransaction();
        return res.status(500).json({ message: paymentResult.error || 'Failed to create payment' });
      }
      
      // Update request with payment information
      topUpRequest.details.requestId = paymentResult.requestId;
      topUpRequest.details.paymentUrl = paymentResult.paymentUrl;
      await topUpRequest.save({ session });
      
      await session.commitTransaction();
      
      return res.status(200).json({
        message: 'Please complete your payment',
        paymentUrl: paymentResult.paymentUrl,
        requestId: topUpRequest._id
      });
    } else if (paymentMethod === 'bank') {
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
      await topUpRequest.save({ session });
      
      // Update user balance (no bonus)
      await User.findByIdAndUpdate(
        req.user._id,
        { $inc: { balance: topUpRequest.balance } },
        { session }
      );
      
      await session.commitTransaction();
      
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
    console.error('Top-up request failed:', error);
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
        createdAt: request.createdAt
      };
      
      // Add payment method specific details
      if (request.paymentMethod === 'ewallet') {
        formattedRequest.subMethod = request.subMethod;
        formattedRequest.paymentUrl = request.details.paymentUrl;
      } else if (request.paymentMethod === 'bank') {
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
        subMethod: item.subMethod,
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
      } else if (item.paymentMethod === 'ewallet' && item.details) {
        formattedItem.ewalletInfo = {
          provider: item.subMethod
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
    
    // For e-wallet payments, we should check the status with the provider
    // before allowing cancellation, but we'll skip that for simplicity
    
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
      { price: 12000, balance: 100, note: "Chỉ với 12.000đ mỗi tháng bạn sẽ không bao giờ thấy bất kì quảng cáo nào trên page trong cuộc đời này" },
      { price: 20000, balance: 200, note: "Gói bình dân hạt dẻ" },
      { price: 50000, balance: 550, note: "Thêm tí bonus gọi là" },
      { price: 250000, balance: 2800, note: "Với gói này phú hào có thể unlock ngay một tập truyện dịch từ Eng" },
      { price: 350000, balance: 4000, note: "Với gói này đại gia đủ sức bao trọn một tập truyện bất kì dịch từ Jap" }
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

      // Extract the transfer content using regex to find an 8-character alphanumeric string
      const transferContentRegex = /[a-zA-Z0-9]{8}/g;
      const matches = description.match(transferContentRegex);
      
      let actualTransferContent = '';
      
      if (matches && matches.length > 0) {
        // First try to find a match with our specific pattern (mix of uppercase and lowercase letters with numbers)
        const idealPattern = /^[A-Za-z0-9]{8}$/;
        const bestMatch = matches.find(match => 
          idealPattern.test(match) && 
          /[A-Z]/.test(match) && // Has at least one uppercase letter
          /[0-9]/.test(match)    // Has at least one number
        );
        
        actualTransferContent = bestMatch || matches[0];
        
        console.log(`Found potential transfer content: ${actualTransferContent} from description: ${description}`);
      } else {
        // Fallback to the old method if no 8-char codes found
        actualTransferContent = description.split('-').pop();
        console.log(`Using fallback method, extracted: ${actualTransferContent} from: ${description}`);
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
        
        // Try to find any request with this transfer content, even if status isn't Pending
        const anyRequest = await TopUpRequest.findOne({
          'details.transferContent': actualTransferContent,
          'paymentMethod': 'bank'
        });
        
        if (anyRequest) {
          // Store the transaction with the request even if it's not in Pending status
          anyRequest.bankTransactions.push(transactionData);
          anyRequest.receivedAmount += creditAmount;
          await anyRequest.save();
          
          results.push({
            transId,
            status: 'stored',
            message: `Transaction stored with non-pending request: ${anyRequest._id}`,
            requestId: anyRequest._id,
            requestStatus: anyRequest.status
          });
        } else {
          results.push({
            transId,
            status: 'pending_review',
            message: 'No matching topup request found'
          });
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

export default router; 