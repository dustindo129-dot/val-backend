/**
 * Admin middleware to verify user has admin or moderator role
 * Must be used after auth middleware to access req.user
 */
const admin = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') {
      throw new Error('Admin or moderator access required');
    }
    next();
  } catch (error) {
    res.status(403).json({ message: 'Access denied. Admin or moderator only.' });
  }
};

export default admin; 