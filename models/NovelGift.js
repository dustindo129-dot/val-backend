import mongoose from 'mongoose';

const novelGiftSchema = new mongoose.Schema({
  novelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  giftId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gift',
    required: true
  },
  count: {
    type: Number,
    default: 0,
    min: 0
  }
}, {
  timestamps: true
});

// Create compound index for novelId and giftId to ensure uniqueness
novelGiftSchema.index({ novelId: 1, giftId: 1 }, { unique: true });

const NovelGift = mongoose.model('NovelGift', novelGiftSchema);

export default NovelGift; 