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
  computePreceptorProgressOverview,
  computePreceptorDetailStats,
} = require('../services/preceptorProgressService');
const {
  normalizeEvaluationScore,
  mongoNormalizedScoreForCourseType,
} = require('../utils/scoreUtils');
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
const { getOrCompute } = require('../services/dashboardCacheService');

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

const computeStudentDashboardMetrics = async ({
  studentId,
  courses,
  allKnownCourses = courses,
  scopeToCourses = false,
}) => {
  const courseIds = courses.map((course) => course._id);
  const allProceduresInCourses = courseIds.length > 0
    ? await Procedure.find({ course_id: { $in: courseIds } })
        .select('_id course_id required_cases target_score')
        .lean()
    : [];
  const scopedProcedureIds = allProceduresInCourses.map((proc) => proc._id);
  const sixMonthsAgo = getSixMonthStart();

  const baseCaseMatch = scopeToCourses
    ? { student_id: studentId, procedure_id: { $in: scopedProcedureIds } }
    : { student_id: studentId };

  const [caseStatusGroups, shiftSummary, dailyByProcStats] = await Promise.all([
    LogbookCase.aggregate([
      { $match: baseCaseMatch },
      {
        $group: {
          _id: {
            procedure_id: '$procedure_id',
            status: '$evaluation_status',
          },
          count: { $sum: 1 },
          rawScoreSum: { $sum: { $ifNull: ['$evaluation_result', 0] } },
          positivePassCount: {
            $sum: {
              $cond: [{ $gt: [{ $ifNull: ['$evaluation_result', 0] }, 0] }, 1, 0],
            },
          },
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
      {
        $group: {
          _id: {
            procedure_id: '$procedure_id',
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: { $ifNull: ['$evaluated_at', '$createdAt'] },
                timezone: 'Asia/Bangkok',
              },
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]),
  ]);

  const courseEvalTypeMap = new Map();
  [...(allKnownCourses || []), ...(courses || [])].forEach((c) => {
    if (c && c._id) courseEvalTypeMap.set(String(c._id), c.evaluation_type);
  });

  const procToCourseMap = new Map();
  allProceduresInCourses.forEach((proc) => {
    procToCourseMap.set(String(proc._id), String(proc.course_id));
  });

  if (!scopeToCourses) {
    const missingProcIds = new Set();
    caseStatusGroups.forEach((g) => {
      const pid = String(g._id.procedure_id || '');
      if (pid && !procToCourseMap.has(pid)) missingProcIds.add(pid);
    });
    dailyByProcStats.forEach((d) => {
      const pid = String(d._id.procedure_id || '');
      if (pid && !procToCourseMap.has(pid)) missingProcIds.add(pid);
    });

    if (missingProcIds.size > 0) {
      const extraProcs = await Procedure.find({ _id: { $in: [...missingProcIds] } })
        .select('_id course_id')
        .populate('course_id', 'evaluation_type')
        .lean();
      extraProcs.forEach((ep) => {
        const cidDoc = ep.course_id;
        const cid = cidDoc?._id ? String(cidDoc._id) : (cidDoc ? String(cidDoc) : '');
        if (cid) {
          procToCourseMap.set(String(ep._id), cid);
          if (cidDoc?.evaluation_type && !courseEvalTypeMap.has(cid)) {
            courseEvalTypeMap.set(cid, cidDoc.evaluation_type);
          }
        }
      });
    }
  }

  const summary = { totalCases: 0, approvedCases: 0, pendingCases: 0, rejectedCases: 0 };
  const sSummary = shiftSummary[0] || {
    verifiedShifts: 0,
    pendingShifts: 0,
    normalShifts: 0,
    lateShifts: 0,
    absentShifts: 0,
    leaveShifts: 0,
  };

  const approvedProcMap = {};
  const approvedCourseScoreMap = {};
  const approvedCourseCaseCountMap = {};
  const evaluatedCourseCaseCountMap = {};
  const pendingByCourseMap = {};
  let grandTotalScore = 0;
  let grandTotalEvaluatedCases = 0;

  caseStatusGroups.forEach((group) => {
    const pid = String(group._id.procedure_id || '');
    const status = group._id.status;
    const count = group.count || 0;

    summary.totalCases += count;
    if (status === 'approved') summary.approvedCases += count;
    else if (status === 'pending') summary.pendingCases += count;
    else if (status === 'rejected') summary.rejectedCases += count;

    const cid = procToCourseMap.get(pid);
    if (!cid) return;

    if (status === 'pending') {
      pendingByCourseMap[cid] = (pendingByCourseMap[cid] || 0) + count;
      return;
    }

    if (status === 'approved' || status === 'rejected') {
      const evalType = courseEvalTypeMap.get(cid);
      const groupScore = status === 'approved'
        ? (evalType === 'Pass/Fail' ? (group.positivePassCount || 0) * 4 : (group.rawScoreSum || 0))
        : 0;

      if (status === 'approved') {
        approvedProcMap[pid] = (approvedProcMap[pid] || 0) + count;
        approvedCourseCaseCountMap[cid] = (approvedCourseCaseCountMap[cid] || 0) + count;
      }

      approvedCourseScoreMap[cid] = (approvedCourseScoreMap[cid] || 0) + groupScore;
      evaluatedCourseCaseCountMap[cid] = (evaluatedCourseCaseCountMap[cid] || 0) + count;

      grandTotalScore += groupScore;
      grandTotalEvaluatedCases += count;
    }
  });

  const dailyByCourseStats = [];
  const dailyByCourseMap = new Map();
  dailyByProcStats.forEach((item) => {
    const pid = String(item._id.procedure_id || '');
    const cid = procToCourseMap.get(pid);
    if (!cid) return;
    const entry = {
      _id: { course_id: cid, day: item._id.day },
      count: item.count,
    };
    dailyByCourseStats.push(entry);
    if (!dailyByCourseMap.has(cid)) dailyByCourseMap.set(cid, []);
    dailyByCourseMap.get(cid).push(entry);
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
  const calculatedGPA = grandTotalEvaluatedCases > 0 ? (grandTotalScore / grandTotalEvaluatedCases) : 0;

  const courseProgress = courses.map((course) => {
    const cid = course._id.toString();
    const approved = approvedCourseCaseCountMap[cid] || 0;
    const evaluated = evaluatedCourseCaseCountMap[cid] || 0;
    const target = targetMap[cid] || 0;
    const totalScore = approvedCourseScoreMap[cid] || 0;
    const courseGraphBundle = buildGraphDataByRange(dailyByCourseMap.get(cid) || []);

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
      averageScore: evaluated > 0 ? (totalScore / evaluated) : 0,
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
    const studentIdStr = String(req.user.id);
    const studentId = new mongoose.Types.ObjectId(studentIdStr);

    const [{ value: coreData, hit }, unreadNotificationsCount] = await Promise.all([
      getOrCompute(`student:${studentIdStr}`, async () => {
        const studentContext = await getStudentCourses(studentId);
        if (!studentContext) return null;

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

        const metrics = await computeStudentDashboardMetrics({
          studentId,
          courses: activeCourses,
          allKnownCourses: studentContext.courses,
        });

        return {
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
          overallProgress: metrics.calculatedOverallProgress,
          averageScore: metrics.calculatedGPA,
          totalProceduresCount: metrics.totalProceduresCount,
          totalProceduresDone: metrics.totalProceduresDone,
        };
      }),
      Notification.countDocuments({ recipient_id: studentId, is_read: false }),
    ]);

    if (!coreData) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    res.setHeader('X-Dashboard-Cache', hit ? 'HIT' : 'MISS');
    return res.status(200).json({
      success: true,
      data: {
        ...coreData,
        unreadNotificationsCount,
      },
    });
  } catch (err) {
    console.error('Get student dashboard stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

exports.getStudentProcedureStats = async (req, res) => {
  try {
    const studentIdStr = String(req.user.id);
    const studentId = new mongoose.Types.ObjectId(studentIdStr);
    const { course_id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid course_id.',
      });
    }

    const { value: cachedResult, hit } = await getOrCompute(
      `student-course:${studentIdStr}:${String(course_id)}`,
      async () => {
        const [course, procedures] = await Promise.all([
          Course.findById(course_id).select('_id').lean(),
          Procedure.find({ course_id }).lean(),
        ]);

        if (!course) {
          return { notFound: true, data: null };
        }

        if (!procedures || procedures.length === 0) {
          return { notFound: false, data: [] };
        }

        const stats = await LogbookCase.aggregate([
          { $match: { student_id: studentId, procedure_id: { $in: procedures.map((p) => p._id) } } },
          {
            $group: {
              _id: { procedure_id: '$procedure_id', status: '$evaluation_status' },
              count: { $sum: 1 },
              latestCaseAt: { $max: '$case_date' },
            },
          },
        ]);

        const statsMap = stats.reduce((acc, curr) => {
          const pid = curr._id.procedure_id.toString();
          const status = curr._id.status;
          if (!acc[pid]) acc[pid] = { approved: 0, pending: 0, rejected: 0, latestCaseAt: null };
          acc[pid][status] = curr.count;
          if (curr.latestCaseAt && (!acc[pid].latestCaseAt || new Date(curr.latestCaseAt) > new Date(acc[pid].latestCaseAt))) {
            acc[pid].latestCaseAt = curr.latestCaseAt;
          }
          return acc;
        }, {});

        const results = procedures.map((p) => {
          const pid = p._id.toString();
          const s = statsMap[pid] || { approved: 0, pending: 0, rejected: 0, latestCaseAt: null };
          const target = p.required_cases || p.target_score || 1;

          return {
            _id: p._id,
            procedure_name: p.procedure_name,
            approvedCount: s.approved,
            pendingCount: s.pending,
            rejectedCount: s.rejected,
            targetCount: target,
            latestCaseAt: s.latestCaseAt,
            form_structure: p.form_structure || [],
            progressPercent: Math.min((s.approved / target) * 100, 100),
          };
        });

        return { notFound: false, data: results };
      }
    );

    if (cachedResult.notFound) {
      return res.status(404).json({
        success: false,
        message: 'Course not found.',
      });
    }

    res.setHeader('X-Dashboard-Cache', hit ? 'HIT' : 'MISS');
    return res.status(200).json({ success: true, data: cachedResult.data });
  } catch (err) {
    console.error('Get student procedure stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

const computePreceptorCoreStats = async (preceptorId) => {
  const sixMonthsAgo = getSixMonthStart();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  const [
    caseStatsByProc,
    dailyByProcStats,
    studentStats,
    shiftStats,
    courseIds,
  ] = await Promise.all([
    LogbookCase.aggregate([
      { $match: { preceptor_id: preceptorId } },
      {
        $group: {
          _id: '$procedure_id',
          approvedCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'approved'] }, 1, 0] } },
          rejectedCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'rejected'] }, 1, 0] } },
          pendingCases: { $sum: { $cond: [{ $eq: ['$evaluation_status', 'pending'] }, 1, 0] } },
          rawApprovedScoreSum: {
            $sum: {
              $cond: [
                { $eq: ['$evaluation_status', 'approved'] },
                { $ifNull: ['$evaluation_result', 0] },
                0,
              ],
            },
          },
          positiveApprovedPassCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$evaluation_status', 'approved'] },
                    { $gt: [{ $ifNull: ['$evaluation_result', 0] }, 0] },
                  ],
                },
                1,
                0,
              ],
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
          evaluation_status: { $in: ['approved', 'rejected'] },
          evaluated_at: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            procedure_id: '$procedure_id',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$evaluated_at', timezone: 'Asia/Bangkok' } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]),
    LogbookCase.aggregate([
      { $match: { preceptor_id: preceptorId } },
      { $group: { _id: '$student_id' } },
      { $count: 'totalStudents' },
    ]),
    Shift.aggregate([
      { $match: { preceptor_id: preceptorId, verify_status: { $in: ['verified', 'pending'] } } },
      { $group: { _id: '$verify_status', count: { $sum: 1 } } },
    ]),
    CourseAssignment.find({
      user_id: preceptorId,
      assignment_role: 'preceptor',
      status: 'active',
    }).distinct('course_id'),
  ]);

  const shiftCountMap = new Map(shiftStats.map((s) => [s._id, s.count]));
  const verifiedShifts = shiftCountMap.get('verified') || 0;
  const pendingShifts = shiftCountMap.get('pending') || 0;

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

  const courseEvalTypeMap = new Map(courses.map((c) => [String(c._id), c.evaluation_type]));
  const procToCourseMap = new Map();
  const proceduresByCourse = new Map();

  proceduresInCourses.forEach((proc) => {
    const cid = String(proc.course_id);
    const pid = String(proc._id);
    procToCourseMap.set(pid, cid);
    proceduresByCourse.set(cid, (proceduresByCourse.get(cid) || 0) + 1);
  });

  // Resolve any evaluated procedures from archived/unassigned courses for overall score calculation
  const extraProcIds = caseStatsByProc
    .map((item) => String(item._id || ''))
    .filter((pid) => pid && !procToCourseMap.has(pid));

  if (extraProcIds.length > 0) {
    const extraProcs = await Procedure.find({ _id: { $in: extraProcIds } })
      .select('_id course_id')
      .populate('course_id', 'evaluation_type')
      .lean();
    extraProcs.forEach((ep) => {
      const cidDoc = ep.course_id;
      const cid = cidDoc?._id ? String(cidDoc._id) : (cidDoc ? String(cidDoc) : '');
      if (cid) {
        procToCourseMap.set(String(ep._id), cid);
        if (cidDoc?.evaluation_type && !courseEvalTypeMap.has(cid)) {
          courseEvalTypeMap.set(cid, cidDoc.evaluation_type);
        }
      }
    });
  }

  let approvedCases = 0;
  let rejectedCases = 0;
  let pendingCases = 0;
  let recentCases = 0;
  let previousCases = 0;
  let overallScoreSum = 0;
  let overallScoredCount = 0;

  const caseStatsByCourse = new Map();

  caseStatsByProc.forEach((item) => {
    const pid = String(item._id || '');
    const cid = procToCourseMap.get(pid);
    const evalType = cid ? courseEvalTypeMap.get(cid) : undefined;
    const itemApproved = item.approvedCases || 0;
    const itemRejected = item.rejectedCases || 0;
    const itemPending = item.pendingCases || 0;
    const itemEvaluated = itemApproved + itemRejected;
    const itemRecent = item.recentCases || 0;
    const itemPrevious = item.previousCases || 0;
    const itemScoreSum = evalType === 'Pass/Fail'
      ? (item.positiveApprovedPassCount || 0) * 4
      : (item.rawApprovedScoreSum || 0);

    approvedCases += itemApproved;
    rejectedCases += itemRejected;
    pendingCases += itemPending;
    recentCases += itemRecent;
    previousCases += itemPrevious;

    if (cid && itemEvaluated > 0) {
      overallScoreSum += itemScoreSum;
      overallScoredCount += itemEvaluated;
    }

    if (cid) {
      const existing = caseStatsByCourse.get(cid) || {
        approvedCases: 0,
        rejectedCases: 0,
        pendingCases: 0,
        totalScore: 0,
        recentCases: 0,
        previousCases: 0,
      };
      existing.approvedCases += itemApproved;
      existing.rejectedCases += itemRejected;
      existing.pendingCases += itemPending;
      existing.totalScore += itemScoreSum;
      existing.recentCases += itemRecent;
      existing.previousCases += itemPrevious;
      caseStatsByCourse.set(cid, existing);
    }
  });

  const evaluatedCases = approvedCases + rejectedCases;
  const passingRate = evaluatedCases > 0 ? Math.round((approvedCases / evaluatedCases) * 100) : 0;
  let growthPercentage = 0;
  if (previousCases > 0) {
    growthPercentage = Math.round(((recentCases - previousCases) / previousCases) * 100);
  } else if (recentCases > 0) {
    growthPercentage = 100;
  }

  const courseDailyMap = new Map();
  dailyByProcStats.forEach((item) => {
    const cid = procToCourseMap.get(String(item._id.procedure_id || ''));
    if (!cid) return;
    if (!courseDailyMap.has(cid)) courseDailyMap.set(cid, []);
    courseDailyMap.get(cid).push({
      _id: { course_id: cid, day: item._id.day },
      count: item.count,
    });
  });

  const graphDataByRange = buildGraphDataByRange(dailyByProcStats);
  const graphData = graphDataByRange.monthly;

  const toCountMap = (items) => new Map(items.map((item) => [String(item._id), item.count]));
  const studentsByCourse = toCountMap(studentCounts);
  const locationsByCourse = toCountMap(locationCounts);

  const assignedCourses = courses.map((course) => {
    const cid = String(course._id);
    const cStats = caseStatsByCourse.get(cid);
    const cApproved = cStats?.approvedCases || 0;
    const cRejected = cStats?.rejectedCases || 0;
    const cEvaluated = cApproved + cRejected;
    const cRecent = cStats?.recentCases || 0;
    const cPrevious = cStats?.previousCases || 0;
    const cGrowth = cPrevious > 0 ? Math.round(((cRecent - cPrevious) / cPrevious) * 100) : (cRecent > 0 ? 100 : 0);

    const courseGraphBundle = buildGraphDataByRange(courseDailyMap.get(cid) || []);

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
      averageScore: cEvaluated > 0 ? Number((cStats.totalScore || 0) / cEvaluated) : 0,
      graphData: courseGraphBundle.monthly,
      graphDataByRange: courseGraphBundle,
    };
  });

  return {
    evaluatedCases,
    approvedCases,
    pendingCases,
    verifiedShifts,
    pendingShifts,
    totalStudents: studentStats[0]?.totalStudents || 0,
    graphData,
    graphDataByRange,
    passingRate,
    performanceGrowth: growthPercentage,
    averageScore: overallScoredCount > 0 ? Number(overallScoreSum / overallScoredCount) : 0,
    assignedCourses,
  };
};

exports.getPreceptorStats = async (req, res) => {
  try {
    const preceptorIdStr = String(req.user.id);
    const preceptorId = new mongoose.Types.ObjectId(preceptorIdStr);

    const [{ value: coreStats, hit }, unreadCount] = await Promise.all([
      getOrCompute(`preceptor:${preceptorIdStr}`, () => computePreceptorCoreStats(preceptorId)),
      Notification.countDocuments({ recipient_id: preceptorId, is_read: false }),
    ]);

    res.setHeader('X-Dashboard-Cache', hit ? 'HIT' : 'MISS');
    return res.status(200).json({
      success: true,
      data: {
        ...coreStats,
        unreadNotificationsCount: unreadCount,
      },
    });
  } catch (err) {
    console.error('Get preceptor dashboard stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

const computeAdminCoreStats = async () => {
  const sixMonthsAgo = getSixMonthStart();

  const [
    usersByRole,
    totalLocations,
    procedureStats,
    caseProcStatusStats,
    approvedStudentProcedureStats,
    courseAssignments,
    dailyProcedureStats,
    populatedCourses,
  ] = await Promise.all([
    User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    Location.countDocuments(),
    Procedure.find().select('_id course_id required_cases target_score').lean(),
    LogbookCase.aggregate([
      {
        $group: {
          _id: {
            procedure_id: '$procedure_id',
            status: '$evaluation_status',
          },
          count: { $sum: 1 },
          rawScoreSum: { $sum: { $ifNull: ['$evaluation_result', 0] } },
          positivePassCount: {
            $sum: {
              $cond: [{ $gt: [{ $ifNull: ['$evaluation_result', 0] }, 0] }, 1, 0],
            },
          },
        },
      },
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
      { $sort: { '_id.day': 1 } },
    ]),
    Course.find()
      .populate({
        path: 'enrolled_students',
        select: 'year',
        model: 'User',
      })
      .lean(),
  ]);

  const roleCounts = usersByRole.reduce(
    (acc, item) => {
      acc[item._id] = item.count;
      return acc;
    },
    { student: 0, preceptor: 0, course_instructor: 0, admin: 0 }
  );

  const totalUsers = Object.values(roleCounts).reduce((a, b) => a + b, 0);
  const totalCourses = populatedCourses.length;
  const totalProcedures = procedureStats.length;

  const courseEvalTypeMap = new Map(
    populatedCourses.map((course) => [String(course._id), course.evaluation_type])
  );
  const procToCourseMap = new Map();
  const proceduresByCourse = new Map();

  procedureStats.forEach((proc) => {
    const cid = String(proc.course_id);
    const pid = String(proc._id);
    procToCourseMap.set(pid, cid);
    if (!proceduresByCourse.has(cid)) proceduresByCourse.set(cid, []);
    proceduresByCourse.get(cid).push(proc);
  });

  const assignmentsByCourse = new Map();
  courseAssignments.forEach((assignment) => {
    const cid = String(assignment.course_id);
    if (!assignmentsByCourse.has(cid)) assignmentsByCourse.set(cid, []);
    assignmentsByCourse.get(cid).push(assignment);
  });

  const pendingByCourseMap = new Map();
  const scoredCountByCourseMap = new Map();
  const scoreSumByCourseMap = new Map();
  let totalPendingCases = 0;
  let totalScoredCases = 0;
  let grandScoreSum = 0;

  caseProcStatusStats.forEach((stat) => {
    const pid = String(stat._id.procedure_id || '');
    const status = stat._id.status;
    const count = stat.count || 0;
    const cid = procToCourseMap.get(pid);

    if (status === 'pending') {
      totalPendingCases += count;
      if (cid) {
        pendingByCourseMap.set(cid, (pendingByCourseMap.get(cid) || 0) + count);
      }
      return;
    }

    if ((status === 'approved' || status === 'rejected') && cid && courseEvalTypeMap.has(cid)) {
      const evalType = courseEvalTypeMap.get(cid);
      const scoreSum = status === 'approved'
        ? (evalType === 'Pass/Fail' ? (stat.positivePassCount || 0) * 4 : (stat.rawScoreSum || 0))
        : 0;

      scoredCountByCourseMap.set(cid, (scoredCountByCourseMap.get(cid) || 0) + count);
      scoreSumByCourseMap.set(cid, (scoreSumByCourseMap.get(cid) || 0) + scoreSum);
      totalScoredCases += count;
      grandScoreSum += scoreSum;
    }
  });

  const approvedStudentStatsByCourse = new Map();
  approvedStudentProcedureStats.forEach((stat) => {
    const pid = String(stat._id.procedure_id || '');
    const cid = procToCourseMap.get(pid);
    if (!cid) return;
    if (!approvedStudentStatsByCourse.has(cid)) approvedStudentStatsByCourse.set(cid, []);
    approvedStudentStatsByCourse.get(cid).push(stat);
  });

  const dailyStatsByCourse = new Map();
  dailyProcedureStats.forEach((stat) => {
    const pid = String(stat._id.procedure_id || '');
    const cid = procToCourseMap.get(pid);
    if (!cid) return;
    if (!dailyStatsByCourse.has(cid)) dailyStatsByCourse.set(cid, []);
    dailyStatsByCourse.get(cid).push(stat);
  });

  const courseProgress = populatedCourses.map((course) => {
    const courseIdStr = course._id.toString();
    const courseAssignmentsForCourse = assignmentsByCourse.get(courseIdStr) || [];
    const assignedStudents = courseAssignmentsForCourse
      .filter((assignment) => assignment.assignment_role === 'student' && assignment.user_id)
      .map((assignment) => assignment.user_id);
    const enrolledStudentMap = new Map();
    [...(course.enrolled_students || []), ...assignedStudents].forEach((student) => {
      if (student?._id) enrolledStudentMap.set(String(student._id), student);
    });
    const enrolledStudents = [...enrolledStudentMap.values()];
    const enrolledStudentIds = new Set(enrolledStudents.map((student) => String(student._id)));
    const preceptorCount = new Set(
      courseAssignmentsForCourse
        .filter((assignment) => assignment.assignment_role === 'preceptor' && assignment.user_id)
        .map((assignment) => String(assignment.user_id._id))
    ).size;

    const courseStudentsByYear = enrolledStudents.reduce((acc, s) => {
      if (s && s.year) {
        acc[s.year] = (acc[s.year] || 0) + 1;
      }
      return acc;
    }, {});

    const courseProcedures = proceduresByCourse.get(courseIdStr) || [];
    const totalRequiredPerStudent = courseProcedures.reduce(
      (sum, p) => sum + (p.required_cases || p.target_score || 1),
      0
    );
    const targetCases = totalRequiredPerStudent * enrolledStudents.length;

    const requiredByProcedure = new Map(
      courseProcedures.map((procedure) => [
        String(procedure._id),
        Number(procedure.required_cases || procedure.target_score || 1),
      ])
    );

    const courseApprovedStudentStats = approvedStudentStatsByCourse.get(courseIdStr) || [];
    const approvedCases = courseApprovedStudentStats
      .filter((stat) => enrolledStudentIds.has(String(stat._id.student_id)))
      .reduce(
        (sum, stat) => sum + Math.min(stat.count, requiredByProcedure.get(String(stat._id.procedure_id)) || 1),
        0
      );

    const pendingCases = pendingByCourseMap.get(courseIdStr) || 0;
    const courseGraphBundle = buildGraphDataByRange(dailyStatsByCourse.get(courseIdStr) || []);
    const scoredCases = scoredCountByCourseMap.get(courseIdStr) || 0;
    const averageScore = scoredCases > 0
      ? (scoreSumByCourseMap.get(courseIdStr) || 0) / scoredCases
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

  const graphDataByRange = buildGraphDataByRange(dailyProcedureStats);
  const graphData = graphDataByRange.monthly;

  const totalTargetCases = courseProgress.reduce((sum, c) => sum + c.targetCases, 0);
  const totalCappedApprovedCases = courseProgress.reduce((sum, c) => sum + c.approvedCases, 0);
  const averageScore = totalScoredCases > 0
    ? (grandScoreSum / totalScoredCases).toFixed(2)
    : 0;

  return {
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
  };
};

exports.getAdminStats = async (req, res) => {
  try {
    const [{ value: coreStats, hit }, unreadNotificationsCount] = await Promise.all([
      getOrCompute('admin:core', computeAdminCoreStats),
      Notification.countDocuments({ recipient_id: req.user.id, is_read: false }),
    ]);

    res.setHeader('X-Dashboard-Cache', hit ? 'HIT' : 'MISS');
    return res.status(200).json({
      success: true,
      data: {
        ...coreStats,
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
  const cacheScope = isInstructor ? String(reqUser.id) : 'all';
  const cacheKey = `student-progress:${reqUser.role}:${cacheScope}:${activeSemester}`;

  const { value } = await getOrCompute(cacheKey, async () => {
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

    const [studentAssignments, allCourses, caseGroups, shiftGroups, allProcedures] = await Promise.all([
      CourseAssignment.find({ user_id: { $in: studentIds }, assignment_role: 'student', status: 'active' })
        .select('user_id course_id')
        .lean(),
      Course.find()
        .select('_id course_code course_name semester evaluation_type enrolled_students')
        .lean(),
      LogbookCase.aggregate([
        {
          $match: {
            student_id: { $in: studentIds },
            evaluation_status: { $in: ['approved', 'rejected'] },
          },
        },
        {
          $group: {
            _id: {
              student_id: '$student_id',
              procedure_id: '$procedure_id',
              evaluation_status: '$evaluation_status',
              evaluation_result: '$evaluation_result',
            },
            count: { $sum: 1 },
            latestTs: {
              $max: {
                $ifNull: ['$evaluated_at', { $ifNull: ['$case_date', '$createdAt'] }],
              },
            },
          },
        },
      ]),
      Shift.aggregate([
        { $match: { student_id: { $in: studentIds } } },
        {
          $group: {
            _id: {
              student_id: '$student_id',
              course_id: '$course_id',
            },
            totalShifts: { $sum: 1 },
            verifiedShifts: {
              $sum: { $cond: [{ $eq: ['$verify_status', 'verified'] }, 1, 0] },
            },
          },
        },
      ]),
      Procedure.find()
        .select('_id course_id required_cases target_score')
        .lean(),
    ]);

    const caseGroupsByStudent = new Map();
    caseGroups.forEach((group) => {
      const sid = String(group._id.student_id);
      if (!caseGroupsByStudent.has(sid)) caseGroupsByStudent.set(sid, []);
      caseGroupsByStudent.get(sid).push(group);
    });

    const shiftGroupsByStudent = new Map();
    shiftGroups.forEach((group) => {
      const sid = String(group._id.student_id);
      if (!shiftGroupsByStudent.has(sid)) shiftGroupsByStudent.set(sid, []);
      shiftGroupsByStudent.get(sid).push(group);
    });

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
    const courseEvalTypeMap = new Map();
    allCourses.forEach((course) => {
      const cid = String(course._id);
      if (course.evaluation_type) {
        courseEvalTypeMap.set(cid, course.evaluation_type);
      }
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

    const procCourseMap = new Map();
    const proceduresByCourse = new Map();
    allProcedures.forEach((p) => {
      const pid = String(p._id);
      const cid = p.course_id ? String(p.course_id) : '';
      procCourseMap.set(pid, cid);
      if (cid) {
        if (!proceduresByCourse.has(cid)) proceduresByCourse.set(cid, []);
        proceduresByCourse.get(cid).push(p);
      }
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

      const studentProcedures = [];
      effectiveCourseIds.forEach((cid) => {
        const courseProcs = proceduresByCourse.get(cid);
        if (courseProcs) studentProcedures.push(...courseProcs);
      });

      const studentCaseGroups = (caseGroupsByStudent.get(studentId) || []).filter((g) => {
        if (!shouldScopeRecordsToCourses) return true;
        const cid = procCourseMap.get(String(g._id.procedure_id));
        return cid ? effectiveCourseSet.has(cid) : false;
      });
      const studentShiftGroups = (shiftGroupsByStudent.get(studentId) || []).filter((g) => {
        if (!shouldScopeRecordsToCourses) return true;
        return g._id.course_id ? effectiveCourseSet.has(String(g._id.course_id)) : false;
      });

      let cappedCompletedCases = 0;
      let totalRequiredCases = 0;
      let totalEvaluatedCount = 0;
      let approvedWithScore = 0;
      let totalScore = 0;
      let latestCaseTime = 0;
      const approvedByProcMap = new Map();

      studentCaseGroups.forEach((g) => {
        const pid = String(g._id.procedure_id);
        const status = g._id.evaluation_status;
        const result = g._id.evaluation_result;
        const count = g.count || 0;

        totalEvaluatedCount += count;
        if (status === 'approved') {
          approvedByProcMap.set(pid, (approvedByProcMap.get(pid) || 0) + count);
          if ((result || 0) > 0) {
            approvedWithScore += count;
          }
        }

        const cid = procCourseMap.get(pid);
        const evalType = cid ? courseEvalTypeMap.get(cid) : undefined;
        totalScore += normalizeEvaluationScore(evalType, result, status) * count;

        if (g.latestTs) {
          const ts = new Date(g.latestTs).getTime();
          if (Number.isFinite(ts) && ts > latestCaseTime) {
            latestCaseTime = ts;
          }
        }
      });

      const evaluationPct = totalEvaluatedCount > 0 ? Math.round((approvedWithScore / totalEvaluatedCount) * 100) : 0;

      studentProcedures.forEach((proc) => {
        const pid = proc._id.toString();
        const target = proc.required_cases || proc.target_score || 1;
        const approvedForThisProc = approvedByProcMap.get(pid) || 0;

        totalRequiredCases += target;
        cappedCompletedCases += Math.min(approvedForThisProc, target);
      });

      let totalShifts = 0;
      let verifiedShifts = 0;
      studentShiftGroups.forEach((g) => {
        totalShifts += g.totalShifts || 0;
        verifiedShifts += g.verifiedShifts || 0;
      });
      const attendancePct = totalShifts > 0 ? Math.round((verifiedShifts / totalShifts) * 100) : 0;

      const avgScoreRaw = totalEvaluatedCount > 0 ? (totalScore / totalEvaluatedCount) : 0;
      const avgScorePct = Math.round((avgScoreRaw / 4) * 100);

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
        avg_score_raw: Number(avgScoreRaw.toFixed(2)),
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
  });

  return value;
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

exports.getPreceptorProgress = async (req, res) => {
  try {
    const { results, availableSemesters } = await computePreceptorProgressOverview(req.user, req.query.semester);

    return res.status(200).json({
      success: true,
      data: results,
      availableSemesters,
    });
  } catch (err) {
    console.error('Get preceptor progress error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูลความคืบหน้าพี่เลี้ยง' });
  }
};

exports.getAdminPreceptorStats = async (req, res) => {
  try {
    const data = await computePreceptorDetailStats(req.user, req.params.id);
    return res.status(200).json({
      success: true,
      data,
      message: 'ดึงข้อมูลรายละเอียดพี่เลี้ยงสำเร็จ',
    });
  } catch (err) {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({
        success: false,
        data: null,
        message: err.message,
      });
    }
    console.error('Get admin preceptor stats error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูลพี่เลี้ยง' });
  }
};

exports.getAdminStudentStats = async (req, res) => {
  try {
    const { id: studentIdStr } = req.params;
    if (!mongoose.Types.ObjectId.isValid(studentIdStr)) {
      return res.status(400).json({ success: false, message: 'Invalid student ID' });
    }
    const isInstructor = req.user.role === 'course_instructor';
    const cacheScope = isInstructor ? String(req.user.id) : 'all';
    const cacheKey = `student-detail:${req.user.role}:${cacheScope}:${String(studentIdStr)}`;

    const { value: cachedResult, hit } = await getOrCompute(cacheKey, async () => {
      const studentId = new mongoose.Types.ObjectId(studentIdStr);
      const studentContext = await getStudentCourses(studentId);
      if (!studentContext) {
        return { status: 404, message: 'Student not found', data: null };
      }

      const user = studentContext.user;
      let enrolledCourses = studentContext.courses.filter((c) => !c.is_archived);

      if (isInstructor) {
        const accessibleCourseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
        const accessibleSet = new Set(accessibleCourseIds.map(String));
        const hasAccessToStudent = studentContext.courses.some((c) => accessibleSet.has(String(c._id)));
        if (!hasAccessToStudent) {
          return { status: 403, message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนักศึกษารายนี้', data: null };
        }
        enrolledCourses = enrolledCourses.filter((c) => accessibleSet.has(String(c._id)));
      }

      const metrics = await computeStudentDashboardMetrics({
        studentId,
        courses: enrolledCourses,
        allKnownCourses: studentContext.courses,
        scopeToCourses: isInstructor,
      });

      return {
        status: 200,
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
      };
    });

    if (cachedResult.status !== 200) {
      return res.status(cachedResult.status).json({
        success: false,
        message: cachedResult.message,
      });
    }

    res.setHeader('X-Dashboard-Cache', hit ? 'HIT' : 'MISS');
    return res.status(200).json({
      success: true,
      data: cachedResult.data,
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

    const { value: cachedResult, hit } = await getOrCompute(
      `student-course-detail:${String(studentIdStr)}:${String(course_id)}`,
      async () => {
        const studentId = new mongoose.Types.ObjectId(studentIdStr);

        const [course, procedures] = await Promise.all([
          Course.findById(course_id).select('_id evaluation_type').lean(),
          Procedure.find({ course_id }).lean(),
        ]);

        if (!course) return { notFound: true, data: null };
        if (!procedures || procedures.length === 0) return { notFound: false, data: [] };

        const stats = await LogbookCase.aggregate([
          { $match: { student_id: studentId, procedure_id: { $in: procedures.map((p) => p._id) } } },
          {
            $group: {
              _id: { procedure_id: '$procedure_id', status: '$evaluation_status' },
              count: { $sum: 1 },
              totalScore: { $sum: mongoNormalizedScoreForCourseType(course.evaluation_type) },
              latestCaseAt: { $max: '$case_date' },
            },
          },
        ]);

        const statsMap = stats.reduce((acc, curr) => {
          const pid = curr._id.procedure_id.toString();
          const status = curr._id.status;
          if (!acc[pid]) acc[pid] = { approved: 0, pending: 0, rejected: 0, approvedScore: 0, evaluatedScore: 0, latestCaseAt: null };
          acc[pid][status] = curr.count;
          if (curr.latestCaseAt && (!acc[pid].latestCaseAt || new Date(curr.latestCaseAt) > new Date(acc[pid].latestCaseAt))) {
            acc[pid].latestCaseAt = curr.latestCaseAt;
          }
          if (status === 'approved') {
            acc[pid].approvedScore = curr.totalScore || 0;
            acc[pid].evaluatedScore += curr.totalScore || 0;
          } else if (status === 'rejected') {
            acc[pid].evaluatedScore += curr.totalScore || 0;
          }
          return acc;
        }, {});

        const results = procedures.map((p) => {
          const pid = p._id.toString();
          const s = statsMap[pid] || { approved: 0, pending: 0, rejected: 0, approvedScore: 0, evaluatedScore: 0, latestCaseAt: null };
          const target = p.required_cases || 1;
          const evaluatedCount = s.approved + s.rejected;
          const obtainedScore = target > 0 ? (s.approvedScore / (target * 4)) * p.target_score : 0;

          return {
            _id: p._id,
            procedure_name: p.procedure_name,
            approvedCount: s.approved,
            pendingCount: s.pending,
            rejectedCount: s.rejected,
            targetCount: target,
            latestCaseAt: s.latestCaseAt,
            obtainedScore,
            targetScore: p.target_score,
            averageScore: evaluatedCount > 0 ? s.evaluatedScore / evaluatedCount : 0,
            progressPercent: Math.min((s.approved / target) * 100, 100),
          };
        });

        return { notFound: false, data: results };
      }
    );

    if (cachedResult.notFound) return res.status(404).json({ success: false, message: 'Course not found' });
    res.setHeader('X-Dashboard-Cache', hit ? 'HIT' : 'MISS');
    return res.status(200).json({ success: true, data: cachedResult.data });
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
      preceptorName: shift.on_site_verifier_name
        ? `${shift.on_site_verifier_name} (${shift.preceptor_id?.firstname_lastname || 'บัญชีกลาง'})`
        : shift.preceptor_id?.firstname_lastname || '-',
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
    const isEvaluated = item.evaluation_status === 'approved' || item.evaluation_status === 'rejected';
    const normalizedScore = isEvaluated && rawScore !== null
      ? normalizeEvaluationScore(course?.evaluation_type, rawScore, item.evaluation_status)
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
      preceptorName: item.on_site_verifier_name
        ? `${item.on_site_verifier_name} (${item.preceptor_id?.firstname_lastname || 'บัญชีกลาง'})`
        : item.preceptor_id?.firstname_lastname || '-',
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
