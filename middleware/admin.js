/**
 * Admin middleware to verify user has admin role
 * Must be used after auth middleware to access req.user
 */
const admin = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      throw new Error('Admin access required');
    }
    next();
  } catch (error) {
    res.status(403).json({ message: 'Access denied. Admin only.' });
  }
};

export default admin; 