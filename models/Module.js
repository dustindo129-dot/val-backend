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
  coverImage: {
    type: String,
    default: 'https://res.cloudinary.com/dvoytcc6b/image/upload/v1743234203/%C6%A0_l%E1%BB%97i_h%C3%ACnh_m%E1%BA%A5t_r%E1%BB%93i_n8zdtv.png'
  },
  chapters: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chapter'
  }],
  order: {
    type: Number,
    required: true
  }
}, {
  timestamps: true
});

// Create a compound index for novelId and order to ensure unique ordering within a novel
moduleSchema.index({ novelId: 1, order: 1 }, { unique: true });

const Module = mongoose.model('Module', moduleSchema);

export default Module;