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
// Create a compound index for moduleId and order to ensure unique ordering within a module
chapterSchema.index({ moduleId: 1, order: 1 }, { unique: true });

const Chapter = mongoose.model('Chapter', chapterSchema);
export default Chapter; 