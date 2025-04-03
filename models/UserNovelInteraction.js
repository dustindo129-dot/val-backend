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

// Create a compound index to ensure each user can only have one interaction record per novel
userNovelInteractionSchema.index({ userId: 1, novelId: 1 }, { unique: true });

export default mongoose.model('UserNovelInteraction', userNovelInteractionSchema); 