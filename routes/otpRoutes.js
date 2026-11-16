const express = require('express');
const otpController = require('../controllers/otpController');
const {
  otpSendRateLimiter,
  otpVerifyRateLimiter,
} = require('../middlewares/securityMiddleware');

const router = express.Router();

router.post('/send', otpSendRateLimiter, otpController.sendOTP);
router.post('/verify', otpVerifyRateLimiter, otpController.verifyOTP);

module.exports = router;
