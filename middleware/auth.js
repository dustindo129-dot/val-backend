import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { getCacheValue, setCacheValue } from '../utils/redisClient.js';

// Cache TTL for user data (1 hour)
const USER_CACHE_TTL = 3600;

/**
 * Authentication middleware to verify user's JWT token
 * Extracts token from cookies or Authorization header
 * Verifies token and attaches user object to request
 * Uses Redis caching to reduce database load
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
      console.error('Token verification failed:', tokenError.message);
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    // Try to get user from cache first
    const cacheKey = `user:${decoded.userId}`;
    const cachedUser = await getCacheValue(cacheKey);

    let user;
    if (cachedUser) {
      // Use cached user data
      user = cachedUser;
    } else {
      // Find user by ID and exclude password from result
      try {
        user = await User.findById(decoded.userId).select('-password').lean();
      
        if (!user) {
          throw new Error('User not found');
        }
      
        // Cache user data
        await setCacheValue(cacheKey, user, USER_CACHE_TTL);
      } catch (dbError) {
        console.error('Database error in auth middleware:', dbError);
        return res.status(500).json({ message: 'Server error during authentication' });
      }
    }

    // Attach user object to request for use in route handlers
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    res.status(401).json({ message: 'Please authenticate' });
  }
};

/**
 * Generate a new JWT token for user authentication
 * @param {string} userId - The ID of the user to generate token for
 * @returns {string} JWT token that expires in 7 days
 */
export const generateToken = (user) => {
  return jwt.sign(
    { userId: user._id, username: user.username, role: user.role },
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