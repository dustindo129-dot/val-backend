import mongoose from 'mongoose';

const giftSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  icon: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 1
  },
  order: {
    type: Number,
    required: true
  }
}, {
  timestamps: true
});

// Create index for ordering
giftSchema.index({ order: 1 });

const Gift = mongoose.model('Gift', giftSchema);

export default Gift; 