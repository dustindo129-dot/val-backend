import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { getCachedUserById } from '../utils/userCache.js';

/**
 * Authentication middleware to verify user's JWT token
 * Extracts token from cookies or Authorization header
 * Verifies token and attaches user object to request
 * Uses global user caching to reduce database load
 */
export const auth = async (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    const token = req.cookies.token || req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      throw new Error('Authentication required');
    }

    // Verify token and decode user ID
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (tokenError) {
      // Log different types of token errors with appropriate severity
      if (tokenError.name === 'JsonWebTokenError') {
        // Malformed token - reduce log noise for common case
        console.warn(`JWT malformed from ${req.ip} - ${req.originalUrl}`);
      } else if (tokenError.name === 'TokenExpiredError') {
        console.log(`JWT expired from ${req.ip} - ${req.originalUrl}`);
      } else if (tokenError.name === 'NotBeforeError') {
        console.warn(`JWT not active from ${req.ip} - ${req.originalUrl}`);
      } else {
        // Other JWT errors - full logging
        console.error('Token verification failed:', tokenError.message);
      }
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    // Use global cached user lookup
    try {
      const user = await getCachedUserById(decoded.userId);
      
      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }

      // Enhanced session validation with improved device fingerprinting
      if (decoded.sessionId && user.currentSessionId) {
        // Use User-Agent + Accept-Language instead of just IP for fingerprinting
        // This is more stable for users that frequently switch networks (VPNs, mobile, etc.)
        const userAgent = req.headers['user-agent'] || 'unknown';
        const acceptLanguage = req.headers['accept-language'] || 'unknown';
        const currentDeviceFingerprint = require('crypto')
          .createHash('sha256')
          .update(`${userAgent.substring(0, 100)}-${acceptLanguage.substring(0, 20)}`)
          .digest('hex')
          .substring(0, 16);
        
        // Check if this is the same device (now based on browser fingerprint, not IP)
        const tokenDeviceFingerprint = decoded.deviceFingerprint || decoded.sessionId.split('-')[0];
        const isSameDevice = tokenDeviceFingerprint === currentDeviceFingerprint;
        
        // Allow multiple device logins and be lenient with network switches
        // Detect likely mobile scenarios to be more forgiving (applies to mobile users)
        const isLikelyMobileNetworkSwitch = !isSameDevice && 
          (userAgent.toLowerCase().includes('mobile') || 
           userAgent.toLowerCase().includes('android') || 
           userAgent.toLowerCase().includes('iphone'));
        
        // Check if the session is reasonably recent (be more lenient for mobile)
        const tokenIssueTime = decoded.iat * 1000; // Convert to milliseconds
        const now = Date.now();
        const sessionAge = now - tokenIssueTime;
        // Use unified session age for better UX across all devices
        // 36 hours provides good balance between security and user experience
        const maxSessionAge = 36 * 60 * 60 * 1000; // 36 hours for all devices
        
        if (sessionAge > maxSessionAge) {
          return res.status(401).json({ 
            message: 'Session expired - please login again',
            code: 'SESSION_EXPIRED'
          });
        }
        
        // Optional: Log multi-device usage for monitoring (but don't block)
        if (!isSameDevice && !isLikelyMobileNetworkSwitch) {
          const logKey = `multi_device_${user._id}_${decoded.sessionId}`;
          if (!global.multiDeviceLogs) {
            global.multiDeviceLogs = new Map();
          }
          
          const lastLogged = global.multiDeviceLogs.get(logKey);
          // Only log once every 5 minutes per user per session
          if (!lastLogged || (now - lastLogged) > 5 * 60 * 1000) {
            console.log(`Multi-device login: user ${user.username} from ${req.ip} (different from registered device)`);
            global.multiDeviceLogs.set(logKey, now);
          }
        }
      }

      // Check if user is banned
      if (user.isBanned) {
        return res.status(403).json({ 
          message: 'Your account has been banned. Please contact support if you believe this is an error.',
          code: 'ACCOUNT_BANNED'
        });
      }

      // Attach user to request object
      req.user = user;
      next();
    } catch (dbError) {
      console.error('Database error during authentication:', dbError);
      return res.status(500).json({ message: 'Authentication failed' });
    }
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({ message: 'Authentication failed' });
  }
};

/**
 * Generate JWT token for user
 * @param {Object} user - User object
 * @returns {string} JWT token
 */
export const generateToken = (user) => {
  return jwt.sign(
    { 
      userId: user._id, 
      username: user.username, 
      role: user.role 
    },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
};

/**
 * Check if user is banned
 * Must be used after auth middleware
 */
export const checkBan = async (req, res, next) => {
  try {
    if (req.user.isBanned) {
      return res.status(403).json({ 
        message: 'You are banned from performing this action'
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: 'Error checking ban status' });
  }
};

/**
 * Check if user has required role
 * @param {Array} roles - Array of allowed roles
 * @returns {Function} Middleware function
 * Must be used after auth middleware
 */
export const checkRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: 'You do not have permission to perform this action' 
      });
    }
    
    next();
  };
};

/**
 * Optional authentication middleware that sets req.user if authenticated,
 * but doesn't require authentication (doesn't fail if no token provided)
 */
export const optionalAuth = async (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    const token = req.cookies.token || req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      // No token provided, continue without user
      req.user = null;
      return next();
    }

    // Verify token and decode user ID
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (tokenError) {
      // Invalid/expired token, continue without user
      req.user = null;
      return next();
    }

    // Use global cached user lookup
    try {
      const user = await getCachedUserById(decoded.userId);
      
      if (!user) {
        console.warn(`User ${decoded.userId} not found in database (token valid but user deleted)`);
        req.user = null;
        return next();
      }

      // CRITICAL FIX: For optionalAuth, skip complex session validation that causes false rejections
      // The main security checks should be in the strict `auth` middleware
      // For optional auth, just check basic token validity and age
      
      if (decoded.iat) {
        const tokenIssueTime = decoded.iat * 1000;
        const currentTime = Date.now();
        const sessionAge = currentTime - tokenIssueTime;
        // Use a generous timeout for optional auth - 7 days
        const maxSessionAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        
        if (sessionAge > maxSessionAge) {
          req.user = null;
          return next();
        }
      }

      // Check if user is banned
      if (user.isBanned) {
        req.user = null;
        return next();
      }

      // Set user object on request
      req.user = user;
      next();
    } catch (userLookupError) {
      console.error('Error looking up user during optional auth:', userLookupError);
      req.user = null;
      next();
    }
  } catch (error) {
    console.error('Unexpected error in optional auth middleware:', error);
    req.user = null;
    next();
  }
}; 