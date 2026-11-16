const mongoose = require('mongoose');
const LogbookCase = require('../models/LogbookCase');
const Shift = require('../models/Shift');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Location = require('../models/Location');
const Course = require('../models/Course');
const Procedure = require('../models/Procedure');
const CourseAssignment = require('../models/CourseAssignment');
const CourseLocation = require('../models/CourseLocation');
const { getAccessibleCourseIds, canManageCourse } = require('../services/courseAccessService');
const { computeCourseSkillsStats } = require('../services/courseSkillsStatsService');
const {
  toBangkokExcelDate,
  buildYearlyReportWorkbook,
  buildStudentReportWorkbook,
  writeWorkbookToResponse,
} = require('../services/studentReportExportService');

const {
  getSixMonthStart,
  buildGraphDataByRange,
} = require('../services/dashboardGraphService');

const parseSemesterSortKey = (semester) => {
  const raw = String(semester || '').trim();
  const match = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (match) {
    return { year: Number(match[2]), term: Number(match[1]), raw };
  }
  return { year: 0, term: 0, raw };
};

const getStudentCourses = async (studentId) => {
  const user = await User.findById(studentId).select('enrolled_courses firstname_lastname profile_image student_id year role').lean();
  if (!user) return null;

  // Merge active CourseAssignments with legacy enrolled_courses / Course.enrolled_students
  // until production migration is applied and verified.
  const courseIds = await getAccessibleCourseIds(
    { id: studentId, role: 'student' },
    ['student']
  );

  const courses = await Course.find({ _id: { $in: courseIds } })
    .select('course_name course_code semester year evaluation_type enrolled_locations is_archived')
    .populate('enrolled_locations', 'Location_name _id')
    .lean();

  const locationLinks = await CourseLocation.find({
    course_id: { $in: courseIds },
    status: 'active',
  }).populate('location_id', 'Location_name _id').lean();
  const locationsByCourse = new Map();
  locationLinks.forEach((link) => {
    const key = String(link.course_id);
    if (!locationsByCourse.has(key)) locationsByCourse.set(key, []);
    if (link.location_id) locationsByCourse.get(key).push(link.location_id);
  });

  courses.forEach((course) => {
    const normalizedLocations = locationsByCourse.get(String(course._id));
    if (normalizedLocations) course.enrolled_locations = normalizedLocations;
  });
  return { user, courses };
};

const computeStudentDashboardMetrics = async ({ studentId, courses, scopeToCourses = false }) => {
  const courseIds = courses.map((course) => course._id);
  const allProceduresInCourses = courseIds.length > 0
    ? await Procedure.find({ course_id: { $in: courseIds } }).lean()
    : [];
  const scopedProcedureIds = allProceduresInCourses.map((proc) => proc._id);
  const sixMonthsAgo = getSixMonthStart();

  const baseCaseMatch = scopeToCourses
    ? { student_id: studentId, procedure_id: { $in: scopedProcedureIds } }
    : { student_id: studentId };

  const [caseSummary, shiftSummary, approvedCasesData, pendingCasesByCourse, dailyByCourseStats] = await Promise.all([
    LogbookCase.aggregate([
      { $match: baseCaseMatch },
      {
        $group: {
          _id: null,
          totalCases: { $sum: 1 },
          approvedCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'approved'] }, 1, 0] } },
          pendingCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'pending'] }, 1, 0] } },
          rejectedCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'rejected'] }, 1, 0] } },
        },
      },
    ]),
    Shift.aggregate([
      { $match: { student_id: studentId } },
      {
        $group: {
          _id: null,
          verifiedShifts: { $sum: { $cond: [{ $eq: ['$verify_status', 'verified'] }, 1, 0] } },
          pendingShifts: { $sum: { $cond: [{ $eq: ['$verify_status', 'pending'] }, 1, 0] } },
          normalShifts: { $sum: { $cond: [{ $and: [{ $eq: ['$verify_status', 'verified'] }, { $eq: ['$shift_status', 'normal'] }] }, 1, 0] } },
          lateShifts: { $sum: { $cond: [{ $eq: ['$shift_status', 'late'] }, 1, 0] } },
          absentShifts: { $sum: { $cond: [{ $eq: ['$shift_status', 'absent'] }, 1, 0] } },
          leaveShifts: { $sum: { $cond: [{ $eq: ['$shift_status', 'leave'] }, 1, 0] } },
        },
      },
    ]),
    LogbookCase.aggregate([
      { $match: { ...baseCaseMatch, evaluation_status: 'approved' } },
      { $lookup: { from: 'procedures', localField: 'procedure_id', foreignField: '_id', as: 'procedure' } },
      { $unwind: '$procedure' },
      { $lookup: { from: 'courses', localField: 'procedure.course_id', foreignField: '_id', as: 'course' } },
      { $unwind: '$course' },
      {
        $group: {
          _id: '$procedure_id',
          course_id: { $first: '$procedure.course_id' },
          evaluation_type: { $first: '$course.evaluation_type' },
          count: { $sum: 1 },
          totalScore: {
            $sum: {
              $cond: [
                { $eq: ['$course.evaluation_type', 'Pass/Fail'] },
                { $multiply: ['$evaluation_result', 4] },
                '$evaluation_result',
              ],
            },
          },
        },
      },
    ]),
    LogbookCase.aggregate([
      { $match: { ...baseCaseMatch, evaluation_status: 'pending' } },
      { $lookup: { from: 'procedures', localField: 'procedure_id', foreignField: '_id', as: 'procedure' } },
      { $unwind: '$procedure' },
      { $group: { _id: '$procedure.course_id', count: { $sum: 1 } } },
    ]),
    LogbookCase.aggregate([
      {
        $match: {
          ...baseCaseMatch,
          evaluation_status: 'approved',
          $or: [
            { evaluated_at: { $gte: sixMonthsAgo } },
            { evaluated_at: null, createdAt: { $gte: sixMonthsAgo } },
          ],
        },
      },
      { $lookup: { from: 'procedures', localField: 'procedure_id', foreignField: '_id', as: 'procedure' } },
      { $unwind: '$procedure' },
      { $addFields: { effectiveDate: { $ifNull: ['$evaluated_at', '$createdAt'] } } },
      {
        $group: {
          _id: {
            course_id: '$procedure.course_id',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$effectiveDate', timezone: 'Asia/Bangkok' } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]),
  ]);

  const summary = caseSummary[0] || { totalCases: 0, approvedCases: 0, pendingCases: 0, rejectedCases: 0 };
  const sSummary = shiftSummary[0] || { verifiedShifts: 0, pendingShifts: 0, normalShifts: 0, lateShifts: 0, absentShifts: 0, leaveShifts: 0 };

  const approvedProcMap = {};
  const approvedCourseScoreMap = {};
  const approvedCourseCaseCountMap = {};
  let grandTotalScore = 0;
  let grandTotalApprovedCases = 0;

  approvedCasesData.forEach((item) => {
    const pid = item._id.toString();
    const cid = item.course_id.toString();

    approvedProcMap[pid] = item.count;
    approvedCourseScoreMap[cid] = (approvedCourseScoreMap[cid] || 0) + item.totalScore;
    approvedCourseCaseCountMap[cid] = (approvedCourseCaseCountMap[cid] || 0) + item.count;

    grandTotalScore += item.totalScore;
    grandTotalApprovedCases += item.count;
  });

  const pendingByCourseMap = {};
  pendingCasesByCourse.forEach((item) => {
    if (item._id) pendingByCourseMap[item._id.toString()] = item.count;
  });

  const targetMap = {};
  const typeCountMap = {};
  let totalAllProceduresTarget = 0;
  let totalAllProceduresApproved = 0;

  allProceduresInCourses.forEach((proc) => {
    const cid = proc.course_id.toString();
    const pid = proc._id.toString();
    const target = proc.required_cases || proc.target_score || 1;
    const approved = approvedProcMap[pid] || 0;

    targetMap[cid] = (targetMap[cid] || 0) + target;
    typeCountMap[cid] = (typeCountMap[cid] || 0) + 1;
    totalAllProceduresTarget += target;
    totalAllProceduresApproved += approved;
  });

  const calculatedOverallProgress = totalAllProceduresTarget > 0
    ? (totalAllProceduresApproved / totalAllProceduresTarget) * 100
    : 0;
  const calculatedGPA = grandTotalApprovedCases > 0 ? (grandTotalScore / grandTotalApprovedCases) : 0;

  const courseProgress = courses.map((course) => {
    const cid = course._id.toString();
    const approved = approvedCourseCaseCountMap[cid] || 0;
    const target = targetMap[cid] || 0;
    const totalScore = approvedCourseScoreMap[cid] || 0;
    const courseGraphBundle = buildGraphDataByRange(
      dailyByCourseStats,
      (item) => String(item._id.course_id) === cid
    );

    return {
      _id: course._id,
      course_name: course.course_name,
      course_code: course.course_code,
      semester: course.semester,
      year: course.year,
      approvedCases: approved,
      pendingCases: pendingByCourseMap[cid] || 0,
      targetCases: target,
      totalTypes: typeCountMap[cid] || 0,
      progressPercent: target > 0 ? (approved / target) * 100 : 0,
      averageScore: approved > 0 ? (totalScore / approved) : 0,
      graphData: courseGraphBundle.monthly,
      graphDataByRange: courseGraphBundle,
      enrolled_locations: course.enrolled_locations || [],
    };
  });

  const graphDataByRange = buildGraphDataByRange(dailyByCourseStats);
  const graphData = graphDataByRange.monthly;

  return {
    summary,
    sSummary,
    courseProgress,
    graphData,
    graphDataByRange,
    calculatedOverallProgress,
    calculatedGPA,
    totalProceduresCount: totalAllProceduresTarget,
    totalProceduresDone: totalAllProceduresApproved,
  };
};

exports.getStudentStats = async (req, res) => {
  try {
    const studentId = new mongoose.Types.ObjectId(req.user.id);

    const studentContext = await getStudentCourses(studentId);
    if (!studentContext) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    // Filter out archived courses and keep latest active semester
    let activeCourses = studentContext.courses.filter((c) => !c.is_archived);
    if (activeCourses.length > 0) {
      const sortedBySemester = [...activeCourses].sort((a, b) => {
        const semA = parseSemesterSortKey(a.semester);
        const semB = parseSemesterSortKey(b.semester);
        if (semA.year !== semB.year) return semB.year - semA.year;
        if (semA.term !== semB.term) return semB.term - semA.term;
        return semB.raw.localeCompare(semA.raw);
      });

      const latestSemester = sortedBySemester[0].semester;
      activeCourses = activeCourses.filter((c) => c.semester === latestSemester);
    }

    const [metrics, unreadNotificationsCount] = await Promise.all([
      computeStudentDashboardMetrics({ studentId, courses: activeCourses }),
      Notification.countDocuments({ recipient_id: studentId, is_read: false }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalCases: metrics.summary.totalCases,
        approvedCases: metrics.summary.approvedCases,
        pendingCases: metrics.summary.pendingCases,
        rejectedCases: metrics.summary.rejectedCases,
        verifiedShifts: metrics.sSummary.verifiedShifts,
        pendingShifts: metrics.sSummary.pendingShifts,
        normalShifts: metrics.sSummary.normalShifts,
        lateShifts: metrics.sSummary.lateShifts,
        absentShifts: metrics.sSummary.absentShifts,
        leaveShifts: metrics.sSummary.leaveShifts,
        courseProgress: metrics.courseProgress,
        graphData: metrics.graphData,
        graphDataByRange: metrics.graphDataByRange,
        unreadNotificationsCount,
        overallProgress: metrics.calculatedOverallProgress,
        averageScore: metrics.calculatedGPA,
        totalProceduresCount: metrics.totalProceduresCount,
        totalProceduresDone: metrics.totalProceduresDone,
      },
    });
  } catch (err) {
    console.error('Get student dashboard stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

exports.getStudentProcedureStats = async (req, res) => {
  try {
    const studentId = new mongoose.Types.ObjectId(req.user.id);
    const { course_id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid course_id.',
      });
    }

    const [course, procedures] = await Promise.all([
      Course.findById(course_id),
      Procedure.find({ course_id }),
    ]);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found.',
      });
    }

    if (!procedures || procedures.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }

    const stats = await LogbookCase.aggregate([
      { $match: { student_id: studentId, procedure_id: { $in: procedures.map((p) => p._id) } } },
      { $group: { _id: { procedure_id: '$procedure_id', status: '$evaluation_status' }, count: { $sum: 1 } } },
    ]);

    const statsMap = stats.reduce((acc, curr) => {
      const pid = curr._id.procedure_id.toString();
      const status = curr._id.status;
      if (!acc[pid]) acc[pid] = { approved: 0, pending: 0, rejected: 0 };
      acc[pid][status] = curr.count;
      return acc;
    }, {});

    const results = procedures.map((p) => {
      const pid = p._id.toString();
      const s = statsMap[pid] || { approved: 0, pending: 0, rejected: 0 };
      const target = p.required_cases || p.target_score || 1;

      return {
        _id: p._id,
        procedure_name: p.procedure_name,
        approvedCount: s.approved,
        pendingCount: s.pending,
        rejectedCount: s.rejected,
        targetCount: target,
        form_structure: p.form_structure || [],
        progressPercent: Math.min((s.approved / target) * 100, 100),
      };
    });

    return res.status(200).json({ success: true, data: results });
  } catch (err) {
    console.error('Get student procedure stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

exports.getPreceptorStats = async (req, res) => {
  try {
    const preceptorId = new mongoose.Types.ObjectId(req.user.id);
    const sixMonthsAgo = getSixMonthStart();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const [
      evaluatedCases,
      approvedCases,
      pendingCases,
      verifiedShifts,
      pendingShifts,
      studentStats,
      unreadCount,
      dailyStats,
      scoreOverallStats,
      recentCases,
      previousCases,
      courseIds,
    ] = await Promise.all([
      LogbookCase.countDocuments({
        preceptor_id: preceptorId,
        evaluation_status: { $in: ['approved', 'rejected'] },
      }),
      LogbookCase.countDocuments({
        preceptor_id: preceptorId,
        evaluation_status: 'approved',
      }),
      LogbookCase.countDocuments({ preceptor_id: preceptorId, evaluation_status: 'pending' }),
      Shift.countDocuments({ preceptor_id: preceptorId, verify_status: 'verified' }),
      Shift.countDocuments({ preceptor_id: preceptorId, verify_status: 'pending' }),
      LogbookCase.aggregate([
        { $match: { preceptor_id: preceptorId } },
        { $group: { _id: '$student_id' } },
        { $count: 'totalStudents' },
      ]),
      Notification.countDocuments({ recipient_id: preceptorId, is_read: false }),
      LogbookCase.aggregate([
        {
          $match: {
            preceptor_id: preceptorId,
            evaluation_status: { $in: ['approved', 'rejected'] },
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
        { $match: { preceptor_id: preceptorId, evaluation_status: 'approved' } },
        { $group: { _id: null, average: { $avg: '$evaluation_result' } } },
      ]),
      LogbookCase.countDocuments({
        preceptor_id: preceptorId,
        evaluation_status: { $in: ['approved', 'rejected'] },
        evaluated_at: { $gte: thirtyDaysAgo },
      }),
      LogbookCase.countDocuments({
        preceptor_id: preceptorId,
        evaluation_status: { $in: ['approved', 'rejected'] },
        evaluated_at: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo },
      }),
      CourseAssignment.find({
        user_id: preceptorId,
        assignment_role: 'preceptor',
        status: 'active',
      }).distinct('course_id'),
    ]);

    const graphDataByRange = buildGraphDataByRange(dailyStats);
    const graphData = graphDataByRange.monthly;

    const passingRate = evaluatedCases > 0 ? Math.round((approvedCases / evaluatedCases) * 100) : 0;
    let growthPercentage = 0;
    if (previousCases > 0) {
      growthPercentage = Math.round(((recentCases - previousCases) / previousCases) * 100);
    } else if (recentCases > 0) {
      growthPercentage = 100;
    }

    const [courses, studentCounts, proceduresInCourses, locationCounts] = await Promise.all([
      Course.find({ _id: { $in: courseIds }, is_archived: { $ne: true } })
        .select('course_code course_name semester year evaluation_type')
        .sort({ year: -1, semester: -1, course_code: 1 })
        .lean(),
      CourseAssignment.aggregate([
        { $match: { course_id: { $in: courseIds }, assignment_role: 'student', status: 'active' } },
        { $group: { _id: '$course_id', count: { $sum: 1 } } },
      ]),
      Procedure.find({ course_id: { $in: courseIds } }).select('_id course_id').lean(),
      CourseLocation.aggregate([
        { $match: { course_id: { $in: courseIds }, status: 'active' } },
        { $group: { _id: '$course_id', count: { $sum: 1 } } },
      ]),
    ]);

    const allProcIds = proceduresInCourses.map((proc) => proc._id);
    const [courseCaseStats, courseDailyStats] = allProcIds.length > 0
      ? await Promise.all([
          LogbookCase.aggregate([
            { $match: { preceptor_id: preceptorId, procedure_id: { $in: allProcIds } } },
            { $lookup: { from: 'procedures', localField: 'procedure_id', foreignField: '_id', as: 'procedure' } },
            { $unwind: '$procedure' },
            {
              $group: {
                _id: '$procedure.course_id',
                approvedCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'approved'] }, 1, 0] } },
                rejectedCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'rejected'] }, 1, 0] } },
                pendingCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'pending'] }, 1, 0] } },
                totalScore: {
                  $sum: {
                    $cond: [{ $eq: ['$evaluation_status', 'approved'] }, { $ifNull: ['$evaluation_result', 0] }, 0],
                  },
                },
                recentCases: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$evaluation_status', ['approved', 'rejected']] },
                          { $gte: ['$evaluated_at', thirtyDaysAgo] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                previousCases: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$evaluation_status', ['approved', 'rejected']] },
                          { $gte: ['$evaluated_at', sixtyDaysAgo] },
                          { $lt: ['$evaluated_at', thirtyDaysAgo] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ]),
          LogbookCase.aggregate([
            {
              $match: {
                preceptor_id: preceptorId,
                procedure_id: { $in: allProcIds },
                evaluation_status: { $in: ['approved', 'rejected'] },
                evaluated_at: { $gte: sixMonthsAgo },
              },
            },
            { $lookup: { from: 'procedures', localField: 'procedure_id', foreignField: '_id', as: 'procedure' } },
            { $unwind: '$procedure' },
            {
              $group: {
                _id: {
                  course_id: '$procedure.course_id',
                  day: { $dateToString: { format: '%Y-%m-%d', date: '$evaluated_at', timezone: 'Asia/Bangkok' } },
                },
                count: { $sum: 1 },
              },
            },
          ]),
        ])
      : [[], []];

    const toCountMap = (items) => new Map(items.map((item) => [String(item._id), item.count]));
    const studentsByCourse = toCountMap(studentCounts);
    const locationsByCourse = toCountMap(locationCounts);
    const proceduresByCourse = new Map();
    proceduresInCourses.forEach((proc) => {
      const cid = String(proc.course_id);
      proceduresByCourse.set(cid, (proceduresByCourse.get(cid) || 0) + 1);
    });
    const caseStatsByCourse = new Map(courseCaseStats.map((item) => [String(item._id), item]));

    const assignedCourses = courses.map((course) => {
      const cid = String(course._id);
      const cStats = caseStatsByCourse.get(cid);
      const cApproved = cStats?.approvedCases || 0;
      const cRejected = cStats?.rejectedCases || 0;
      const cEvaluated = cApproved + cRejected;
      const cRecent = cStats?.recentCases || 0;
      const cPrevious = cStats?.previousCases || 0;
      const cGrowth = cPrevious > 0 ? Math.round(((cRecent - cPrevious) / cPrevious) * 100) : (cRecent > 0 ? 100 : 0);

      const courseGraphBundle = buildGraphDataByRange(
        courseDailyStats,
        (item) => String(item._id.course_id) === cid
      );

      return {
        ...course,
        studentCount: studentsByCourse.get(cid) || 0,
        procedureCount: proceduresByCourse.get(cid) || 0,
        locationCount: locationsByCourse.get(cid) || 0,
        evaluatedCases: cEvaluated,
        approvedCases: cApproved,
        pendingCases: cStats?.pendingCases || 0,
        passingRate: cEvaluated > 0 ? Math.round((cApproved / cEvaluated) * 100) : 0,
        performanceGrowth: cGrowth,
        averageScore: cApproved > 0 ? Number((cStats.totalScore || 0) / cApproved) : 0,
        graphData: courseGraphBundle.monthly,
        graphDataByRange: courseGraphBundle,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        evaluatedCases,
        approvedCases,
        pendingCases,
        verifiedShifts,
        pendingShifts,
        totalStudents: studentStats[0]?.totalStudents || 0,
        unreadNotificationsCount: unreadCount,
        graphData,
        graphDataByRange,
        passingRate,
        performanceGrowth: growthPercentage,
        averageScore: Number(scoreOverallStats[0]?.average || 0),
        assignedCourses,
      },
    });
  } catch (err) {
    console.error('Get preceptor dashboard stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

exports.getAdminStats = async (req, res) => {
  try {
    const [
      usersByRole,
      totalLocations,
      totalCourses,
      totalProcedures,
      procedureStats,
      caseStats,
      pendingCaseStats,
      approvedStudentProcedureStats,
      unreadNotificationsCount,
    ] = await Promise.all([
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
      Location.countDocuments(),
      Course.countDocuments(),
      Procedure.countDocuments(),
      Procedure.find().lean(),
      LogbookCase.aggregate([
        { $match: { evaluation_status: 'approved' } },
        { $group: { _id: '$procedure_id', count: { $sum: 1 }, avgScore: { $avg: '$evaluation_result' } } },
      ]),
      LogbookCase.aggregate([
        { $match: { evaluation_status: 'pending' } },
        { $group: { _id: '$procedure_id', count: { $sum: 1 } } },
      ]),
      LogbookCase.aggregate([
        { $match: { evaluation_status: 'approved' } },
        {
          $group: {
            _id: { student_id: '$student_id', procedure_id: '$procedure_id' },
            count: { $sum: 1 },
          },
        },
      ]),
      Notification.countDocuments({ recipient_id: req.user.id, is_read: false }),
    ]);

    const roleCounts = usersByRole.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, { student: 0, preceptor: 0, course_instructor: 0, admin: 0 });

    const totalUsers = Object.values(roleCounts).reduce((a, b) => a + b, 0);
    const sixMonthsAgo = getSixMonthStart();

    const [courseAssignments, dailyProcedureStats, populatedCourses] = await Promise.all([
      CourseAssignment.find({ status: 'active' }).populate('user_id', 'year').lean(),
      LogbookCase.aggregate([
        { $match: { evaluation_status: 'approved', evaluated_at: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: {
              procedure_id: '$procedure_id',
              day: { $dateToString: { format: '%Y-%m-%d', date: '$evaluated_at', timezone: 'Asia/Bangkok' } },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      Course.find().populate({
        path: 'enrolled_students',
        select: 'year',
        model: 'User',
      }).lean(),
    ]);

    const pendingByProcMap = new Map(pendingCaseStats.map((item) => [String(item._id), item.count]));

    const courseProgress = populatedCourses.map((course) => {
      const courseIdStr = course._id.toString();
      const courseAssignmentsForCourse = courseAssignments.filter(
        (assignment) => String(assignment.course_id) === courseIdStr
      );
      const assignedStudents = courseAssignmentsForCourse
        .filter((assignment) => assignment.assignment_role === 'student' && assignment.user_id)
        .map((assignment) => assignment.user_id);
      const enrolledStudentMap = new Map();
      [...(course.enrolled_students || []), ...assignedStudents].forEach((student) => {
        if (student?._id) enrolledStudentMap.set(String(student._id), student);
      });
      const enrolledStudents = [...enrolledStudentMap.values()];
      const enrolledStudentIds = new Set(enrolledStudents.map((student) => String(student._id)));
      const preceptorCount = new Set(courseAssignmentsForCourse
        .filter((assignment) => assignment.assignment_role === 'preceptor' && assignment.user_id)
        .map((assignment) => String(assignment.user_id._id))).size;

      const courseStudentsByYear = enrolledStudents.reduce((acc, s) => {
        if (s && s.year) {
          acc[s.year] = (acc[s.year] || 0) + 1;
        }
        return acc;
      }, {});

      const courseProcedures = procedureStats.filter((p) => p.course_id.toString() === courseIdStr);
      const totalRequiredPerStudent = courseProcedures.reduce((sum, p) => sum + (p.required_cases || p.target_score || 1), 0);
      const targetCases = totalRequiredPerStudent * enrolledStudents.length;

      const requiredByProcedure = new Map(courseProcedures.map((procedure) => [
        String(procedure._id),
        Number(procedure.required_cases || procedure.target_score || 1),
      ]));
      const approvedCases = approvedStudentProcedureStats
        .filter((stat) => enrolledStudentIds.has(String(stat._id.student_id)) && requiredByProcedure.has(String(stat._id.procedure_id)))
        .reduce((sum, stat) => sum + Math.min(stat.count, requiredByProcedure.get(String(stat._id.procedure_id))), 0);

      const pendingCases = courseProcedures.reduce(
        (sum, procedure) => sum + (pendingByProcMap.get(String(procedure._id)) || 0),
        0
      );

      const procedureIds = new Set(courseProcedures.map((procedure) => String(procedure._id)));
      const courseGraphBundle = buildGraphDataByRange(
        dailyProcedureStats,
        (stat) => procedureIds.has(String(stat._id.procedure_id))
      );

      const courseScoreStats = caseStats.filter((cs) => courseProcedures.some((cp) => String(cp._id) === String(cs._id)));
      const scoredCases = courseScoreStats.reduce((sum, stat) => sum + stat.count, 0);
      const averageScore = scoredCases > 0
        ? courseScoreStats.reduce((sum, stat) => sum + (Number(stat.avgScore || 0) * stat.count), 0) / scoredCases
        : 0;

      return {
        _id: course._id,
        course_name: course.course_name,
        course_code: course.course_code,
        semester: course.semester,
        year: course.year,
        targetCases,
        approvedCases,
        pendingCases,
        progressPercent: targetCases > 0 ? Math.min(100, (approvedCases / targetCases) * 100) : 0,
        studentCount: enrolledStudents.length,
        studentsCount: enrolledStudents.length,
        preceptorCount,
        procedureCount: courseProcedures.length,
        studentsByYear: courseStudentsByYear,
        graphData: courseGraphBundle.monthly,
        graphDataByRange: courseGraphBundle,
        averageScore,
      };
    });

    const dailyStats = await LogbookCase.aggregate([
      {
        $match: {
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
    ]);

    const graphDataByRange = buildGraphDataByRange(dailyStats);
    const graphData = graphDataByRange.monthly;

    const totalTargetCases = courseProgress.reduce((sum, c) => sum + c.targetCases, 0);
    const totalCappedApprovedCases = courseProgress.reduce((sum, c) => sum + c.approvedCases, 0);
    const totalPendingCases = pendingCaseStats.reduce((sum, item) => sum + item.count, 0);

    const averageScore = caseStats.length > 0
      ? (caseStats.reduce((sum, cs) => sum + (cs.avgScore || 0), 0) / caseStats.length).toFixed(2)
      : 0;

    return res.status(200).json({
      success: true,
      data: {
        totalUsers,
        usersByRole: roleCounts,
        totalProcedures,
        totalLocations,
        totalCourses,
        courseProgress,
        graphData,
        graphDataByRange,
        overallProgress: totalTargetCases > 0 ? Math.min(100, (totalCappedApprovedCases / totalTargetCases) * 100) : 0,
        totalTargetCases,
        totalApprovedCases: totalCappedApprovedCases,
        totalPendingCases,
        averageScore,
        unreadNotificationsCount,
      },
    });
  } catch (err) {
    console.error('Get admin dashboard stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

const normalizeSemesterFilter = (semester) => {
  const raw = String(semester || 'all').trim();
  if (!raw || raw === 'all' || raw === 'ทั้งหมด') {
    return 'all';
  }
  return raw;
};

const compareSemestersDesc = (a, b) => {
  const semA = parseSemesterSortKey(a);
  const semB = parseSemesterSortKey(b);
  if (semA.year !== semB.year) return semB.year - semA.year;
  if (semA.term !== semB.term) return semB.term - semA.term;
  return semB.raw.localeCompare(semA.raw, 'th', { numeric: true });
};

const computeStudentProgressOverview = async (reqUser, semesterFilter = 'all') => {
  const activeSemester = normalizeSemesterFilter(semesterFilter);
  const isInstructor = reqUser.role === 'course_instructor';
  const accessibleCourseIds = isInstructor
    ? await getAccessibleCourseIds(reqUser, ['course_instructor'])
    : null;
  const accessibleCourseSet = accessibleCourseIds ? new Set(accessibleCourseIds.map(String)) : null;

  const students = await User.find({ role: 'student' })
    .select('firstname_lastname profile_image student_id year semester enrolled_courses createdAt')
    .lean();

  if (!students || students.length === 0) {
    return { results: [], availableSemesters: [], isInstructor, accessibleCourseSet, exportCourseIds: null, activeSemester };
  }

  const studentIds = students.map((s) => s._id);

  const [studentAssignments, allCourses, allEvaluatedCases, allShifts, allProcedures] = await Promise.all([
    CourseAssignment.find({ user_id: { $in: studentIds }, assignment_role: 'student', status: 'active' })
      .select('user_id course_id')
      .lean(),
    Course.find()
      .select('_id course_code course_name semester enrolled_students')
      .lean(),
    LogbookCase.find({
      student_id: { $in: studentIds },
      evaluation_status: { $in: ['approved', 'rejected'] },
    }).lean(),
    Shift.find({ student_id: { $in: studentIds } }).lean(),
    Procedure.find().lean(),
  ]);

  const studentCoursesMap = new Map();
  students.forEach((student) => {
    const set = new Set((student.enrolled_courses || []).map(String));
    studentCoursesMap.set(String(student._id), set);
  });
  studentAssignments.forEach((assignment) => {
    const sid = String(assignment.user_id);
    if (studentCoursesMap.has(sid)) studentCoursesMap.get(sid).add(String(assignment.course_id));
  });

  const courseSemesterMap = new Map();
  const courseNameMap = new Map();
  allCourses.forEach((course) => {
    const cid = String(course._id);
    const sem = String(course.semester || '').trim();
    if (sem) {
      courseSemesterMap.set(cid, sem);
    }
    const code = String(course.course_code || '').trim();
    const name = String(course.course_name || '').trim();
    const label = code && name ? `${code} - ${name}` : (name || code);
    if (label) {
      courseNameMap.set(cid, label);
    }
    (course.enrolled_students || []).forEach((sid) => {
      const key = String(sid);
      if (studentCoursesMap.has(key)) studentCoursesMap.get(key).add(cid);
    });
  });

  const availableSemesterSet = new Set();

  const results = students.reduce((acc, student) => {
    const studentId = student._id.toString();
    const rawCourseIds = [...(studentCoursesMap.get(studentId) || [])];
    const scopedCourseIds = accessibleCourseSet
      ? rawCourseIds.filter((cid) => accessibleCourseSet.has(cid))
      : rawCourseIds;

    if (isInstructor && scopedCourseIds.length === 0) {
      return acc;
    }

    const courseSemesters = [...new Set(
      scopedCourseIds
        .map((cid) => courseSemesterMap.get(cid))
        .filter(Boolean)
    )];
    const fallbackSemester = !isInstructor ? String(student.semester || '').trim() : '';
    const studentSemesters = (courseSemesters.length > 0
      ? courseSemesters
      : (fallbackSemester ? [fallbackSemester] : [])
    ).sort(compareSemestersDesc);

    studentSemesters.forEach((sem) => availableSemesterSet.add(sem));

    if (activeSemester !== 'all' && !studentSemesters.includes(activeSemester)) {
      return acc;
    }

    const effectiveCourseIds = activeSemester !== 'all'
      ? scopedCourseIds.filter((cid) => courseSemesterMap.get(cid) === activeSemester)
      : scopedCourseIds;
    const effectiveCourseSet = new Set(effectiveCourseIds);
    const shouldScopeRecordsToCourses = isInstructor || activeSemester !== 'all';

    const studentProcedures = allProcedures.filter((p) =>
      p.course_id && effectiveCourseSet.has(p.course_id.toString())
    );
    const scopedProcedureIdSet = new Set(studentProcedures.map((p) => String(p._id)));

    const studentCases = allEvaluatedCases.filter((c) => {
      if (c.student_id.toString() !== studentId) return false;
      if (!shouldScopeRecordsToCourses) return true;
      return scopedProcedureIdSet.has(String(c.procedure_id));
    });
    const studentShifts = allShifts.filter((s) => {
      if (s.student_id.toString() !== studentId) return false;
      if (!shouldScopeRecordsToCourses) return true;
      return s.course_id ? effectiveCourseSet.has(String(s.course_id)) : false;
    });

    let cappedCompletedCases = 0;
    let totalRequiredCases = 0;

    const approvedCases = studentCases.filter((c) => c.evaluation_status === 'approved');
    const totalEvaluatedCount = studentCases.length;
    const approvedWithScore = approvedCases.filter((c) => (c.evaluation_result || 0) > 0).length;
    const evaluationPct = totalEvaluatedCount > 0 ? Math.round((approvedWithScore / totalEvaluatedCount) * 100) : 0;

    studentProcedures.forEach((proc) => {
      const pid = proc._id.toString();
      const target = proc.required_cases || proc.target_score || 1;
      const approvedForThisProc = approvedCases.filter((c) => c.procedure_id.toString() === pid).length;

      totalRequiredCases += target;
      cappedCompletedCases += Math.min(approvedForThisProc, target);
    });

    const rawCompletedCasesCount = approvedCases.length;
    const totalShifts = studentShifts.length;
    const verifiedShifts = studentShifts.filter((s) => s.verify_status === 'verified').length;
    const attendancePct = totalShifts > 0 ? Math.round((verifiedShifts / totalShifts) * 100) : 0;

    const totalScore = approvedCases.reduce((sum, c) => sum + (c.evaluation_result || 0), 0);
    const avgScoreRaw = rawCompletedCasesCount > 0 ? (totalScore / rawCompletedCasesCount) : 0;
    const avgScorePct = Math.round((avgScoreRaw / 4) * 100);

    let latestCaseTime = 0;
    studentCases.forEach((c) => {
      const ts = new Date(c.evaluated_at || c.case_date || c.createdAt || 0).getTime();
      if (Number.isFinite(ts) && ts > latestCaseTime) {
        latestCaseTime = ts;
      }
    });

    const displayedSemesters = activeSemester !== 'all' ? [activeSemester] : studentSemesters;
    const enrolledCourseNames = [...new Set(
      effectiveCourseIds
        .map((cid) => courseNameMap.get(cid))
        .filter(Boolean)
    )];

    acc.push({
      _id: student._id,
      firstname_lastname: student.firstname_lastname,
      profile_image: student.profile_image,
      student_id: student.student_id,
      year: student.year,
      semester: displayedSemesters.length > 0 ? displayedSemesters.join(', ') : '-',
      semesters: studentSemesters,
      approvedCases: cappedCompletedCases,
      targetCases: totalRequiredCases,
      overallProgress: evaluationPct,
      attendance_pct: attendancePct,
      avg_score_pct: avgScorePct,
      enrolled_courses_count: effectiveCourseIds.length,
      enrolled_course_names: enrolledCourseNames.length > 0 ? enrolledCourseNames.join(', ') : '-',
      latestCaseAt: latestCaseTime > 0 ? new Date(latestCaseTime) : null,
      createdAt: student.createdAt || null,
    });

    return acc;
  }, []);

  let exportCourseIds = null;
  if (isInstructor || activeSemester !== 'all') {
    exportCourseIds = allCourses
      .filter((course) => {
        const cid = String(course._id);
        if (accessibleCourseSet && !accessibleCourseSet.has(cid)) return false;
        if (activeSemester !== 'all' && String(course.semester || '').trim() !== activeSemester) return false;
        return true;
      })
      .map((course) => course._id);
  }

  const availableSemesters = [...availableSemesterSet].sort(compareSemestersDesc);

  return {
    results,
    availableSemesters,
    isInstructor,
    accessibleCourseSet,
    exportCourseIds,
    activeSemester,
  };
};

exports.getStudentProgress = async (req, res) => {
  try {
    const { results, availableSemesters } = await computeStudentProgressOverview(req.user, req.query.semester);

    return res.status(200).json({
      success: true,
      data: results,
      availableSemesters,
    });
  } catch (err) {
    console.error('Get student progress error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

exports.getAdminStudentStats = async (req, res) => {
  try {
    const { id: studentIdStr } = req.params;
    if (!mongoose.Types.ObjectId.isValid(studentIdStr)) {
      return res.status(400).json({ success: false, message: 'Invalid student ID' });
    }
    const studentId = new mongoose.Types.ObjectId(studentIdStr);

    const studentContext = await getStudentCourses(studentId);
    if (!studentContext) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const user = studentContext.user;
    let enrolledCourses = studentContext.courses.filter((c) => !c.is_archived);
    const isInstructor = req.user.role === 'course_instructor';

    if (isInstructor) {
      const accessibleCourseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
      const accessibleSet = new Set(accessibleCourseIds.map(String));
      const hasAccessToStudent = studentContext.courses.some((c) => accessibleSet.has(String(c._id)));
      if (!hasAccessToStudent) {
        return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนักศึกษารายนี้' });
      }
      enrolledCourses = enrolledCourses.filter((c) => accessibleSet.has(String(c._id)));
    }

    const metrics = await computeStudentDashboardMetrics({
      studentId,
      courses: enrolledCourses,
      scopeToCourses: isInstructor,
    });

    return res.status(200).json({
      success: true,
      data: {
        studentInfo: {
          firstname_lastname: user.firstname_lastname,
          profile_image: user.profile_image,
          student_id: user.student_id,
          year: user.year,
          role: user.role,
        },
        totalCases: metrics.summary.totalCases,
        approvedCases: metrics.summary.approvedCases,
        pendingCases: metrics.summary.pendingCases,
        rejectedCases: metrics.summary.rejectedCases,
        verifiedShifts: metrics.sSummary.verifiedShifts,
        pendingShifts: metrics.sSummary.pendingShifts,
        normalShifts: metrics.sSummary.normalShifts,
        lateShifts: metrics.sSummary.lateShifts,
        absentShifts: metrics.sSummary.absentShifts,
        leaveShifts: metrics.sSummary.leaveShifts,
        courseProgress: metrics.courseProgress,
        graphData: metrics.graphData,
        graphDataByRange: metrics.graphDataByRange,
        overallProgress: Math.min(Math.max(metrics.calculatedOverallProgress || 0, 0), 100),
        totalProceduresCount: metrics.totalProceduresCount,
        totalProceduresDone: metrics.totalProceduresDone,
        averageScore: metrics.calculatedGPA,
      },
    });
  } catch (err) {
    console.error('Get admin student detail stats error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getAdminStudentProcedureStats = async (req, res) => {
  try {
    const { id: studentIdStr, course_id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(studentIdStr) || !mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({ success: false, message: 'Invalid ID' });
    }
    if (req.user.role === 'course_instructor') {
      const canManage = await canManageCourse(req.user, course_id);
      if (!canManage) {
        return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์เข้าถึงรายวิชานี้' });
      }
    }
    const studentId = new mongoose.Types.ObjectId(studentIdStr);

    const [course, procedures] = await Promise.all([
      Course.findById(course_id),
      Procedure.find({ course_id }),
    ]);

    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    if (!procedures || procedures.length === 0) return res.status(200).json({ success: true, data: [] });

    const stats = await LogbookCase.aggregate([
      { $match: { student_id: studentId, procedure_id: { $in: procedures.map((p) => p._id) } } },
      {
        $group: {
          _id: { procedure_id: '$procedure_id', status: '$evaluation_status' },
          count: { $sum: 1 },
          totalScore: { $sum: '$evaluation_result' },
        },
      },
    ]);

    const statsMap = stats.reduce((acc, curr) => {
      const pid = curr._id.procedure_id.toString();
      const status = curr._id.status;
      if (!acc[pid]) acc[pid] = { approved: 0, pending: 0, rejected: 0, approvedScore: 0 };
      acc[pid][status] = curr.count;
      if (status === 'approved') {
        acc[pid].approvedScore = curr.totalScore || 0;
      }
      return acc;
    }, {});

    const results = procedures.map((p) => {
      const pid = p._id.toString();
      const s = statsMap[pid] || { approved: 0, pending: 0, rejected: 0, approvedScore: 0 };
      const target = p.required_cases || 1;
      const obtainedScore = target > 0 ? (s.approvedScore / (target * 4)) * p.target_score : 0;

      return {
        _id: p._id,
        procedure_name: p.procedure_name,
        approvedCount: s.approved,
        pendingCount: s.pending,
        rejectedCount: s.rejected,
        targetCount: target,
        obtainedScore,
        targetScore: p.target_score,
        averageScore: s.approved > 0 ? s.approvedScore / s.approved : 0,
        progressPercent: Math.min((s.approved / target) * 100, 100),
      };
    });

    return res.status(200).json({ success: true, data: results });
  } catch (err) {
    console.error('Get admin student procedure stats error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getAdminStudentCases = async (req, res) => {
  try {
    const { id: studentIdStr } = req.params;
    const { course_id: courseIdParam, procedure_id: procedureIdParam, status: statusParam } = req.query;

    if (!mongoose.Types.ObjectId.isValid(studentIdStr)) {
      return res.status(400).json({ success: false, message: 'Invalid student ID' });
    }
    if (courseIdParam && !mongoose.Types.ObjectId.isValid(courseIdParam)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }
    if (procedureIdParam && !mongoose.Types.ObjectId.isValid(procedureIdParam)) {
      return res.status(400).json({ success: false, message: 'Invalid procedure ID' });
    }

    const studentId = new mongoose.Types.ObjectId(studentIdStr);
    const studentContext = await getStudentCourses(studentId);
    if (!studentContext) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const caseFilter = { student_id: studentId };
    let allowedProcedureIds = null;

    if (req.user.role === 'course_instructor') {
      const accessibleCourseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
      const accessibleSet = new Set(accessibleCourseIds.map(String));
      const hasAccessToStudent = studentContext.courses.some((c) => accessibleSet.has(String(c._id)));
      if (!hasAccessToStudent) {
        return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนักศึกษารายนี้' });
      }
      if (courseIdParam && !accessibleSet.has(String(courseIdParam))) {
        return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์เข้าถึงรายวิชานี้' });
      }
      const targetCourseIds = courseIdParam ? [courseIdParam] : accessibleCourseIds;
      allowedProcedureIds = await Procedure.find({ course_id: { $in: targetCourseIds } }).distinct('_id');
    } else if (courseIdParam) {
      allowedProcedureIds = await Procedure.find({ course_id: courseIdParam }).distinct('_id');
    }

    if (procedureIdParam) {
      if (allowedProcedureIds !== null) {
        const allowedSet = new Set(allowedProcedureIds.map(String));
        if (!allowedSet.has(String(procedureIdParam))) {
          return res.status(200).json({ success: true, data: [] });
        }
      }
      caseFilter.procedure_id = procedureIdParam;
    } else if (allowedProcedureIds !== null) {
      caseFilter.procedure_id = { $in: allowedProcedureIds };
    }

    if (statusParam && ['pending', 'approved', 'rejected'].includes(statusParam)) {
      caseFilter.evaluation_status = statusParam;
    }

    const cases = await LogbookCase.find(caseFilter)
      .populate({
        path: 'procedure_id',
        select: 'procedure_name required_cases target_score course_id',
        populate: { path: 'course_id', select: 'course_code course_name evaluation_type' },
      })
      .populate('preceptor_id', 'firstname_lastname profile_image')
      .populate('location_id', 'Location_name')
      .sort({ case_date: -1, createdAt: -1 })
      .lean();

    // Compute chronological sequence number within each procedure for clean "ครั้งที่ X/Y" display.
    const groupedByProc = new Map();
    [...cases]
      .sort((a, b) => new Date(a.case_date).getTime() - new Date(b.case_date).getTime())
      .forEach((item) => {
        const pid = String(item.procedure_id?._id || '');
        if (!pid) return;
        const seq = (groupedByProc.get(pid) || 0) + 1;
        groupedByProc.set(pid, seq);
        item.caseSequence = seq;
      });

    return res.status(200).json({
      success: true,
      data: cases,
    });
  } catch (err) {
    console.error('Get admin student cases error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getAdminCourseSkillsStats = async (req, res) => {
  try {
    const { course_id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const { notFound, data } = await computeCourseSkillsStats(course_id);
    if (notFound) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('Get admin course skills stats error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

const fetchExportDetailRecords = async ({ type, studentIds, exportCourseIds }) => {
  if (!studentIds || studentIds.length === 0) return [];
  if (Array.isArray(exportCourseIds) && exportCourseIds.length === 0) return [];

  if (type === 'attendance') {
    const shiftQuery = { student_id: { $in: studentIds } };
    if (Array.isArray(exportCourseIds)) {
      shiftQuery.course_id = { $in: exportCourseIds };
    }

    const shifts = await Shift.find(shiftQuery)
      .populate('student_id', 'firstname_lastname student_id year')
      .populate('course_id', 'course_code course_name')
      .populate('location_id', 'Location_name')
      .populate('preceptor_id', 'firstname_lastname')
      .sort({ shift_date: -1 })
      .lean();

    return shifts.map((shift) => ({
      studentId: String(shift.student_id?.student_id || '-'),
      studentName: shift.student_id?.firstname_lastname || '-',
      year: shift.student_id?.year ? Number(shift.student_id.year) : '-',
      shiftDate: toBangkokExcelDate(shift.shift_date),
      courseCode: shift.course_id?.course_code || '-',
      courseName: shift.course_id?.course_name || '-',
      locationName: shift.location_id?.Location_name || '-',
      preceptorName: shift.preceptor_id?.firstname_lastname || '-',
      shiftStatus: shift.shift_status || '-',
      verifyStatus: shift.verify_status || 'pending',
      verifiedAt: toBangkokExcelDate(shift.verified_at),
    }));
  }

  let procedureScopeIds = null;
  if (Array.isArray(exportCourseIds)) {
    const scopedProcs = await Procedure.find({ course_id: { $in: exportCourseIds } })
      .select('_id')
      .lean();
    procedureScopeIds = scopedProcs.map((p) => p._id);
    if (procedureScopeIds.length === 0) return [];
  }

  const caseQuery = { student_id: { $in: studentIds } };
  if (procedureScopeIds) {
    caseQuery.procedure_id = { $in: procedureScopeIds };
  }

  const cases = await LogbookCase.find(caseQuery)
    .populate('student_id', 'firstname_lastname student_id year')
    .populate({
      path: 'procedure_id',
      select: 'procedure_name course_id',
      populate: { path: 'course_id', select: 'course_code course_name evaluation_type' },
    })
    .populate('location_id', 'Location_name')
    .populate('preceptor_id', 'firstname_lastname')
    .sort({ case_date: -1, createdAt: -1 })
    .lean();

  return cases.map((item) => {
    const course = item.procedure_id?.course_id;
    const rawScore = typeof item.evaluation_result === 'number' ? item.evaluation_result : null;
    const normalizedScore = item.evaluation_status === 'approved' && rawScore !== null
      ? (course?.evaluation_type === 'Pass/Fail' ? rawScore * 4 : rawScore)
      : null;

    return {
      studentId: String(item.student_id?.student_id || '-'),
      studentName: item.student_id?.firstname_lastname || '-',
      year: item.student_id?.year ? Number(item.student_id.year) : '-',
      caseDate: toBangkokExcelDate(item.case_date || item.createdAt),
      courseCode: course?.course_code || '-',
      courseName: course?.course_name || '-',
      procedureName: item.procedure_id?.procedure_name || '-',
      locationName: item.location_id?.Location_name || '-',
      preceptorName: item.preceptor_id?.firstname_lastname || '-',
      evaluationStatus: item.evaluation_status || 'pending',
      score: normalizedScore,
      evaluatedAt: toBangkokExcelDate(item.evaluated_at),
      feedback: item.feedback || '-',
    };
  });
};

exports.exportYearlyProgressExcel = async (req, res) => {
  try {
    const type = req.query.type === 'attendance' ? 'attendance' : 'procedures';
    const yearParam = String(req.query.year || 'all').trim();
    const semesterParam = normalizeSemesterFilter(req.query.semester);
    const searchParam = String(req.query.search || '').trim();
    const searchLower = searchParam.toLowerCase();

    const { results, exportCourseIds, activeSemester } = await computeStudentProgressOverview(req.user, semesterParam);

    const filteredStudents = results
      .filter((student) => {
        const matchesYear = yearParam === 'all' || String(student.year) === yearParam;
        if (!matchesYear) return false;
        if (!searchLower) return true;
        const name = String(student.firstname_lastname || '').toLowerCase();
        const code = String(student.student_id || '').toLowerCase();
        return name.includes(searchLower) || code.includes(searchLower);
      })
      .sort((a, b) => String(a.student_id || '').localeCompare(String(b.student_id || ''), 'en', { numeric: true }));

    const studentIds = filteredStudents.map((s) => s._id);
    const records = await fetchExportDetailRecords({
      type,
      studentIds,
      exportCourseIds,
    });

    const baseYearLabel = yearParam === 'all' ? 'ทุกชั้นปี' : `ชั้นปีที่ ${yearParam}`;
    const yearLabel = activeSemester === 'all' ? baseYearLabel : `${baseYearLabel} (เทอม ${activeSemester})`;
    const workbook = buildYearlyReportWorkbook({
      type,
      yearLabel,
      searchTerm: searchParam,
      students: filteredStudents,
      records,
    });

    const safeYearSlug = yearParam === 'all' ? 'all_years' : `year_${yearParam}`;
    const safeSemesterSlug = activeSemester === 'all' ? '' : `_sem_${activeSemester.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
    return await writeWorkbookToResponse(res, workbook, `yearly_report_${safeYearSlug}${safeSemesterSlug}_${type}.xlsx`);
  } catch (err) {
    console.error('Export yearly progress Excel error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'ไม่สามารถส่งออกรายงาน Excel ได้' });
    }
    return res.end();
  }
};

exports.exportStudentDetailExcel = async (req, res) => {
  try {
    const { id: studentIdStr } = req.params;
    const type = req.query.type === 'attendance' ? 'attendance' : 'procedures';

    if (!mongoose.Types.ObjectId.isValid(studentIdStr)) {
      return res.status(400).json({ success: false, message: 'Invalid student ID' });
    }
    const studentId = new mongoose.Types.ObjectId(studentIdStr);
    const studentContext = await getStudentCourses(studentId);
    if (!studentContext) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const user = studentContext.user;
    let enrolledCourses = studentContext.courses.filter((c) => !c.is_archived);
    const isInstructor = req.user.role === 'course_instructor';
    let accessibleCourseSet = null;

    if (isInstructor) {
      const accessibleCourseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
      accessibleCourseSet = new Set(accessibleCourseIds.map(String));
      const hasAccessToStudent = studentContext.courses.some((c) => accessibleCourseSet.has(String(c._id)));
      if (!hasAccessToStudent) {
        return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนักศึกษารายนี้' });
      }
      enrolledCourses = enrolledCourses.filter((c) => accessibleCourseSet.has(String(c._id)));
    }

    const [metrics, records] = await Promise.all([
      computeStudentDashboardMetrics({
        studentId,
        courses: enrolledCourses,
        scopeToCourses: isInstructor,
      }),
      fetchExportDetailRecords({
        type,
        studentIds: [studentId],
        exportCourseIds: isInstructor && accessibleCourseSet ? [...accessibleCourseSet] : null,
      }),
    ]);

    const workbook = buildStudentReportWorkbook({
      type,
      student: user,
      courseProgress: metrics.courseProgress,
      overallStats: {
        averageScore: metrics.calculatedGPA,
      },
      records,
    });

    const studentSlug = user.student_id || studentIdStr;
    return await writeWorkbookToResponse(res, workbook, `${type}_${studentSlug}.xlsx`);
  } catch (err) {
    console.error('Export student detail Excel error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'ไม่สามารถส่งออกรายงาน Excel ได้' });
    }
    return res.end();
  }
};
