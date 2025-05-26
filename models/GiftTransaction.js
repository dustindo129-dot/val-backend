import mongoose from 'mongoose';

const giftTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  novelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  giftId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gift',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  userBalanceBefore: {
    type: Number,
    required: true
  },
  userBalanceAfter: {
    type: Number,
    required: true
  },
  novelBalanceBefore: {
    type: Number,
    required: true
  },
  novelBalanceAfter: {
    type: Number,
    required: true
  }
}, {
  timestamps: true
});

// Create indexes for efficient queries
giftTransactionSchema.index({ userId: 1, createdAt: -1 });
giftTransactionSchema.index({ novelId: 1, createdAt: -1 });
giftTransactionSchema.index({ createdAt: -1 });

const GiftTransaction = mongoose.model('GiftTransaction', giftTransactionSchema);

export default GiftTransaction; 