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
    enum: ['Pending', 'Completed', 'Failed'],
    default: 'Completed'
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// Create index for more efficient queries
topUpAdminSchema.index({ user: 1, createdAt: -1 });
topUpAdminSchema.index({ admin: 1, createdAt: -1 });
topUpAdminSchema.index({ status: 1 });

const TopUpAdmin = mongoose.model('TopUpAdmin', topUpAdminSchema);

export default TopUpAdmin; 