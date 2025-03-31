import jwt from 'jsonwebtoken';
import User from '../models/User.js';

/**
 * Authentication middleware to verify user's JWT token
 * Extracts token from cookies or Authorization header
 * Verifies token and attaches user object to request
 */
export const auth = async (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    const token = req.cookies.token || req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      throw new Error('Authentication required');
    }

    // Verify token and decode user ID
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Find user by ID and exclude password from result
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      throw new Error('User not found');
    }

    // Attach user object to request for use in route handlers
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Please authenticate' });
  }
};

/**
 * Generate a new JWT token for user authentication
 * @param {string} userId - The ID of the user to generate token for
 * @returns {string} JWT token that expires in 7 days
 */
export const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });
}; 