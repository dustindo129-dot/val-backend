import mongoose from 'mongoose';

const chapterSchema = new mongoose.Schema({
  novelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  moduleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
    required: true
  },
  title: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  },
  order: {
    type: Number,
    required: true
  },
  translator: {
    type: String,
    default: ''
  },
  editor: {
    type: String,
    default: ''
  },
  proofreader: {
    type: String,
    default: ''
  },
  mode: {
    type: String,
    enum: ['published', 'draft', 'protected', 'paid'],
    default: 'published'
  },
  views: {
    type: Number,
    default: 0
  },
  footnotes: [{
    id: {
      type: Number,
      required: true
    },
    content: {
      type: String,
      required: true
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for faster queries
chapterSchema.index({ novelId: 1 });
// Index for moduleId and order, but not unique across all modules
chapterSchema.index({ moduleId: 1, order: 1 });

// Simplified method to increment views
chapterSchema.methods.incrementViews = async function() {
  this.views++;
  return this.save();
};

const Chapter = mongoose.model('Chapter', chapterSchema);
export default Chapter; 