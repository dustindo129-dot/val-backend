import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Helper function to escape regex special characters
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * User Schema
 * Represents a user in the system with authentication, profile, and preferences
 * Includes password hashing, role-based access, and account verification
 */
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    trim: true,
    minlength: 3,
    maxlength: 20
  },
  displayName: {
    type: String,
    trim: true
  },
  displayNameLastChanged: {
    type: Date,
    default: null
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    validate: {
      validator: function(v) {
        // Ensure email is not the same as username
        return v !== this.username;
      },
      message: 'Email không được giống với tên người dùng'
    }
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  avatar: {
    type: String,
    default: 'https://Valvrareteam.b-cdn.net/defaults/default-avatar.png'
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'moderator', 'pj_user'],
    default: 'user'
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  isBanned: {
    type: Boolean,
    default: false
  },
  blockedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    validate: {
      validator: function(v) {
        return this.blockedUsers.length <= 50;
      },
      message: 'Cannot block more than 50 users'
    }
  }],
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Novel'
  }],
  intro: {
    type: String,
    default: '',
    maxlength: 2000
  },
  ongoingModules: [{
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  completedModules: [{
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date
  },
  currentSessionId: {
    type: String,
    default: null
  },
  deviceSessions: {
    type: Map,
    of: {
      sessionId: String,
      lastAccess: Date,
      userAgent: String,
      ip: String
    },
    default: new Map()
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  pendingEmailChange: {
    newEmail: String,
    token: String,
    expires: Date
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  visitors: {
    total: { type: Number, default: 0 }
  },
  interests: {
    type: [String],
    default: [],
    validate: {
      validator: function(interests) {
        return interests.length <= 20; // Limit to 20 interests
      },
      message: 'Cannot have more than 20 interests'
    }
  }
}, {
  timestamps: true
});

// Create unique indexes for username, email, and displayName
userSchema.index({ username: 1 }, { unique: true, background: true });
userSchema.index({ email: 1 }, { unique: true, background: true });
userSchema.index({ displayName: 1 }, { unique: true, sparse: true, background: true });

/**
 * Pre-save middleware to hash password and set displayName default
 * Only hashes password if it has been modified
 * Sets displayName to username if not provided
 */
userSchema.pre('save', async function(next) {
  // Set displayName to username if not provided
  if (!this.displayName) {
    this.displayName = this.username;
  }
  
  // Check for duplicate displayName if it's being modified (case-insensitive)
  if (this.isModified('displayName')) {
    const existingUser = await mongoose.model('User').findOne({
      displayName: { $regex: new RegExp(`^${escapeRegex(this.displayName)}$`, 'i') },
      _id: { $ne: this._id }
    });
    
    if (existingUser) {
      const error = new Error('Tên hiển thị đã tồn tại');
      error.code = 11000; // Duplicate key error code
      return next(error);
    }
  }
  
  // Only hash password if it has been modified
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Method to compare password for login
 * @param {string} candidatePassword - The password to compare against
 * @returns {Promise<boolean>} True if passwords match, false otherwise
 */
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Method to increment visitor count
 * Tracks total visitors to the user's profile
 */
userSchema.methods.incrementVisitors = async function() {
  this.visitors.total += 1;
  return this.save();
};

const User = mongoose.model('User', userSchema);

export default User; 