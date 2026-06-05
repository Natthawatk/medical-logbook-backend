const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const dashboardController = require('../controllers/dashboardController');

const router = express.Router();

router.use(protect);

router.get('/student', authorize('student'), dashboardController.getStudentStats);
router.get('/student/course/:course_id', authorize('student'), dashboardController.getStudentProcedureStats);
router.get('/preceptor', authorize('preceptor'), dashboardController.getPreceptorStats);
router.get('/admin', authorize('admin'), dashboardController.getAdminStats);
router.get('/admin/student-progress', authorize('admin'), dashboardController.getStudentProgress);
router.get('/admin/student/:id', authorize('admin'), dashboardController.getAdminStudentStats);
router.get('/admin/student/:id/course/:course_id', authorize('admin'), dashboardController.getAdminStudentProcedureStats);
router.get('/admin/course-skills/:course_id', authorize('admin'), dashboardController.getAdminCourseSkillsStats);

module.exports = router;
