import mongoose from 'mongoose';

/**
 * ContributionHistory Schema
 * Represents user contributions to novel budgets
 * This is separate from the market request contributions
 */
const contributionHistorySchema = new mongoose.Schema({
  novelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Can be null for system actions
  },
  amount: {
    type: Number,
    required: true
  },
  note: {
    type: String,
    trim: true,
    default: ''
  },
  budgetAfter: {
    type: Number,
    required: true,
    min: 0
  },
  balanceAfter: {
    type: Number,
    required: false, // Optional for backward compatibility
    min: 0
  },
  type: {
    type: String,
    enum: ['user', 'system', 'admin', 'gift'],
    default: 'user'
  }
}, {
  timestamps: true
});

// Create indexes for efficient queries
contributionHistorySchema.index({ novelId: 1, createdAt: -1 });
contributionHistorySchema.index({ userId: 1, createdAt: -1 });
contributionHistorySchema.index({ novelId: 1, type: 1 });

const ContributionHistory = mongoose.model('ContributionHistory', contributionHistorySchema);

export default ContributionHistory; 