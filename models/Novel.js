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
  // SEO-friendly slug and short id suffix for fast lookups
  slug: { type: String, unique: true, trim: true, lowercase: true },
  shortId8: { type: String, index: true, trim: true, lowercase: true },
  active: {
    pj_user: [{ type: mongoose.Schema.Types.Mixed }],
    translator: [{ type: mongoose.Schema.Types.Mixed }],
    editor: [{ type: mongoose.Schema.Types.Mixed }],
    proofreader: [{ type: mongoose.Schema.Types.Mixed }]
  },
  inactive: {
    pj_user: [{ type: String }],
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
  novelBudget: { 
    type: Number, 
    default: 0,
    min: 0
  },
  wordCount: {
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
  mode: {
    type: String,
    enum: ['published', 'draft'],
    default: 'published'
  },
  ttsEnabled: {
    type: Boolean,
    default: false
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  toJSON: { getters: true },
  toObject: { getters: true }
});

// Indexes are defined via field options above (slug unique index, shortId8 indexed)

// Helper to build a URL-friendly slug base from a title
function slugifyTitle(title) {
  if (!title || typeof title !== 'string') return 'novel';
  return title
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80) || 'novel';
}

// Ensure slug and shortId8 are set consistently
novelSchema.pre('save', function(next) {
  try {
    const idStr = this._id ? this._id.toString() : '';
    if (!this.shortId8 && idStr.length === 24) {
      this.shortId8 = idStr.slice(-8).toLowerCase();
    }
    if (!this.slug && idStr.length === 24) {
      const base = slugifyTitle(this.title);
      const suffix = this.shortId8 || idStr.slice(-8).toLowerCase();
      this.slug = `${base}-${suffix}`;
    }
    if (this.slug) {
      this.slug = this.slug.toLowerCase();
    }
    if (this.shortId8) {
      this.shortId8 = this.shortId8.toLowerCase();
    }
    next();
  } catch (e) {
    next(e);
  }
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