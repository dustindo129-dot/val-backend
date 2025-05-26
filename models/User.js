import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * User Schema
 * Represents a user in the system with authentication, profile, and preferences
 * Includes password hashing, role-based access, and account verification
 */
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    trim: true
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
    lowercase: true
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
    enum: ['user', 'admin', 'moderator'],
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
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  isVerified: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Create unique indexes for username and email
userSchema.index({ username: 1 }, { unique: true, background: true });
userSchema.index({ email: 1 }, { unique: true, background: true });

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

const User = mongoose.model('User', userSchema);

export default User; 