/**
 * Admin middleware to verify user has admin, moderator, or pj_user role
 * Must be used after auth middleware to access req.user
 */
const admin = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'moderator' && req.user.role !== 'pj_user') {
      throw new Error('Admin, moderator, or project user access required');
    }
    next();
  } catch (error) {
    res.status(403).json({ message: 'Access denied. Admin, moderator, or project user only.' });
  }
};

export default admin; 