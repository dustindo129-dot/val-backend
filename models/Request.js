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
    enum: ['new', 'open'],
    required: true
  },
  text: {
    type: String,
    required: true,
    trim: true
  },
  novel: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: function() {
      return this.type === 'open';
    }
  },
  deposit: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'declined'],
    default: 'pending'
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  replies: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    text: {
      type: String,
      required: true,
      trim: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Create index for more efficient queries
requestSchema.index({ user: 1, status: 1 });
requestSchema.index({ type: 1, status: 1 });

const Request = mongoose.model('Request', requestSchema);

export default Request; 