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
  userNumber: {
    type: Number
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
    maxlength: 10000
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
userSchema.index({ userNumber: 1 }, { unique: true, background: true });

/**
 * Pre-save middleware to hash password and set displayName default
 * Only hashes password if it has been modified
 * Sets displayName to username if not provided
 * Auto-assigns userNumber for new users
 */
userSchema.pre('save', async function(next) {
  // Auto-assign userNumber for new users
  if (this.isNew && !this.userNumber) {
    let retries = 0;
    const maxRetries = 5;
    
    while (retries < maxRetries) {
      try {
        // Find the highest userNumber and increment by 1
        const lastUser = await mongoose.model('User').findOne({}, { userNumber: 1 }, { sort: { userNumber: -1 } });
        const nextUserNumber = lastUser ? lastUser.userNumber + 1 : 1;
        
        // Check if this userNumber is already taken
        const existingUser = await mongoose.model('User').findOne({ userNumber: nextUserNumber });
        if (!existingUser) {
          this.userNumber = nextUserNumber;
          break;
        } else {
          // If taken, increment and try again
          retries++;
          continue;
        }
      } catch (error) {
        return next(error);
      }
    }
    
    // If we couldn't find an available userNumber after retries, generate a timestamp-based one
    if (!this.userNumber) {
      this.userNumber = Date.now() % 1000000; // Use last 6 digits of timestamp
    }
  }
  
  // Set displayName to username if not provided
  if (!this.displayName) {
    this.displayName = this.username;
  }
  
  // Validate displayName format if it's being modified
  if (this.isModified('displayName')) {
    // Allow letters, numbers, spaces, and Vietnamese characters, but no special characters
    const displayNameRegex = /^[a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s]+$/;
    if (!displayNameRegex.test(this.displayName)) {
      const error = new Error('Tên hiển thị chỉ được chứa chữ cái, số và khoảng trắng. Không được chứa ký tự đặc biệt.');
      return next(error);
    }
    
    // Trim multiple spaces and normalize
    this.displayName = this.displayName.replace(/\s+/g, ' ').trim();
    
    // Check for duplicate displayName (case-insensitive)
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