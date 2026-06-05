const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const courseController = require('../controllers/courseController');

const router = express.Router();

router.use(protect, authorize('admin'));

router.post('/', courseController.createCourse);
router.post('/rollover', courseController.rolloverCourses);
router.get('/', courseController.getCourses);
router.get('/:id', courseController.getCourseById);
router.put('/:id', courseController.updateCourse);
router.delete('/:id', courseController.deleteCourse);

module.exports = router;
