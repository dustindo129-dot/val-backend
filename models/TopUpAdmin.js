import mongoose from 'mongoose';

/**
 * TopUpAdmin Schema
 * Represents a transaction where an admin adds balance to a user's account
 */
const topUpAdminSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['Pending', 'Completed', 'Failed', 'Revoked'],
    default: 'Completed'
  },
  notes: {
    type: String
  },
  revokedAt: {
    type: Date
  },
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Create index for more efficient queries
topUpAdminSchema.index({ user: 1, createdAt: -1 });
topUpAdminSchema.index({ admin: 1, createdAt: -1 });
topUpAdminSchema.index({ status: 1 });
topUpAdminSchema.index({ revokedBy: 1, revokedAt: -1 });

const TopUpAdmin = mongoose.model('TopUpAdmin', topUpAdminSchema);

export default TopUpAdmin; 