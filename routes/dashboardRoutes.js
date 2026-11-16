const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const dashboardController = require('../controllers/dashboardController');
const instructorDashboardController = require('../controllers/instructorDashboardController');

const router = express.Router();

router.use(protect);

router.get('/student', authorize('student'), dashboardController.getStudentStats);
router.get('/student/course/:course_id', authorize('student'), dashboardController.getStudentProcedureStats);
router.get('/preceptor', authorize('preceptor'), dashboardController.getPreceptorStats);
router.get('/instructor', authorize('course_instructor'), instructorDashboardController.getStats);
router.get('/instructor/course-skills/:course_id', authorize('course_instructor'), instructorDashboardController.getCourseSkillsStats);
router.get('/admin', authorize('admin'), dashboardController.getAdminStats);
router.get('/admin/student-progress', authorize('admin', 'course_instructor'), dashboardController.getStudentProgress);
router.get('/admin/export-yearly', authorize('admin', 'course_instructor'), dashboardController.exportYearlyProgressExcel);
router.get('/admin/student/:id', authorize('admin', 'course_instructor'), dashboardController.getAdminStudentStats);
router.get('/admin/student/:id/export', authorize('admin', 'course_instructor'), dashboardController.exportStudentDetailExcel);
router.get('/admin/student/:id/course/:course_id', authorize('admin', 'course_instructor'), dashboardController.getAdminStudentProcedureStats);
router.get('/admin/student/:id/cases', authorize('admin', 'course_instructor'), dashboardController.getAdminStudentCases);
router.get('/admin/course-skills/:course_id', authorize('admin'), dashboardController.getAdminCourseSkillsStats);

module.exports = router;
