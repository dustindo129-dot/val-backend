import mongoose from 'mongoose';

/**
 * Contribution Schema
 * Represents user contributions to market requests
 */
const contributionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  request: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Request',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  note: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'declined'],
    default: 'pending'
  }
}, {
  timestamps: true
});

// Create index for more efficient queries
contributionSchema.index({ request: 1, status: 1 });
contributionSchema.index({ user: 1, status: 1 });

const Contribution = mongoose.model('Contribution', contributionSchema);

export default Contribution; 