const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

// Email/password login
router.post('/login', authController.login);
router.post('/reset-password', authController.resetPassword);

module.exports = router;

