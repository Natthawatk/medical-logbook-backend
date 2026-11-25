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
const { getOrCompute } = require('../services/dashboardCacheService');

const computeInstructorCoreStats = async (user) => {
  const courseIds = await getAccessibleCourseIds(user, ['course_instructor']);
  if (!courseIds || courseIds.length === 0) {
    const emptyGraph = buildGraphDataByRange([]);
    return {
      totalUsers: 0,
      usersByRole: { student: 0, preceptor: 0, course_instructor: 0, admin: 0 },
      totalLocations: 0,
      totalCourses: 0,
      totalProcedures: 0,
      totalApprovedCases: 0,
      totalTargetCases: 0,
      overallProgress: 0,
      averageScore: 0,
      graphData: emptyGraph.monthly,
      graphDataByRange: emptyGraph,
      courseProgress: [],
    };
  }

  const [courses, assignments, procedures, locationIds] = await Promise.all([
    Course.find({ _id: { $in: courseIds } })
      .populate('enrolled_students', 'year')
      .sort({ createdAt: -1 })
      .lean(),
    CourseAssignment.find({ course_id: { $in: courseIds }, status: 'active' })
      .populate('user_id', 'year')
      .lean(),
    Procedure.find({ course_id: { $in: courseIds } })
      .select('_id course_id required_cases target_score')
      .lean(),
    CourseLocation.find({ course_id: { $in: courseIds }, status: 'active' })
      .distinct('location_id'),
  ]);

  const assignmentsByCourse = new Map();
  assignments.forEach((assignment) => {
    const cid = String(assignment.course_id);
    if (!assignmentsByCourse.has(cid)) assignmentsByCourse.set(cid, []);
    assignmentsByCourse.get(cid).push(assignment);
  });

  const proceduresByCourse = new Map();
  const procInfoMap = new Map();
  const allProcedureIds = [];
  procedures.forEach((procedure) => {
    const cid = String(procedure.course_id);
    const pid = String(procedure._id);
    if (!proceduresByCourse.has(cid)) proceduresByCourse.set(cid, []);
    proceduresByCourse.get(cid).push(procedure);
    procInfoMap.set(pid, {
      courseIdStr: cid,
      required: Number(procedure.required_cases || procedure.target_score || 1),
    });
    allProcedureIds.push(procedure._id);
  });

  const courseStudentsMap = new Map();
  const courseStudentIdSetMap = new Map();
  const coursePreceptorCountMap = new Map();
  const courseEvalTypeMap = new Map();
  const uniqueStudentObjectIdMap = new Map();

  courses.forEach((course) => {
    const cid = String(course._id);
    courseEvalTypeMap.set(cid, course.evaluation_type);
    const courseAssignments = assignmentsByCourse.get(cid) || [];
    const studentMap = new Map();

    [
      ...(course.enrolled_students || []),
      ...courseAssignments
        .filter((assignment) => assignment.assignment_role === 'student' && assignment.user_id)
        .map((assignment) => assignment.user_id),
    ].forEach((student) => {
      if (student?._id) {
        const sid = String(student._id);
        studentMap.set(sid, student);
        uniqueStudentObjectIdMap.set(sid, student._id);
      }
    });

    const students = [...studentMap.values()];
    courseStudentsMap.set(cid, students);
    courseStudentIdSetMap.set(cid, new Set(students.map((s) => String(s._id))));

    const preceptorCount = new Set(
      courseAssignments
        .filter((assignment) => assignment.assignment_role === 'preceptor' && assignment.user_id)
        .map((assignment) => String(assignment.user_id._id))
    ).size;
    coursePreceptorCountMap.set(cid, preceptorCount);
  });

  const allStudentIds = [...uniqueStudentObjectIdMap.values()];
  const sixMonthsAgo = getSixMonthStart();

  const [caseGroups, dailyGroups] = (allProcedureIds.length > 0 && allStudentIds.length > 0)
    ? await Promise.all([
        LogbookCase.aggregate([
          {
            $match: {
              procedure_id: { $in: allProcedureIds },
              student_id: { $in: allStudentIds },
            },
          },
          {
            $group: {
              _id: {
                student_id: '$student_id',
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
          {
            $match: {
              procedure_id: { $in: allProcedureIds },
              student_id: { $in: allStudentIds },
              evaluation_status: 'approved',
              evaluated_at: { $gte: sixMonthsAgo },
            },
          },
          {
            $group: {
              _id: {
                student_id: '$student_id',
                procedure_id: '$procedure_id',
                day: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$evaluated_at',
                    timezone: 'Asia/Bangkok',
                  },
                },
              },
              count: { $sum: 1 },
            },
          },
        ]),
      ])
    : [[], []];

  const approvedCasesByCourse = new Map();
  const pendingCasesByCourse = new Map();
  const evaluatedCasesByCourse = new Map();
  const scoreSumByCourse = new Map();

  caseGroups.forEach((group) => {
    const pid = String(group._id.procedure_id);
    const sid = String(group._id.student_id);
    const status = group._id.status;
    const procInfo = procInfoMap.get(pid);
    if (!procInfo) return;

    const cid = procInfo.courseIdStr;
    if (!courseStudentIdSetMap.get(cid)?.has(sid)) return;

    const count = group.count || 0;
    if (status === 'approved') {
      approvedCasesByCourse.set(
        cid,
        (approvedCasesByCourse.get(cid) || 0) + Math.min(count, procInfo.required)
      );
      evaluatedCasesByCourse.set(cid, (evaluatedCasesByCourse.get(cid) || 0) + count);
      const evalType = courseEvalTypeMap.get(cid);
      const scoreGain = evalType === 'Pass/Fail'
        ? (group.positivePassCount || 0) * 4
        : (group.rawScoreSum || 0);
      scoreSumByCourse.set(cid, (scoreSumByCourse.get(cid) || 0) + scoreGain);
    } else if (status === 'rejected') {
      evaluatedCasesByCourse.set(cid, (evaluatedCasesByCourse.get(cid) || 0) + count);
    } else if (status === 'pending') {
      pendingCasesByCourse.set(cid, (pendingCasesByCourse.get(cid) || 0) + count);
    }
  });

  const dailyByCourse = new Map();
  dailyGroups.forEach((dGroup) => {
    const pid = String(dGroup._id.procedure_id);
    const sid = String(dGroup._id.student_id);
    const procInfo = procInfoMap.get(pid);
    if (!procInfo) return;

    const cid = procInfo.courseIdStr;
    if (!courseStudentIdSetMap.get(cid)?.has(sid)) return;

    if (!dailyByCourse.has(cid)) dailyByCourse.set(cid, []);
    dailyByCourse.get(cid).push({
      _id: { day: dGroup._id.day },
      count: dGroup.count,
    });
  });

  const courseProgress = courses.map((course) => {
    const cid = String(course._id);
    const students = courseStudentsMap.get(cid) || [];
    const studentCount = students.length;
    const preceptorCount = coursePreceptorCountMap.get(cid) || 0;
    const courseProcedures = proceduresByCourse.get(cid) || [];
    const approvedCases = approvedCasesByCourse.get(cid) || 0;
    const pendingCases = pendingCasesByCourse.get(cid) || 0;
    const evaluatedCases = evaluatedCasesByCourse.get(cid) || 0;
    const totalScore = scoreSumByCourse.get(cid) || 0;
    const graphDataByRange = buildGraphDataByRange(dailyByCourse.get(cid) || []);
    const graphData = graphDataByRange.monthly;
    const perStudentTarget = courseProcedures.reduce(
      (sum, procedure) => sum + Number(procedure.required_cases || procedure.target_score || 0),
      0
    );
    const targetCases = perStudentTarget * studentCount;

    return {
      ...course,
      studentCount,
      preceptorCount,
      procedureCount: courseProcedures.length,
      approvedCases,
      pendingCases,
      targetCases,
      progressPercent: calculateProgressPercent(approvedCases, targetCases),
      averageScore: evaluatedCases > 0 ? Number(totalScore / evaluatedCases) : 0,
      evaluatedCases,
      graphData,
      graphDataByRange,
      studentsByYear: students.reduce((result, student) => {
        if (student.year) result[student.year] = (result[student.year] || 0) + 1;
        return result;
      }, {}),
    };
  });

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
  const totalEvaluatedCases = courseProgress.reduce((sum, course) => sum + (course.evaluatedCases || 0), 0);
  const weightedScores = courseProgress.reduce((sum, course) => sum + (course.averageScore * (course.evaluatedCases || 0)), 0);

  return {
    totalUsers: uniqueUsers.size,
    usersByRole,
    totalLocations: locationIds.length,
    totalCourses: courses.length,
    totalProcedures,
    totalApprovedCases,
    totalTargetCases,
    overallProgress: calculateProgressPercent(totalApprovedCases, totalTargetCases),
    averageScore: totalEvaluatedCases > 0 ? weightedScores / totalEvaluatedCases : 0,
    graphData,
    graphDataByRange,
    courseProgress,
  };
};

exports.getStats = async (req, res) => {
  try {
    const instructorIdStr = String(req.user.id);
    const [{ value: coreStats, hit }, unreadNotificationsCount] = await Promise.all([
      getOrCompute(`instructor:${instructorIdStr}`, () => computeInstructorCoreStats(req.user)),
      Notification.countDocuments({ recipient_id: req.user.id, is_read: false }),
    ]);

    res.setHeader('X-Dashboard-Cache', hit ? 'HIT' : 'MISS');
    return res.json({
      success: true,
      data: {
        ...coreStats,
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
