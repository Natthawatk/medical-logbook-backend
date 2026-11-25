const express = require('express');

const { protect } = require('../middlewares/authMiddleware');
const notificationController = require('../controllers/notificationController');

const router = express.Router();

router.use(protect);

router.get('/my', notificationController.getMyNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.get('/preferences', notificationController.getNotificationPreferences);
router.put('/preferences', notificationController.updateNotificationPreferences);
router.get('/push-public-key', notificationController.getPushPublicKey);
router.post('/push-subscribe', notificationController.subscribePush);
router.delete('/push-subscribe', notificationController.unsubscribePush);
router.post('/push-test', notificationController.testPush);
router.put('/read-all', notificationController.markAllAsRead);
router.delete('/clear-read', notificationController.clearReadNotifications);
router.put('/:id/read', notificationController.markNotificationAsRead);
router.delete('/:id', notificationController.deleteNotification);

module.exports = router;
