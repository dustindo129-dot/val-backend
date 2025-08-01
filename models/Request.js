import mongoose from 'mongoose';

/**
 * Request Schema
 * Represents user requests for new novels
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
    enum: ['new', 'web'],
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
  contactInfo: {
    type: String,
    trim: true
  },
  illustration: {
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
    enum: ['pending', 'approved', 'declined', 'withdrawn'],
    default: 'pending'
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isEdited: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Create index for more efficient queries
requestSchema.index({ user: 1, status: 1 });
requestSchema.index({ type: 1, status: 1 });

const Request = mongoose.model('Request', requestSchema);

export default Request; 