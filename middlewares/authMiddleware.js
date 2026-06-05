const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Protect routes - require valid JWT
exports.protect = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer ')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Not authorized, token missing.',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Not authorized, token invalid or expired.',
      });
    }

    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'User linked to this token no longer exists.',
      });
    }

    // Block inactive users from making requests
    if (user.academic_status === 'inactive') {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
      });
    }

    req.user = {
      id: user._id,
      role: user.role,
      email: user.email,
      academic_status: user.academic_status,
    };

    next();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Auth protect error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred during authentication.',
    });
  }
};

// Restrict access to specific roles
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'You do not have permission to perform this action.',
      });
    }

    next();
  };
};

