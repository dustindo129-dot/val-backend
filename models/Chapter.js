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

// Atomic increment operation for views to prevent race conditions
chapterSchema.methods.incrementViews = async function() {
  // Use findOneAndUpdate with $inc for atomic operation
  const updatedChapter = await mongoose.model('Chapter').findOneAndUpdate(
    { _id: this._id },
    { $inc: { views: 1 } },
    { new: true } // Return the updated document
  );
  
  // Update this instance with the new view count
  if (updatedChapter) {
    this.views = updatedChapter.views;
  }
  
  return updatedChapter;
};

const Chapter = mongoose.model('Chapter', chapterSchema);
export default Chapter; 