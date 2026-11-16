const express = require('express');
const authController = require('../controllers/authController');
const googleAuthController = require('../controllers/googleAuthController');
const {
  loginRateLimiter,
  resetPasswordRateLimiter,
} = require('../middlewares/securityMiddleware');

const router = express.Router();

// Email/password login
router.post('/login', loginRateLimiter, authController.login);
router.post('/google-login', loginRateLimiter, googleAuthController.googleLogin);
router.post('/reset-password', resetPasswordRateLimiter, authController.resetPassword);

module.exports = router;
