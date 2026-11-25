const mongoose = require('mongoose');
const User = require('../models/User');
const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const Location = require('../models/Location');
const Procedure = require('../models/Procedure');
const LogbookCase = require('../models/LogbookCase');
const Shift = require('../models/Shift');
const { getAccessibleCourseIds } = require('./courseAccessService');
const { getOrCompute } = require('./dashboardCacheService');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const normalizeSemesterFilter = (value) => {
  const raw = String(value || '').trim();
  if (!raw || raw === 'all' || raw === 'ทั้งหมด') return 'all';
  return raw;
};

const parseSemesterSortKey = (semester) => {
  const raw = String(semester || '').trim();
  const match = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    return { valid: false, year: 0, term: 0, raw };
  }
  return {
    valid: true,
    term: Number(match[1]) || 0,
    year: Number(match[2]) || 0,
    raw,
  };
};

const compareSemestersDesc = (a, b) => {
  const semA = parseSemesterSortKey(a);
  const semB = parseSemesterSortKey(b);
  if (semA.valid && !semB.valid) return -1;
  if (!semA.valid && semB.valid) return 1;
  if (!semA.valid && !semB.valid) return semB.raw.localeCompare(semA.raw, 'th', { numeric: true });
  if (semA.year !== semB.year) return semB.year - semA.year;
  if (semA.term !== semB.term) return semB.term - semA.term;
  return semB.raw.localeCompare(semA.raw, 'th', { numeric: true });
};

const calcWaitingDays = (dateValue, nowMs = Date.now()) => {
  if (!dateValue) return 0;
  const ts = new Date(dateValue).getTime();
  if (!Number.isFinite(ts) || ts > nowMs) return 0;
  return Math.floor((nowMs - ts) / DAY_MS);
};

const computePreceptorProgressOverview = async (reqUser, semesterFilter = 'all') => {
  const activeSemester = normalizeSemesterFilter(semesterFilter);
  const isInstructor = reqUser.role === 'course_instructor';
  const cacheScope = isInstructor ? String(reqUser.id) : 'all';
  const cacheKey = `preceptor-progress:${reqUser.role}:${cacheScope}:${activeSemester}`;

  const { value } = await getOrCompute(cacheKey, async () => {
    const accessibleCourseIds = isInstructor
      ? await getAccessibleCourseIds(reqUser, ['course_instructor'])
      : null;
    const accessibleCourseSet = accessibleCourseIds ? new Set(accessibleCourseIds.map(String)) : null;

    const preceptors = await User.find({ role: 'preceptor' })
      .select('firstname_lastname email phone_number profile_image semester academic_status is_shared_account shared_location_id createdAt')
      .lean();

    if (!preceptors || preceptors.length === 0) {
      return { results: [], availableSemesters: [] };
    }

    const preceptorIds = preceptors.map((p) => p._id);

    const [assignments, allCourses, sharedLocations, allProcedures, caseGroups, shiftGroups] = await Promise.all([
      CourseAssignment.find({
        user_id: { $in: preceptorIds },
        assignment_role: 'preceptor',
        status: 'active',
      })
        .select('user_id course_id')
        .lean(),
      Course.find().select('_id course_code course_name semester is_archived').lean(),
      Location.find({ central_preceptor_id: { $in: preceptorIds } })
        .select('_id Location_name central_preceptor_id')
        .lean(),
      Procedure.find().select('_id course_id').lean(),
      LogbookCase.aggregate([
        { $match: { preceptor_id: { $in: preceptorIds } } },
        {
          $group: {
            _id: {
              preceptor_id: '$preceptor_id',
              procedure_id: '$procedure_id',
              evaluation_status: '$evaluation_status',
            },
            count: { $sum: 1 },
            latestActivityAt: {
              $max: { $ifNull: ['$evaluated_at', { $ifNull: ['$createdAt', '$case_date'] }] },
            },
            oldestPendingAt: {
              $min: { $ifNull: ['$createdAt', '$case_date'] },
            },
            responseMsSum: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$evaluation_status', ['approved', 'rejected']] },
                      { $ne: [{ $ifNull: ['$evaluated_at', null] }, null] },
                      { $ne: [{ $ifNull: ['$createdAt', null] }, null] },
                      { $gte: ['$evaluated_at', '$createdAt'] },
                    ],
                  },
                  { $subtract: ['$evaluated_at', '$createdAt'] },
                  0,
                ],
              },
            },
            responseMsCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$evaluation_status', ['approved', 'rejected']] },
                      { $ne: [{ $ifNull: ['$evaluated_at', null] }, null] },
                      { $ne: [{ $ifNull: ['$createdAt', null] }, null] },
                      { $gte: ['$evaluated_at', '$createdAt'] },
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
      Shift.aggregate([
        { $match: { preceptor_id: { $in: preceptorIds } } },
        {
          $group: {
            _id: {
              preceptor_id: '$preceptor_id',
              course_id: '$course_id',
              verify_status: '$verify_status',
            },
            count: { $sum: 1 },
            latestActivityAt: {
              $max: { $ifNull: ['$verified_at', { $ifNull: ['$createdAt', '$shift_date'] }] },
            },
            oldestPendingAt: {
              $min: { $ifNull: ['$createdAt', '$shift_date'] },
            },
          },
        },
      ]),
    ]);

    const sharedLocationByPreceptor = new Map();
    sharedLocations.forEach((loc) => {
      if (loc.central_preceptor_id) {
        sharedLocationByPreceptor.set(String(loc.central_preceptor_id), loc.Location_name);
      }
    });

    const procCourseMap = new Map(
      allProcedures.map((p) => [String(p._id), p.course_id ? String(p.course_id) : ''])
    );

    const preceptorCoursesMap = new Map();
    const caseGroupsByPreceptor = new Map();
    const shiftGroupsByPreceptor = new Map();
    preceptors.forEach((p) => {
      const pid = String(p._id);
      preceptorCoursesMap.set(pid, new Set());
      caseGroupsByPreceptor.set(pid, []);
      shiftGroupsByPreceptor.set(pid, []);
    });
    assignments.forEach((a) => {
      const pid = String(a.user_id);
      if (preceptorCoursesMap.has(pid) && a.course_id) {
        preceptorCoursesMap.get(pid).add(String(a.course_id));
      }
    });
    caseGroups.forEach((g) => {
      const pid = String(g._id.preceptor_id || '');
      const cid = procCourseMap.get(String(g._id.procedure_id || ''));
      if (pid && caseGroupsByPreceptor.has(pid)) {
        caseGroupsByPreceptor.get(pid).push(g);
      }
      if (pid && cid && preceptorCoursesMap.has(pid)) {
        preceptorCoursesMap.get(pid).add(cid);
      }
    });
    shiftGroups.forEach((g) => {
      const pid = String(g._id.preceptor_id || '');
      const cid = g._id.course_id ? String(g._id.course_id) : '';
      if (pid && shiftGroupsByPreceptor.has(pid)) {
        shiftGroupsByPreceptor.get(pid).push(g);
      }
      if (pid && cid && preceptorCoursesMap.has(pid)) {
        preceptorCoursesMap.get(pid).add(cid);
      }
    });

    const courseSemesterMap = new Map();
    const courseNameMap = new Map();
    allCourses.forEach((course) => {
      const cid = String(course._id);
      const sem = String(course.semester || '').trim();
      if (sem) courseSemesterMap.set(cid, sem);
      const code = String(course.course_code || '').trim();
      const name = String(course.course_name || '').trim();
      const label = code && name ? `${code} - ${name}` : (name || code);
      if (label) courseNameMap.set(cid, label);
    });

    const availableSemesterSet = new Set();
    const nowMs = Date.now();

    const results = preceptors.reduce((acc, preceptor) => {
      const preceptorId = String(preceptor._id);
      const rawCourseIds = [...(preceptorCoursesMap.get(preceptorId) || [])];
      const scopedCourseIds = accessibleCourseSet
        ? rawCourseIds.filter((cid) => accessibleCourseSet.has(cid))
        : rawCourseIds;

      if (isInstructor && scopedCourseIds.length === 0) {
        return acc;
      }

      const courseSemesters = [...new Set(
        scopedCourseIds.map((cid) => courseSemesterMap.get(cid)).filter(Boolean)
      )];
      const fallbackSemester = !isInstructor ? String(preceptor.semester || '').trim() : '';
      const preceptorSemesters = (courseSemesters.length > 0
        ? courseSemesters
        : (fallbackSemester ? [fallbackSemester] : [])
      ).sort(compareSemestersDesc);

      preceptorSemesters.forEach((sem) => availableSemesterSet.add(sem));

      if (activeSemester !== 'all' && !preceptorSemesters.includes(activeSemester)) {
        return acc;
      }

      const effectiveCourseIds = activeSemester !== 'all'
        ? scopedCourseIds.filter((cid) => courseSemesterMap.get(cid) === activeSemester)
        : scopedCourseIds;
      const effectiveCourseSet = new Set(effectiveCourseIds);
      const shouldScopeRecords = isInstructor || activeSemester !== 'all';

      const pCaseGroups = (caseGroupsByPreceptor.get(preceptorId) || []).filter((g) => {
        if (!shouldScopeRecords) return true;
        const cid = procCourseMap.get(String(g._id.procedure_id));
        return cid ? effectiveCourseSet.has(cid) : false;
      });

      const pShiftGroups = (shiftGroupsByPreceptor.get(preceptorId) || []).filter((g) => {
        if (!shouldScopeRecords) return true;
        return g._id.course_id ? effectiveCourseSet.has(String(g._id.course_id)) : false;
      });

      let totalCases = 0;
      let approvedCases = 0;
      let rejectedCases = 0;
      let pendingCases = 0;
      let oldestPendingCaseTime = Infinity;
      let responseHoursSum = 0;
      let responseHoursCount = 0;
      let latestActivityTime = 0;

      pCaseGroups.forEach((g) => {
        const count = g.count || 0;
        const status = g._id.evaluation_status;
        totalCases += count;

        const activityTs = g.latestActivityAt ? new Date(g.latestActivityAt).getTime() : 0;
        if (Number.isFinite(activityTs) && activityTs > latestActivityTime) {
          latestActivityTime = activityTs;
        }

        if (status === 'approved') {
          approvedCases += count;
        } else if (status === 'rejected') {
          rejectedCases += count;
        } else {
          pendingCases += count;
          const waitTs = g.oldestPendingAt ? new Date(g.oldestPendingAt).getTime() : 0;
          if (Number.isFinite(waitTs) && waitTs > 0 && waitTs < oldestPendingCaseTime) {
            oldestPendingCaseTime = waitTs;
          }
        }

        if ((status === 'approved' || status === 'rejected') && g.responseMsCount > 0) {
          responseHoursSum += (g.responseMsSum || 0) / HOUR_MS;
          responseHoursCount += g.responseMsCount;
        }
      });

      let totalShifts = 0;
      let verifiedShifts = 0;
      let rejectedShifts = 0;
      let pendingShifts = 0;
      let oldestPendingShiftTime = Infinity;

      pShiftGroups.forEach((g) => {
        const count = g.count || 0;
        const status = g._id.verify_status;
        totalShifts += count;

        const activityTs = g.latestActivityAt ? new Date(g.latestActivityAt).getTime() : 0;
        if (Number.isFinite(activityTs) && activityTs > latestActivityTime) {
          latestActivityTime = activityTs;
        }

        if (status === 'verified') {
          verifiedShifts += count;
        } else if (status === 'rejected') {
          rejectedShifts += count;
        } else {
          pendingShifts += count;
          const waitTs = g.oldestPendingAt ? new Date(g.oldestPendingAt).getTime() : 0;
          if (Number.isFinite(waitTs) && waitTs > 0 && waitTs < oldestPendingShiftTime) {
            oldestPendingShiftTime = waitTs;
          }
        }
      });

      const evaluatedCases = approvedCases + rejectedCases;
      const caseCompletionPct = totalCases > 0 ? Math.round((evaluatedCases / totalCases) * 100) : 0;

      const completedShifts = verifiedShifts + rejectedShifts;
      const shiftCompletionPct = totalShifts > 0 ? Math.round((completedShifts / totalShifts) * 100) : 0;

      const totalAssigned = totalCases + totalShifts;
      const totalCompleted = evaluatedCases + completedShifts;
      const totalPending = pendingCases + pendingShifts;
      const overallCompletionPct = totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : 0;

      const oldestPendingCaseAt = Number.isFinite(oldestPendingCaseTime) ? new Date(oldestPendingCaseTime) : null;
      const oldestPendingShiftAt = Number.isFinite(oldestPendingShiftTime) ? new Date(oldestPendingShiftTime) : null;
      const oldestPendingCaseDays = oldestPendingCaseAt ? calcWaitingDays(oldestPendingCaseAt, nowMs) : 0;
      const oldestPendingShiftDays = oldestPendingShiftAt ? calcWaitingDays(oldestPendingShiftAt, nowMs) : 0;
      const maxPendingDays = Math.max(oldestPendingCaseDays, oldestPendingShiftDays);
      const avgResponseHours = responseHoursCount > 0
        ? Number((responseHoursSum / responseHoursCount).toFixed(1))
        : null;

      const displayedSemesters = activeSemester !== 'all' ? [activeSemester] : preceptorSemesters;
      const enrolledCourseNames = [...new Set(
        effectiveCourseIds.map((cid) => courseNameMap.get(cid)).filter(Boolean)
      )];

      acc.push({
        _id: preceptor._id,
        firstname_lastname: preceptor.firstname_lastname,
        email: preceptor.email,
        phone_number: preceptor.phone_number || '',
        profile_image: preceptor.profile_image || '',
        academic_status: preceptor.academic_status || 'active',
        is_shared_account: Boolean(preceptor.is_shared_account),
        shared_location_name: sharedLocationByPreceptor.get(preceptorId) || '',
        semester: displayedSemesters.length > 0 ? displayedSemesters.join(', ') : '-',
        semesters: preceptorSemesters,
        enrolled_courses_count: effectiveCourseIds.length,
        enrolled_course_names: enrolledCourseNames.length > 0 ? enrolledCourseNames.join(', ') : '-',
        totalCases,
        evaluatedCases,
        approvedCases,
        rejectedCases,
        pendingCases,
        caseCompletionPct,
        totalShifts,
        completedShifts,
        verifiedShifts,
        rejectedShifts,
        pendingShifts,
        shiftCompletionPct,
        totalAssigned,
        totalCompleted,
        totalPending,
        overallCompletionPct,
        oldestPendingCaseAt,
        oldestPendingShiftAt,
        oldestPendingCaseDays,
        oldestPendingShiftDays,
        maxPendingDays,
        avgResponseHours,
        latestActivityAt: latestActivityTime > 0 ? new Date(latestActivityTime) : null,
        createdAt: preceptor.createdAt || null,
      });

      return acc;
    }, []);

    const availableSemesters = [...availableSemesterSet].sort(compareSemestersDesc);
    return { results, availableSemesters };
  });

  return value;
};

const computePreceptorDetailStats = async (reqUser, preceptorIdStr) => {
  if (!mongoose.Types.ObjectId.isValid(preceptorIdStr)) {
    const err = new Error('รหัสอาจารย์พี่เลี้ยงไม่ถูกต้อง');
    err.status = 400;
    throw err;
  }

  const isInstructor = reqUser.role === 'course_instructor';
  const cacheScope = isInstructor ? String(reqUser.id) : 'all';
  const cacheKey = `preceptor-detail:${reqUser.role}:${cacheScope}:${String(preceptorIdStr)}`;

  const { value } = await getOrCompute(cacheKey, async () => {
    const preceptor = await User.findById(preceptorIdStr)
      .select('firstname_lastname email phone_number profile_image role academic_status is_shared_account shared_location_id createdAt')
      .lean();

    if (!preceptor || preceptor.role !== 'preceptor') {
      const err = new Error('ไม่พบข้อมูลอาจารย์พี่เลี้ยง');
      err.status = 404;
      throw err;
    }

    const accessibleCourseIds = isInstructor
      ? await getAccessibleCourseIds(reqUser, ['course_instructor'])
      : null;
    const accessibleCourseSet = accessibleCourseIds ? new Set(accessibleCourseIds.map(String)) : null;

    const [assignments, sharedLocation, allCases, allShifts] = await Promise.all([
      CourseAssignment.find({
        user_id: preceptor._id,
        assignment_role: 'preceptor',
        status: 'active',
      })
        .populate('course_id', 'course_code course_name semester year evaluation_type is_archived')
        .lean(),
      Location.findOne({ central_preceptor_id: preceptor._id }).select('Location_name').lean(),
      LogbookCase.find({ preceptor_id: preceptor._id })
        .select('student_id procedure_id location_id on_site_verifier_name case_date createdAt evaluation_status evaluation_result evaluated_at')
        .populate('student_id', 'firstname_lastname student_id profile_image year')
        .populate({
          path: 'procedure_id',
          select: 'procedure_name course_id',
          populate: { path: 'course_id', select: 'course_code course_name semester' },
        })
        .populate('location_id', 'Location_name')
        .sort({ createdAt: 1 })
        .lean(),
      Shift.find({ preceptor_id: preceptor._id })
        .select('student_id course_id location_id on_site_verifier_name shift_date shift_status verify_status verified_at createdAt')
        .populate('student_id', 'firstname_lastname student_id profile_image year')
        .populate('course_id', 'course_code course_name semester')
        .populate('location_id', 'Location_name')
        .sort({ createdAt: 1 })
        .lean(),
    ]);

    const courseMap = new Map();
    assignments.forEach((a) => {
      const c = a.course_id;
      if (c && c._id) courseMap.set(String(c._id), c);
    });
    allCases.forEach((c) => {
      const course = c.procedure_id?.course_id;
      if (course && course._id && !courseMap.has(String(course._id))) {
        courseMap.set(String(course._id), course);
      }
    });
    allShifts.forEach((s) => {
      const course = s.course_id;
      if (course && course._id && !courseMap.has(String(course._id))) {
        courseMap.set(String(course._id), course);
      }
    });

    if (isInstructor) {
      const hasOverlap = [...courseMap.keys()].some((cid) => accessibleCourseSet.has(cid));
      if (!hasOverlap) {
        const err = new Error('คุณไม่มีสิทธิ์เข้าถึงข้อมูลอาจารย์พี่เลี้ยงรายนี้');
        err.status = 403;
        throw err;
      }
    }

    const scopedCourses = [...courseMap.values()].filter((course) =>
      !accessibleCourseSet || accessibleCourseSet.has(String(course._id))
    );
    const scopedCourseSet = new Set(scopedCourses.map((c) => String(c._id)));

    const scopedCases = allCases.filter((c) => {
      if (!isInstructor) return true;
      const cid = c.procedure_id?.course_id?._id || c.procedure_id?.course_id;
      return cid ? scopedCourseSet.has(String(cid)) : false;
    });

    const scopedShifts = allShifts.filter((s) => {
      if (!isInstructor) return true;
      const cid = s.course_id?._id || s.course_id;
      return cid ? scopedCourseSet.has(String(cid)) : false;
    });

    const nowMs = Date.now();
    const courseStatsMap = new Map(
      scopedCourses.map((c) => [
        String(c._id),
        {
          _id: c._id,
          course_code: c.course_code || '-',
          course_name: c.course_name || '-',
          semester: c.semester || '-',
          totalCases: 0,
          evaluatedCases: 0,
          approvedCases: 0,
          rejectedCases: 0,
          pendingCases: 0,
          totalShifts: 0,
          completedShifts: 0,
          verifiedShifts: 0,
          rejectedShifts: 0,
          pendingShifts: 0,
          maxPendingDays: 0,
          _responseHoursSum: 0,
          _responseHoursCount: 0,
        },
      ])
    );

    let approvedCases = 0;
    let rejectedCases = 0;
    let pendingCases = 0;
    let responseHoursSum = 0;
    let responseHoursCount = 0;
    let maxPendingCaseDays = 0;
    const pendingCasesList = [];
    const recentEvaluatedList = [];

    scopedCases.forEach((c) => {
      const cid = String(c.procedure_id?.course_id?._id || c.procedure_id?.course_id || '');
      const cStat = courseStatsMap.get(cid);
      if (cStat) cStat.totalCases += 1;

      if (c.evaluation_status === 'approved' || c.evaluation_status === 'rejected') {
        if (c.evaluation_status === 'approved') {
          approvedCases += 1;
          if (cStat) cStat.approvedCases += 1;
        } else {
          rejectedCases += 1;
          if (cStat) cStat.rejectedCases += 1;
        }
        if (cStat) cStat.evaluatedCases += 1;
        if (c.evaluated_at && c.createdAt) {
          const diffMs = new Date(c.evaluated_at).getTime() - new Date(c.createdAt).getTime();
          if (Number.isFinite(diffMs) && diffMs >= 0) {
            const diffHours = diffMs / HOUR_MS;
            responseHoursSum += diffHours;
            responseHoursCount += 1;
            if (cStat) {
              cStat._responseHoursSum += diffHours;
              cStat._responseHoursCount += 1;
            }
          }
        }
        recentEvaluatedList.push({ ...c, courseId: cid });
      } else {
        pendingCases += 1;
        if (cStat) cStat.pendingCases += 1;
        const waitingDays = calcWaitingDays(c.createdAt || c.case_date, nowMs);
        if (waitingDays > maxPendingCaseDays) maxPendingCaseDays = waitingDays;
        if (cStat && waitingDays > cStat.maxPendingDays) cStat.maxPendingDays = waitingDays;
        pendingCasesList.push({ ...c, courseId: cid, waitingDays });
      }
    });

    let verifiedShifts = 0;
    let rejectedShifts = 0;
    let pendingShifts = 0;
    let maxPendingShiftDays = 0;
    const pendingShiftsList = [];

    scopedShifts.forEach((s) => {
      const cid = String(s.course_id?._id || s.course_id || '');
      const cStat = courseStatsMap.get(cid);
      if (cStat) cStat.totalShifts += 1;

      if (s.verify_status === 'verified' || s.verify_status === 'rejected') {
        if (s.verify_status === 'verified') {
          verifiedShifts += 1;
          if (cStat) cStat.verifiedShifts += 1;
        } else {
          rejectedShifts += 1;
          if (cStat) cStat.rejectedShifts += 1;
        }
        if (cStat) cStat.completedShifts += 1;
      } else {
        pendingShifts += 1;
        if (cStat) cStat.pendingShifts += 1;
        const waitingDays = calcWaitingDays(s.createdAt || s.shift_date, nowMs);
        if (waitingDays > maxPendingShiftDays) maxPendingShiftDays = waitingDays;
        if (cStat && waitingDays > cStat.maxPendingDays) cStat.maxPendingDays = waitingDays;
        pendingShiftsList.push({ ...s, courseId: cid, waitingDays });
      }
    });

    recentEvaluatedList.sort(
      (a, b) => new Date(b.evaluated_at || b.case_date || 0).getTime() - new Date(a.evaluated_at || a.case_date || 0).getTime()
    );

    const totalCases = scopedCases.length;
    const evaluatedCases = approvedCases + rejectedCases;
    const caseCompletionPct = totalCases > 0 ? Math.round((evaluatedCases / totalCases) * 100) : 0;

    const totalShifts = scopedShifts.length;
    const completedShifts = verifiedShifts + rejectedShifts;
    const shiftCompletionPct = totalShifts > 0 ? Math.round((completedShifts / totalShifts) * 100) : 0;

    const courseBreakdown = [...courseStatsMap.values()].map((c) => {
      const { _responseHoursSum, _responseHoursCount, ...rest } = c;
      return {
        ...rest,
        caseCompletionPct: rest.totalCases > 0 ? Math.round((rest.evaluatedCases / rest.totalCases) * 100) : 0,
        shiftCompletionPct: rest.totalShifts > 0 ? Math.round((rest.completedShifts / rest.totalShifts) * 100) : 0,
        totalPending: rest.pendingCases + rest.pendingShifts,
        avgResponseHours: _responseHoursCount > 0 ? Number((_responseHoursSum / _responseHoursCount).toFixed(1)) : null,
      };
    });

    return {
      preceptorInfo: {
        _id: preceptor._id,
        firstname_lastname: preceptor.firstname_lastname,
        email: preceptor.email,
        phone_number: preceptor.phone_number || '',
        profile_image: preceptor.profile_image || '',
        academic_status: preceptor.academic_status || 'active',
        is_shared_account: Boolean(preceptor.is_shared_account),
        sharedLocationName: sharedLocation?.Location_name || '',
      },
      summary: {
        totalCases,
        evaluatedCases,
        approvedCases,
        rejectedCases,
        pendingCases,
        caseCompletionPct,
        totalShifts,
        completedShifts,
        verifiedShifts,
        rejectedShifts,
        pendingShifts,
        shiftCompletionPct,
        totalPending: pendingCases + pendingShifts,
        maxPendingDays: Math.max(maxPendingCaseDays, maxPendingShiftDays),
        avgResponseHours: responseHoursCount > 0 ? Number((responseHoursSum / responseHoursCount).toFixed(1)) : null,
      },
      courseBreakdown,
      pendingCases: pendingCasesList.slice(0, 300),
      pendingShifts: pendingShiftsList.slice(0, 300),
      recentEvaluated: recentEvaluatedList.slice(0, 200),
    };
  });

  return value;
};

module.exports = {
  computePreceptorProgressOverview,
  computePreceptorDetailStats,
};
