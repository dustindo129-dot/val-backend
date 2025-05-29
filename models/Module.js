import mongoose from 'mongoose';

const moduleSchema = new mongoose.Schema({
  novelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  title: {
    type: String,
    required: true
  },
  illustration: {
    type: String,
    default: 'https://Valvrareteam.b-cdn.net/defaults/missing-image.png'
  },
  chapters: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chapter'
  }],
  order: {
    type: Number,
    required: true
  },
  mode: {
    type: String,
    enum: ['published', 'paid'],
    default: 'published'
  },
  moduleBalance: {
    type: Number,
    default: 0,
    validate: {
      validator: function(value) {
        // If mode is 'paid', moduleBalance must be at least 1
        if (this.mode === 'paid' && value < 1) {
          return false;
        }
        return value >= 0;
      },
      message: 'Số lượng lúa cần để mở tập phải tối thiểu là 1 🌾'
    }
  }
}, {
  timestamps: true
});

// Create a compound index for novelId and order to ensure unique ordering within a novel
moduleSchema.index({ novelId: 1, order: 1 }, { unique: true });

const Module = mongoose.model('Module', moduleSchema);

export default Module;