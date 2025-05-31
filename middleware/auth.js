import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import NodeCache from 'node-cache';

// Create in-memory cache for user data (1 hour TTL)
const userCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

/**
 * Authentication middleware to verify user's JWT token
 * Extracts token from cookies or Authorization header
 * Verifies token and attaches user object to request
 * Uses in-memory caching to reduce database load
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

    // Try to get user from cache first
    const cacheKey = `user:${decoded.userId}`;
    const cachedUser = userCache.get(cacheKey);

    let user;
    if (cachedUser) {
      // Use cached user data
      user = cachedUser;
    } else {
      // Find user by ID and exclude password from result
      try {
        user = await User.findById(decoded.userId).select('-password').lean();
        
        if (!user) {
          return res.status(401).json({ message: 'User not found' });
        }

        // Cache user data for 1 hour
        userCache.set(cacheKey, user);
      } catch (dbError) {
        console.error('Database error during authentication:', dbError);
        return res.status(500).json({ message: 'Authentication failed' });
      }
    }

    // Attach user to request object
    req.user = user;
    next();
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