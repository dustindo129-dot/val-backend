import express from 'express';
import User from '../models/User.js';
import { generateToken, auth } from '../middleware/auth.js';
import { getCachedUserByUsername, clearAllUserCaches } from '../utils/userCache.js';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendPasswordResetEmail } from '../services/emailService.js';

const router = express.Router();

/**
 * Register a new admin user
 * Protected by admin code verification
 * @route POST /api/auth/register-admin
 */
router.post('/register-admin', async (req, res) => {
  try {
    const { username, email, password, adminCode } = req.body;

    // Verify admin code
    if (adminCode !== process.env.ADMIN_CODE) {
      return res.status(403).json({ message: 'Invalid admin code' });
    }

    // Validate username format (only for new signups)
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ 
        message: 'Tên người dùng chỉ được chứa chữ cái, số và dấu gạch dưới (_), độ dài từ 3-20 ký tự.'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(400).json({ message: 'Email already exists' });
      }
      return res.status(400).json({ message: 'Username already exists' });
    }

    // Create new admin user
    const user = new User({
      username,
      email,
      password,
      role: 'admin'
    });

    await user.save();

    // Create device fingerprint and session ID for single-device authentication (IP only)
    const deviceFingerprint = crypto
      .createHash('sha256')
      .update(`${req.ip || 'unknown'}`)
      .digest('hex')
      .substring(0, 16);
    
    const baseSessionId = crypto.randomBytes(16).toString('hex');
    const sessionId = `${deviceFingerprint}-${baseSessionId}`;
    
    user.currentSessionId = sessionId;
    await user.save();

    // Create token
    const token = jwt.sign(
      { userId: user._id, username: user.username, role: user.role, sessionId: sessionId, deviceFingerprint: deviceFingerprint },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Generate refresh token
    const refreshToken = jwt.sign(
      { 
        userId: user._id, 
        sessionId: sessionId,
        deviceFingerprint: deviceFingerprint
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ 
      token, 
      refreshToken,
      user: { 
        _id: user._id, 
        username: user.username, 
        displayName: user.displayName, 
        userNumber: user.userNumber,
        email: user.email, 
        role: user.role, 
        displayNameLastChanged: user.displayNameLastChanged 
      } 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * Register a new regular user
 * @route POST /api/auth/signup
 */
router.post('/signup', async (req, res) => {
  try {
    console.log('\n--- Starting signup process ---');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle both name and username fields
    const username = req.body.username || req.body.name;
    const { email, password } = req.body;

    if (!username) {
      return res.status(400).json({ message: 'Username is required' });
    }

    // Validate username format (only for new signups)
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ 
        message: 'Tên người dùng chỉ được chứa chữ cái, số và dấu gạch dưới (_), độ dài từ 3-20 ký tự.'
      });
    }

    // First check username separately using cached lookup
    const existingUsername = await getCachedUserByUsername(username);
    if (existingUsername) {
      console.log('Username exists:', username);
      return res.status(400).json({ message: 'Username already exists' });
    }

    // Then check email separately (direct query as emails are not frequently cached)
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      console.log('Email exists:', email);
      return res.status(400).json({ message: 'Email already exists' });
    }

    console.log('Creating new user document...');
    const user = new User({
      username,
      email,
      password,
      role: 'user'
    });
    console.log('User document created:', JSON.stringify(user.toObject(), null, 2));

    console.log('Attempting to save user...');
    const savedUser = await user.save();
    console.log('User saved successfully. ID:', savedUser._id);

    // Check if user is banned (in case they were banned before)
    if (savedUser.isBanned) {
      // Delete the newly created user if they were somehow marked as banned
      await User.findByIdAndDelete(savedUser._id);
      return res.status(403).json({ 
        message: 'Account creation failed. Please contact support.',
        code: 'ACCOUNT_BANNED'
      });
    }

    // Create device fingerprint and session ID for single-device authentication (IP only)
    const deviceFingerprint = crypto
      .createHash('sha256')
      .update(`${req.ip || 'unknown'}`)
      .digest('hex')
      .substring(0, 16);
    
    const baseSessionId = crypto.randomBytes(16).toString('hex');
    const sessionId = `${deviceFingerprint}-${baseSessionId}`;
    
    savedUser.currentSessionId = sessionId;
    await savedUser.save();

    const token = jwt.sign(
      { userId: user._id, username: user.username, role: user.role, sessionId: sessionId, deviceFingerprint: deviceFingerprint },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Generate refresh token
    const refreshToken = jwt.sign(
      { 
        userId: user._id, 
        sessionId: sessionId,
        deviceFingerprint: deviceFingerprint
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    console.log('JWT token generated');

    console.log('Sending success response...');
    res.status(201).json({ 
      token,
      refreshToken,
      user: { 
        _id: user._id, 
        username: user.username,
        displayName: user.displayName,
        userNumber: user.userNumber,
        email: user.email, 
        role: user.role,
        avatar: user.avatar,
        balance: user.balance || 0,
        displayNameLastChanged: user.displayNameLastChanged
      } 
    });
    console.log('--- Signup process completed ---\n');
  } catch (error) {
    console.error('Error in signup process:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ message: error.message });
  }
});

/**
 * Login user and return JWT token
 * Accepts both username and email as login identifier
 * @route POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Find user by username OR email
    const user = await User.findOne({ 
      $or: [
        { username: username },
        { email: username }
      ]
    });
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Check password using the model's method
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Check if user is banned
    if (user.isBanned) {
      return res.status(403).json({ 
        message: 'Your account has been banned. Please contact support if you believe this is an error.',
        code: 'ACCOUNT_BANNED'
      });
    }

    // Create device fingerprint based on IP only (allows multiple browsers on same device)
    const deviceFingerprint = crypto
      .createHash('sha256')
      .update(`${req.ip || 'unknown'}`)
      .digest('hex')
      .substring(0, 16);

    // Generate session ID that includes device fingerprint
    const baseSessionId = crypto.randomBytes(16).toString('hex');
    const sessionId = `${deviceFingerprint}-${baseSessionId}`;
    
    // Check if user already has a session from this device
    const existingSessionFromDevice = user.currentSessionId && 
      user.currentSessionId.startsWith(deviceFingerprint);
    
    // Update last login and set current session ID
    user.lastLogin = new Date();
    user.currentSessionId = sessionId;
    
    // Store device info for session management
    if (!user.deviceSessions) {
      user.deviceSessions = new Map();
    }
    user.deviceSessions.set(deviceFingerprint, {
      sessionId: sessionId,
      lastAccess: new Date(),
      userAgent: req.headers['user-agent'] || 'unknown',
      ip: req.ip || 'unknown'
    });
    
    await user.save();

    // Create token with both userId, username, and sessionId
    const token = jwt.sign(
      { 
        userId: user._id, 
        username: user.username, 
        role: user.role,
        sessionId: sessionId,
        deviceFingerprint: deviceFingerprint
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Generate refresh token
    const refreshToken = jwt.sign(
      { 
        userId: user._id, 
        sessionId: sessionId,
        deviceFingerprint: deviceFingerprint
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ 
      token,
      refreshToken,
      user: { 
        _id: user._id, 
        username: user.username,
        displayName: user.displayName,
        userNumber: user.userNumber,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        balance: user.balance || 0,
        displayNameLastChanged: user.displayNameLastChanged
      } 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'An error occurred during login' });
  }
});

/**
 * Sign out user by clearing the token cookie and session ID
 * @route POST /api/auth/logout
 */
router.post('/logout', auth, async (req, res) => {
  try {
    // Clear the current session ID from the user
    const user = await User.findById(req.user.id);
    if (user) {
      user.currentSessionId = null;
      await user.save();
      
      // Clear all user caches after logout
      clearAllUserCaches(user);
    }

    res.cookie('token', '', {
      httpOnly: true,
      expires: new Date(0)
    });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'An error occurred during logout' });
  }
});

/**
 * Check if current session is valid
 * @route GET /api/auth/check-session
 */
router.get('/check-session', auth, async (req, res) => {
  try {
    // If we reach here, the session is valid (auth middleware passed)
    res.json({ 
      valid: true, 
      user: {
        id: req.user._id,
        username: req.user.username,
        displayName: req.user.displayName,
        userNumber: req.user.userNumber,
        role: req.user.role
      }
    });
  } catch (error) {
    console.error('Session check error:', error);
    res.status(500).json({ message: 'Error checking session' });
  }
});

/**
 * Refresh JWT token using refresh token with session validation
 * @route POST /api/auth/refresh
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token required' });
    }

    // For now, we'll treat refresh tokens the same as access tokens
    // In a production system, you'd want separate refresh token validation
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    } catch (tokenError) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    // Get user and validate session
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Check if user is banned
    if (user.isBanned) {
      return res.status(403).json({ 
        message: 'Your account has been banned. Please contact support if you believe this is an error.',
        code: 'ACCOUNT_BANNED'
      });
    }

    // Create device fingerprint for refresh request (IP only)
    const deviceFingerprint = crypto
      .createHash('sha256')
      .update(`${req.ip || 'unknown'}`)
      .digest('hex')
      .substring(0, 16);

    // Enhanced session validation with device fingerprinting for refresh
    if (decoded.sessionId && user.currentSessionId) {
      const tokenDeviceFingerprint = decoded.deviceFingerprint || decoded.sessionId.split('-')[0];
      const isSameDevice = tokenDeviceFingerprint === deviceFingerprint;
      
      // MODIFIED: Allow multiple device logins - only check session age, not device matching
      // This allows users to refresh tokens from multiple devices simultaneously
      
      // Check if the session is reasonably recent (within last 24 hours)
      const tokenIssueTime = decoded.iat * 1000;
      const now = Date.now();
      const sessionAge = now - tokenIssueTime;
      const maxSessionAge = 24 * 60 * 60 * 1000; // 24 hours
      
      if (sessionAge > maxSessionAge) {
        return res.status(401).json({ 
          message: 'Session expired - please login again',
          code: 'SESSION_EXPIRED'
        });
      }
      
      // Optional: Log multi-device token refresh for monitoring (but don't block)
      if (!isSameDevice) {
        console.log(`Multi-device token refresh: user ${user.username} from ${req.ip} (different from registered device)`);
      }
    }

    // Generate new token with device fingerprint
    const token = jwt.sign(
      { 
        userId: user._id, 
        username: user.username, 
        role: user.role,
        sessionId: user.currentSessionId,
        deviceFingerprint: deviceFingerprint
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Generate new refresh token
    const newRefreshToken = jwt.sign(
      { 
        userId: user._id, 
        sessionId: user.currentSessionId,
        deviceFingerprint: deviceFingerprint
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ 
      token,
      refreshToken: newRefreshToken,
      user: {
        _id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        balance: user.balance || 0,
        displayNameLastChanged: user.displayNameLastChanged
      }
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ message: 'Error refreshing token' });
  }
});

/**
 * Refresh JWT token with session validation
 * @route POST /api/auth/refresh-token
 */
router.post('/refresh-token', auth, async (req, res) => {
  try {
    // If we reach here, the session is valid (auth middleware passed)
    const user = req.user;
    
    // Create device fingerprint for refresh-token request
    const deviceFingerprint = crypto
      .createHash('sha256')
      .update(`${req.ip || 'unknown'}`)
      .digest('hex')
      .substring(0, 16);

    // Generate new token with same session ID and device fingerprint
    const token = jwt.sign(
      { 
        userId: user._id, 
        username: user.username, 
        role: user.role,
        sessionId: user.currentSessionId,
        deviceFingerprint: deviceFingerprint
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ 
      token,
      user: {
        _id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        balance: user.balance || 0,
        displayNameLastChanged: user.displayNameLastChanged
      }
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ message: 'Error refreshing token' });
  }
});

/**
 * Request password reset
 * Generates a reset token and sends it to user's email
 * @route POST /api/auth/forgot-password
 */
router.post('/forgot-password', async (req, res) => {
  try {
    console.log('Received password reset request for email:', req.body.email);
    
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email });

    // Always return success even if email doesn't exist (security best practice)
    if (!user) {
      console.log('No user found with email:', email);
      return res.json({ 
        message: 'If an account exists with this email, you will receive password reset instructions.' 
      });
    }

    console.log('Generating reset token for user:', user._id);
    
    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.resetPasswordExpires = Date.now() + 30 * 60 * 1000; // 30 minutes
    
    await user.save();
    console.log('Reset token saved for user:', user._id);

    try {
      // Send password reset email
      await sendPasswordResetEmail(email, resetToken);
      console.log('Password reset email sent successfully to:', email);
    } catch (emailError) {
      console.error('Failed to send password reset email:', emailError);
      // Reset the token since email failed
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();
      
      throw new Error('Failed to send password reset email');
    }

    res.json({ 
      message: 'If an account exists with this email, you will receive password reset instructions.' 
    });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ 
      message: 'An error occurred while processing your request. Please try again later.' 
    });
  }
});

/**
 * Reset password using reset token
 * @route POST /api/auth/reset-password/:token
 */
router.post('/reset-password/:token', async (req, res) => {
  try {
    const { password } = req.body;
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Clear all user caches after password reset
    clearAllUserCaches(user);

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

export default router; 