const mongoose = require('mongoose');
const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const CourseLocation = require('../models/CourseLocation');
const Procedure = require('../models/Procedure');
const LogbookCase = require('../models/LogbookCase');
const Notification = require('../models/Notification');
const { getAccessibleCourseIds, canManageCourse } = require('../services/courseAccessService');
const { calculateProgressPercent, computeCourseSkillsStats } = require('../services/courseSkillsStatsService');
const {
  getSixMonthStart,
  buildGraphDataByRange,
  sumGraphDataByRange,
} = require('../services/dashboardGraphService');

exports.getStats = async (req, res) => {
  try {
    const courseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
    const courses = await Course.find({ _id: { $in: courseIds } })
      .populate('enrolled_students', 'year')
      .sort({ createdAt: -1 })
      .lean();
    const courseProgress = await Promise.all(courses.map(async (course) => {
      const [courseAssignments, procedures] = await Promise.all([
        CourseAssignment.find({ course_id: course._id, status: 'active' }).populate('user_id', 'year').lean(),
        Procedure.find({ course_id: course._id }).select('_id required_cases target_score').lean(),
      ]);
      const studentMap = new Map();
      [...(course.enrolled_students || []), ...courseAssignments
        .filter((assignment) => assignment.assignment_role === 'student' && assignment.user_id)
        .map((assignment) => assignment.user_id)]
        .forEach((student) => {
          if (student?._id) studentMap.set(String(student._id), student);
        });
      const students = [...studentMap.values()];
      const studentIds = students.map((student) => student._id);
      const studentCount = students.length;
      const preceptorCount = new Set(courseAssignments
        .filter((assignment) => assignment.assignment_role === 'preceptor' && assignment.user_id)
        .map((assignment) => String(assignment.user_id._id))).size;
      const procedureIds = procedures.map((procedure) => procedure._id);
      const sixMonthsAgo = getSixMonthStart();
      const [approvedStudentProcedureStats, pendingCases, dailyStats, scoreStats] = await Promise.all([
        LogbookCase.aggregate([
          { $match: { student_id: { $in: studentIds }, procedure_id: { $in: procedureIds }, evaluation_status: 'approved' } },
          { $group: { _id: { student_id: '$student_id', procedure_id: '$procedure_id' }, count: { $sum: 1 } } },
        ]),
        LogbookCase.countDocuments({ student_id: { $in: studentIds }, procedure_id: { $in: procedureIds }, evaluation_status: 'pending' }),
        LogbookCase.aggregate([
          {
            $match: {
              student_id: { $in: studentIds },
              procedure_id: { $in: procedureIds },
              evaluation_status: 'approved',
              evaluated_at: { $gte: sixMonthsAgo },
            },
          },
          {
            $group: {
              _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$evaluated_at', timezone: 'Asia/Bangkok' } } },
              count: { $sum: 1 },
            },
          },
          { $sort: { '_id.day': 1 } },
        ]),
        LogbookCase.aggregate([
          { $match: { student_id: { $in: studentIds }, procedure_id: { $in: procedureIds }, evaluation_status: 'approved' } },
          { $group: { _id: null, average: { $avg: '$evaluation_result' } } },
        ]),
      ]);
      const requiredByProcedure = new Map(procedures.map((procedure) => [
        String(procedure._id),
        Number(procedure.required_cases || procedure.target_score || 1),
      ]));
      const approvedCases = approvedStudentProcedureStats.reduce(
        (sum, stat) => sum + Math.min(stat.count, requiredByProcedure.get(String(stat._id.procedure_id)) || 1),
        0
      );
      const graphDataByRange = buildGraphDataByRange(dailyStats);
      const graphData = graphDataByRange.monthly;
      const perStudentTarget = procedures.reduce((sum, procedure) => sum + Number(procedure.required_cases || procedure.target_score || 0), 0);
      const targetCases = perStudentTarget * studentCount;
      return {
        ...course,
        studentCount,
        preceptorCount,
        procedureCount: procedures.length,
        approvedCases,
        pendingCases,
        targetCases,
        progressPercent: calculateProgressPercent(approvedCases, targetCases),
        averageScore: Number(scoreStats[0]?.average || 0),
        graphData,
        graphDataByRange,
        studentsByYear: students.reduce((result, student) => {
          if (student.year) result[student.year] = (result[student.year] || 0) + 1;
          return result;
        }, {}),
      };
    }));
    const [assignments, locationIds, unreadNotificationsCount] = await Promise.all([
      CourseAssignment.find({ course_id: { $in: courseIds }, status: 'active' })
        .populate('user_id', 'year')
        .lean(),
      CourseLocation.find({ course_id: { $in: courseIds }, status: 'active' }).distinct('location_id'),
      Notification.countDocuments({ recipient_id: req.user.id, is_read: false }),
    ]);
    const usersByRole = { student: 0, preceptor: 0, course_instructor: 0, admin: 0 };
    const idsByRole = new Map();
    assignments.forEach((item) => {
      if (!item.user_id) return;
      if (!idsByRole.has(item.assignment_role)) idsByRole.set(item.assignment_role, new Set());
      idsByRole.get(item.assignment_role).add(String(item.user_id._id));
    });
    if (!idsByRole.has('student')) idsByRole.set('student', new Set());
    courses.forEach((course) => (course.enrolled_students || []).forEach((student) => {
      if (student?._id) idsByRole.get('student').add(String(student._id));
    }));
    idsByRole.forEach((ids, role) => { usersByRole[role] = ids.size; });
    const uniqueUsers = new Set([...idsByRole.values()].flatMap((ids) => [...ids]));
    const totalProcedures = courseProgress.reduce((sum, course) => sum + course.procedureCount, 0);
    const totalApprovedCases = courseProgress.reduce((sum, course) => sum + course.approvedCases, 0);
    const totalTargetCases = courseProgress.reduce((sum, course) => sum + course.targetCases, 0);
    const graphDataByRange = sumGraphDataByRange(courseProgress.map((course) => course.graphDataByRange));
    const graphData = graphDataByRange.monthly;
    const weightedScores = courseProgress.reduce((sum, course) => sum + (course.averageScore * course.approvedCases), 0);

    return res.json({
      success: true,
      data: {
        totalUsers: uniqueUsers.size,
        usersByRole,
        totalLocations: locationIds.length,
        totalCourses: courses.length,
        totalProcedures,
        totalApprovedCases,
        totalTargetCases,
        overallProgress: calculateProgressPercent(totalApprovedCases, totalTargetCases),
        averageScore: totalApprovedCases > 0 ? weightedScores / totalApprovedCases : 0,
        graphData,
        graphDataByRange,
        courseProgress,
        unreadNotificationsCount,
      },
      message: 'Instructor dashboard fetched successfully.',
    });
  } catch (err) {
    console.error('Instructor dashboard error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Unable to fetch instructor dashboard.' });
  }
};

exports.getCourseSkillsStats = async (req, res) => {
  try {
    const { course_id: courseIdValue } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseIdValue)) {
      return res.status(400).json({ success: false, data: null, message: 'Invalid course ID' });
    }
    if (!(await canManageCourse(req.user, courseIdValue))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์ดูรายวิชานี้' });
    }

    const { notFound, data } = await computeCourseSkillsStats(courseIdValue);
    if (notFound) {
      return res.status(404).json({ success: false, data: null, message: 'Course not found' });
    }
    return res.json({ success: true, data });
  } catch (err) {
    console.error('Get instructor course skills error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Unable to fetch course skills.' });
  }
};
