import mongoose from 'mongoose';

const userChapterInteractionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  chapterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chapter',
    required: true
  },
  novelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  liked: {
    type: Boolean,
    default: false
  },

  bookmarked: {
    type: Boolean,
    default: false
  },
  lastReadAt: {
    type: Date,
    default: null
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

// Create a compound index for userId and chapterId to ensure uniqueness
userChapterInteractionSchema.index({ userId: 1, chapterId: 1 }, { unique: true });

// Create indexes for faster queries
userChapterInteractionSchema.index({ chapterId: 1 });
userChapterInteractionSchema.index({ novelId: 1 });
userChapterInteractionSchema.index({ userId: 1 });
userChapterInteractionSchema.index({ userId: 1, lastReadAt: -1 }); // Index for recently read queries

const UserChapterInteraction = mongoose.model('UserChapterInteraction', userChapterInteractionSchema);
export default UserChapterInteraction; 