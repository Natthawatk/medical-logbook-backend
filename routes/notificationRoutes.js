const express = require('express');

const { protect } = require('../middlewares/authMiddleware');
const notificationController = require('../controllers/notificationController');

const router = express.Router();

router.use(protect);

router.get('/my', notificationController.getMyNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.put('/read-all', notificationController.markAllAsRead);
router.put('/:id/read', notificationController.markNotificationAsRead);

module.exports = router;
