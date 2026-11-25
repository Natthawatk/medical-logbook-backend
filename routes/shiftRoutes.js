const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const shiftController = require('../controllers/shiftController');

const router = express.Router();

router.use(protect);

router.post('/check-in', authorize('student'), shiftController.checkIn);
router.get('/my', authorize('student'), shiftController.getMyShifts);
router.get('/preceptor/shifts', authorize('preceptor'), shiftController.getPreceptorShifts);
router.get('/user/:id', authorize('admin', 'course_instructor'), shiftController.getUserShifts);
router.put('/:id/verify', authorize('admin', 'preceptor'), shiftController.verifyShift);
router.put('/:id', authorize('admin'), shiftController.updateShiftByAdmin);
router.delete('/:id', authorize('admin'), shiftController.deleteShiftByAdmin);

module.exports = router;
