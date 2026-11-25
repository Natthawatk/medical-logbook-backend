const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/environment');

const resolveSessionDuration = (user, rememberMe = true) => {
  if (user?.is_shared_account) {
    return process.env.JWT_EXPIRES_IN_SHARED || '1d';
  }
  if (user?.role === 'admin') {
    return rememberMe
      ? (process.env.JWT_EXPIRES_IN_ADMIN || '7d')
      : '1d';
  }
  if (rememberMe) {
    return process.env.JWT_EXPIRES_IN_LONG || '30d';
  }
  return process.env.JWT_EXPIRES_IN || '7d';
};

const signAuthToken = (user, { rememberMe = true } = {}) => {
  const effectiveRemember = Boolean(rememberMe) && !user?.is_shared_account;
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      tv: user.token_version || 0,
      rem: effectiveRemember,
    },
    JWT_SECRET,
    { expiresIn: resolveSessionDuration(user, effectiveRemember) }
  );
};

const buildSafeAuthUser = (user) => ({
  id: user._id,
  email: user.email,
  role: user.role,
  firstname_lastname: user.firstname_lastname,
  student_id: user.student_id,
  profile_image: user.profile_image,
  is_shared_account: Boolean(user.is_shared_account),
  must_change_password: Boolean(user.must_change_password) && !Boolean(user.is_shared_account),
});

module.exports = {
  resolveSessionDuration,
  signAuthToken,
  buildSafeAuthUser,
};
