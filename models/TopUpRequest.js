import mongoose from 'mongoose';

/**
 * TopUpRequest Schema
 * Represents a user-initiated request to top-up their account balance
 */
const topUpRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  balance: {
    type: Number,
    required: true,
    min: 0
  },
  bonus: {
    type: Number,
    default: 0,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ['ewallet', 'bank', 'prepaidCard'],
    required: true
  },
  subMethod: {
    type: String,
    enum: ['momo', 'zalopay', null]
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    default: {
      actualAmount: 0
    }
  },
  status: {
    type: String,
    enum: ['Pending', 'Completed', 'Failed', 'Cancelled'],
    default: 'Pending'
  },
  notes: {
    type: String
  },
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Create index for more efficient queries
topUpRequestSchema.index({ user: 1, createdAt: -1 });
topUpRequestSchema.index({ status: 1 });
topUpRequestSchema.index({ paymentMethod: 1 });

const TopUpRequest = mongoose.model('TopUpRequest', topUpRequestSchema);

export default TopUpRequest; 