const express = require('express');
const authController = require('../controllers/authController');
const googleAuthController = require('../controllers/googleAuthController');

const router = express.Router();

// Email/password login
router.post('/login', authController.login);
router.post('/google-login', googleAuthController.googleLogin);
router.post('/reset-password', authController.resetPassword);

module.exports = router;

