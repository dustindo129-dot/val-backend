import mongoose from 'mongoose';

const reportSchema = new mongoose.Schema({
  reporter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  contentType: {
    type: String,
    enum: ['chapter', 'novel', 'comment'],
    required: true
  },
  contentId: {
    type: String,
    required: true
  },
  contentTitle: {
    type: String,
    default: 'Untitled Content'
  },
  novelId: {
    type: String,
    default: null
  },
  reportType: {
    type: String,
    enum: ['Translation error', 'Inappropriate content', 'Formatting issue', 'Other'],
    required: true
  },
  details: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['pending', 'resolved'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for efficient querying
reportSchema.index({ reporter: 1, contentType: 1, contentId: 1 });
reportSchema.index({ status: 1 });

const Report = mongoose.model('Report', reportSchema);

export default Report; 