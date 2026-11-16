const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const courseController = require('../controllers/courseController');
const membershipController = require('../controllers/courseMembershipController');

const router = express.Router();

router.use(protect);

router.post('/', authorize('admin', 'course_instructor'), courseController.createCourse);
router.post('/rollover', authorize('admin'), courseController.rolloverCourses);
router.get('/', courseController.getCourses);
router.get('/:id/context', membershipController.getCourseContext);
router.post('/:id/members', authorize('admin', 'course_instructor'), membershipController.addMember);
router.delete('/:id/members/:userId', authorize('admin', 'course_instructor'), membershipController.removeMember);
router.post('/:id/locations', authorize('admin', 'course_instructor'), membershipController.addLocation);
router.delete('/:id/locations/:locationId', authorize('admin', 'course_instructor'), membershipController.removeLocation);
router.get('/:id', courseController.getCourseById);
router.put('/:id', authorize('admin', 'course_instructor'), courseController.updateCourse);
router.delete('/:id', authorize('admin'), courseController.deleteCourse);

module.exports = router;
