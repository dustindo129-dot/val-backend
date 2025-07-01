import mongoose from 'mongoose';

/**
 * ModuleRental Schema
 * Tracks user module rentals with 24-hour access periods
 */
const moduleRentalSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  moduleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
    required: true
  },
  novelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel',
    required: true
  },
  amountPaid: {
    type: Number,
    required: true,
    min: 0
  },
  startTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  endTime: {
    type: Date,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Reference to the contribution history record
  contributionHistoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ContributionHistory',
    required: false
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
// 1. Compound index to prevent duplicate active rentals
moduleRentalSchema.index({ userId: 1, moduleId: 1, isActive: 1 }, { 
  unique: true,
  partialFilterExpression: { isActive: true }
});

// 2. Index for cleanup operations
moduleRentalSchema.index({ isActive: 1, endTime: 1 });

// 3. Index for novel-based queries
moduleRentalSchema.index({ novelId: 1 });

// 4. Index for user-based queries
moduleRentalSchema.index({ userId: 1, isActive: 1 });

// 5. Index for module-based queries
moduleRentalSchema.index({ moduleId: 1, isActive: 1 });

// Pre-save hook to set endTime (24 hours from startTime)
moduleRentalSchema.pre('save', function(next) {
  if (this.isNew && !this.endTime) {
    // Set endTime to 24 hours (24 * 60 * 60 * 1000 milliseconds) from startTime
    this.endTime = new Date(this.startTime.getTime() + (24 * 60 * 60 * 1000));
  }
  next();
});

// Instance method to check if rental is still valid
moduleRentalSchema.methods.isValid = function() {
  return this.isActive && new Date() < this.endTime;
};

// Instance method to expire the rental
moduleRentalSchema.methods.expire = function() {
  this.isActive = false;
  return this.save();
};

// Static method to find active rentals for a user
moduleRentalSchema.statics.findActiveRentalsForUser = function(userId) {
  return this.find({
    userId,
    isActive: true,
    endTime: { $gt: new Date() }
  });
};

// Static method to find active rental for specific user and module
moduleRentalSchema.statics.findActiveRentalForUserModule = function(userId, moduleId) {
  return this.findOne({
    userId,
    moduleId,
    isActive: true,
    endTime: { $gt: new Date() }
  });
};

// Static method to cleanup expired rentals
moduleRentalSchema.statics.cleanupExpiredRentals = async function() {
  const now = new Date();
  const result = await this.updateMany(
    {
      isActive: true,
      endTime: { $lte: now }
    },
    {
      $set: { isActive: false }
    }
  );
  return result;
};

const ModuleRental = mongoose.model('ModuleRental', moduleRentalSchema);

export default ModuleRental; 