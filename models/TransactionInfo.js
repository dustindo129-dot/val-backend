import mongoose from 'mongoose';

/**
 * TransactionInfo Schema
 * Stores bank transfer information that hasn't been matched to a TopUpRequest
 * for potential future matching
 */
const transactionInfoSchema = new mongoose.Schema({
  transactionId: {
    type: String,
    required: true,
    unique: true
  },
  description: {
    type: String,
    required: true
  },
  extractedContent: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  bankName: String,
  bankAccount: String,
  date: {
    type: Date,
    default: Date.now
  },
  processed: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Create indexes for efficient querying
transactionInfoSchema.index({ extractedContent: 1 });
transactionInfoSchema.index({ processed: 1 });

const TransactionInfo = mongoose.model('TransactionInfo', transactionInfoSchema);

export default TransactionInfo; 