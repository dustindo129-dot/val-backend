import mongoose from 'mongoose';

const donationSchema = new mongoose.Schema({
  content: {
    type: String,
    default: ''
  },
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true // This will automatically handle createdAt and updatedAt
});

// Create a text index on content for potential future text search
donationSchema.index({ content: 'text' });

const Donation = mongoose.model('Donation', donationSchema);

export default Donation; 