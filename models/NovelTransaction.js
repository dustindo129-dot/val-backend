import mongoose from 'mongoose';

/**
 * NovelTransaction Schema
 * Tracks all changes to novel balances
 */
const novelTransactionSchema = new mongoose.Schema({
  novel: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  type: {
    type: String,
    enum: ['request', 'open', 'admin', 'contribution', 'gift_received', 'rental', 'other'],
    required: true
  },
  description: {
    type: String,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'sourceModel'
  },
  sourceModel: {
    type: String,
    enum: ['Request', 'Contribution', 'User', 'GiftTransaction', 'ModuleRental', null]
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Create indexes for efficient querying
novelTransactionSchema.index({ novel: 1, createdAt: -1 });
novelTransactionSchema.index({ type: 1 });
novelTransactionSchema.index({ createdAt: -1 });

const NovelTransaction = mongoose.model('NovelTransaction', novelTransactionSchema);

export default NovelTransaction; 