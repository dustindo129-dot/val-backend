import mongoose from 'mongoose';

/**
 * UserNovelInteraction Schema
 * Tracks user interactions with novels (likes, ratings, etc.)
 */
const userNovelInteractionSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
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
  rating: { 
    type: Number, 
    min: 1, 
    max: 5,
    default: null 
  },
  review: {
    type: String,
    default: null,
    maxlength: 1000
  },
  bookmarked: {
    type: Boolean,
    default: false
  },
  followed: {
    type: Boolean,
    default: false
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
  toJSON: { getters: true },
  toObject: { getters: true }
});

// Create indexes for better query performance
userNovelInteractionSchema.index({ userId: 1, novelId: 1 }, { unique: true });
userNovelInteractionSchema.index({ novelId: 1 });
userNovelInteractionSchema.index({ novelId: 1, liked: 1 });
userNovelInteractionSchema.index({ novelId: 1, rating: 1 });
userNovelInteractionSchema.index({ novelId: 1, bookmarked: 1 });
userNovelInteractionSchema.index({ userId: 1, bookmarked: 1 });
userNovelInteractionSchema.index({ novelId: 1, review: 1, updatedAt: -1 });

export default mongoose.model('UserNovelInteraction', userNovelInteractionSchema); 