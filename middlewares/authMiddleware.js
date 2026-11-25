const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET } = require('../config/environment');

const AUTH_CACHE_TTL_MS = 30 * 1000;
const AUTH_CACHE_MAX_ENTRIES = 2000;
const authUserCache = new Map();

const invalidateAuthUserCache = (userId) => {
  if (!userId) return;
  authUserCache.delete(String(userId));
};

const invalidateAuthUsersCache = (userIds) => {
  if (!Array.isArray(userIds)) return;
  userIds.forEach((id) => {
    if (id) authUserCache.delete(String(id));
  });
};

const getCachedAuthUser = async (userId) => {
  const key = String(userId || '');
  if (!key) return null;

  const now = Date.now();
  const cached = authUserCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.user;
  }
  if (cached) {
    authUserCache.delete(key);
  }

  const user = await User.findById(key)
    .select('role email academic_status token_version')
    .lean();

  if (!user) return null;

  if (authUserCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldestKey = authUserCache.keys().next().value;
    if (oldestKey) authUserCache.delete(oldestKey);
  }

  authUserCache.set(key, {
    user,
    expiresAt: now + AUTH_CACHE_TTL_MS,
  });
  return user;
};

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

    const user = await getCachedAuthUser(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'User linked to this token no longer exists.',
      });
    }

    if ((decoded.tv ?? 0) !== (user.token_version ?? 0)) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
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
    req.authRemember = decoded.rem !== false;

    return next();
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

    return next();
  };
};

exports.invalidateAuthUserCache = invalidateAuthUserCache;
exports.invalidateAuthUsersCache = invalidateAuthUsersCache;
