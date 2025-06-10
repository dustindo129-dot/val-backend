import mongoose from 'mongoose';

/**
 * Request Schema
 * Represents user requests for new novels or chapter openings
 * with deposit functionality for request processing
 */
const requestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['new', 'open', 'web'],
    required: true
  },
  title: {
    type: String,
    trim: true
  },
  note: {
    type: String,
    trim: true
  },
  novel: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: false
  },
  module: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module'
  },
  chapter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chapter'
  },
  deposit: {
    type: Number,
    required: true,
    min: 0
  },
  goalBalance: {
    type: Number,
    default: 1000,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'declined'],
    default: 'pending'
  },
  openNow: {
    type: Boolean,
    default: false
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
}, {
  timestamps: true
});

// Create index for more efficient queries
requestSchema.index({ user: 1, status: 1 });
requestSchema.index({ type: 1, status: 1 });

const Request = mongoose.model('Request', requestSchema);

export default Request; 