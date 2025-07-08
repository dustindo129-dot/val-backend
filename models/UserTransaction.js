import mongoose from 'mongoose';

/**
 * UserTransaction Schema
 * Unified ledger to track all user balance changes (both additions and deductions)
 */
const userTransactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  type: {
    type: String,
    enum: ['topup', 'admin_topup', 'request', 'contribution', 'refund', 'gift', 'rental', 'other'],
    required: true,
    index: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'sourceModel'
  },
  sourceModel: {
    type: String,
    enum: ['TopUpRequest', 'TopUpAdmin', 'Request', 'Contribution', 'Novel', 'GiftTransaction', 'ModuleRental', null]
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Create indexes for efficient querying
userTransactionSchema.index({ createdAt: -1 });
userTransactionSchema.index({ 'user': 1, 'createdAt': -1 });
userTransactionSchema.index({ 'type': 1, 'createdAt': -1 });

const UserTransaction = mongoose.model('UserTransaction', userTransactionSchema);

export default UserTransaction; 