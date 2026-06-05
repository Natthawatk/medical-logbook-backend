const express = require('express');

const {
  protect,
  authorize,
} = require('../middlewares/authMiddleware');

const userController = require('../controllers/userController');

const router = express.Router();

router.get('/me', protect, userController.getMyProfile);
router.put('/profile', protect, userController.updateMyProfile);
router.get('/preceptors', protect, userController.getPreceptors);
router.get('/preceptors-by-location', protect, authorize('student'), userController.getPreceptorsByLocation);
router.post('/', protect, authorize('admin'), userController.createUser);
router.post('/bulk', protect, authorize('admin'), userController.createUsersBulk);
router.get('/', protect, authorize('admin'), userController.getUsers);
router.get('/:id', protect, authorize('admin'), userController.getUserById);
router.put('/:id', protect, authorize('admin'), userController.updateUser);
router.delete(
  '/:id',
  protect,
  authorize('admin'),
  userController.deleteUser
);

module.exports = router;

