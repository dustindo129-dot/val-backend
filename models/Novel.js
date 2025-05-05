import mongoose from 'mongoose';

/**
 * Novel Schema
 * Represents a novel with chapters, view tracking, and status management
 * Includes automatic timestamp updates and view counting functionality
 */
const novelSchema = new mongoose.Schema({
  title: { type: String, required: true },
  alternativeTitles: [{ type: String }],
  author: { type: String, required: true },
  illustrator: { type: String },
  active: {
    translator: [{ type: String }],
    editor: [{ type: String }],
    proofreader: [{ type: String }]
  },
  inactive: {
    translator: [{ type: String }],
    editor: [{ type: String }],
    proofreader: [{ type: String }]
  },
  genres: [{ type: String }],
  description: { type: String, required: true },
  note: { type: String },
  illustration: { 
    type: String,
    default: 'https://Valvrareteam.b-cdn.net/defaults/missing-image.png'
  },
  novelBalance: { 
    type: Number, 
    default: 0,
    min: 0
  },
  views: {
    total: { type: Number, default: 0 },
    daily: [{
      date: { type: Date, default: Date.now },
      count: { type: Number, default: 0 }
    }]
  },
  status: {
    type: String,
    enum: ['Ongoing', 'Completed', 'Hiatus'],
    default: 'Ongoing'
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  toJSON: { getters: true },
  toObject: { getters: true }
});

/**
 * Method to increment view count
 * Tracks both total views and daily views
 * Maintains a 7-day history of daily views
 */
novelSchema.methods.incrementViews = async function() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let dailyView = this.views.daily.find(view => 
    view.date.getTime() === today.getTime()
  );

  if (!dailyView) {
    // Remove views older than 7 days
    this.views.daily = this.views.daily.filter(view => 
      view.date > new Date(today - 7 * 24 * 60 * 60 * 1000)
    );
    
    this.views.daily.push({
      date: today,
      count: 1
    });
  } else {
    dailyView.count += 1;
  }

  this.views.total += 1;
  return this.save();
};

export default mongoose.model('Novel', novelSchema); 