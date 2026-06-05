const mongoose = require('mongoose');
const LogbookCase = require('../models/LogbookCase');
const Shift = require('../models/Shift');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Location = require('../models/Location');
const Course = require('../models/Course');
const Procedure = require('../models/Procedure');

exports.getStudentStats = async (req, res) => {
  try {
    const studentId = new mongoose.Types.ObjectId(req.user.id);

    // 1. ดึงข้อมูล User เพื่อเอา enrolled_courses และ populate ข้อมูลที่จำเป็นทั้งหมด
    const user = await User.findById(studentId).populate({
      path: 'enrolled_courses',
      select: 'course_name course_code semester year evaluation_type enrolled_locations',
      populate: {
        path: 'enrolled_locations',
        model: 'Location',
        select: 'Location_name _id',
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    // 1.1 กรองวิชาที่ยังไม่ถูก archived และระบุเทอมปัจจุบัน
    let activeCourses = (user.enrolled_courses || []).filter(c => !c.is_archived);
    
    if (activeCourses.length > 0) {
      const sortedByYearAndSemester = [...activeCourses].sort((a, b) => {
        const yearA = Number(a.year || 0);
        const yearB = Number(b.year || 0);
        if (yearA !== yearB) return yearB - yearA;
        
        const semA = String(a.semester || '');
        const semB = String(b.semester || '');
        return semB.localeCompare(semA);
      });
      
      const latestYear = sortedByYearAndSemester[0].year;
      const latestSemester = sortedByYearAndSemester[0].semester;
      
      activeCourses = activeCourses.filter(c => c.year === latestYear && c.semester === latestSemester);
    }

    const enrolledCourseIds = activeCourses.map(c => c._id);

    // 2. ดึงข้อมูลสรุปต่างๆ พร้อมกัน
    const [caseSummary, shiftSummary, approvedCasesData, unreadNotificationsCount] = await Promise.all([
      LogbookCase.aggregate([
        { $match: { student_id: studentId } },
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
          }
        }
      ]),
      LogbookCase.aggregate([
        { $match: { student_id: studentId, evaluation_status: 'approved' } },
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
                  { $multiply: ['$evaluation_result', 4] }, // Scale Pass(1) to 4.0
                  '$evaluation_result'
                ]
              }
            }
          }
        }
      ]),
      Notification.countDocuments({ recipient_id: studentId, is_read: false })
    ]);

    const summary = caseSummary[0] || { totalCases: 0, approvedCases: 0, pendingCases: 0, rejectedCases: 0 };
    const sSummary = shiftSummary[0] || { verifiedShifts: 0, pendingShifts: 0, normalShifts: 0, lateShifts: 0, absentShifts: 0, leaveShifts: 0 };

    // Maps for faster lookup
    const approvedProcMap = {};
    const approvedCourseScoreMap = {};
    const approvedCourseCaseCountMap = {};

    let grandTotalScore = 0;
    let grandTotalApprovedCases = 0;

    approvedCasesData.forEach(item => {
      const pid = item._id.toString();
      const cid = item.course_id.toString();
      
      approvedProcMap[pid] = item.count;
      
      approvedCourseScoreMap[cid] = (approvedCourseScoreMap[cid] || 0) + item.totalScore;
      approvedCourseCaseCountMap[cid] = (approvedCourseCaseCountMap[cid] || 0) + item.count;
      
      grandTotalScore += item.totalScore;
      grandTotalApprovedCases += item.count;
    });

    // 3. ดึงข้อมูล Procedures และคำนวณ Target
    const allProceduresInActiveCourses = await Procedure.find({ course_id: { $in: enrolledCourseIds } });
    
    const targetMap = {};
    const typeCountMap = {};

    let totalWeightedProgress = 0;
    const totalProceduresCount_deprecated = allProceduresInActiveCourses.length;
    let totalProceduresDone_deprecated = 0;

    let totalAllProceduresTarget = 0;
    let totalAllProceduresApproved = 0;

    allProceduresInActiveCourses.forEach(proc => {
      const cid = proc.course_id.toString();
      const pid = proc._id.toString();
      const target = proc.required_cases || proc.target_score || 1;
      const approved = approvedProcMap[pid] || 0;
      
      targetMap[cid] = (targetMap[cid] || 0) + target;
      typeCountMap[cid] = (typeCountMap[cid] || 0) + 1;

      // Calculate sum-based progress for overall score
      totalAllProceduresTarget += target;
      totalAllProceduresApproved += approved;

      // Deprecated weighted progress logic (kept for reference if needed, but we'll use sum-based)
      const completion = Math.min(approved / target, 1);
      if (completion >= 1) totalProceduresDone_deprecated++;
      
      if (totalProceduresCount_deprecated > 0) {
        totalWeightedProgress += (completion / totalProceduresCount_deprecated) * 100;
      }
    });

    // Use sum-based progress for overall
    const calculatedOverallProgress = totalAllProceduresTarget > 0 
      ? (totalAllProceduresApproved / totalAllProceduresTarget) * 100 
      : 0;
    
    const totalProceduresCount = totalAllProceduresTarget;
    const totalProceduresDone = totalAllProceduresApproved;
    
    // GPA Overall: Average of evaluation results (Scaled P/F)
    const calculatedGPA = grandTotalApprovedCases > 0 ? (grandTotalScore / grandTotalApprovedCases) : 0;

    // 4. ประกอบข้อมูล Course Progress
    const courseProgress = activeCourses.map(course => {
      const cid = course._id.toString();
      const approved = approvedCourseCaseCountMap[cid] || 0;
      const target = targetMap[cid] || 0;
      const totalScore = approvedCourseScoreMap[cid] || 0;
      
      return {
        _id: course._id,
        course_name: course.course_name,
        course_code: course.course_code,
        semester: course.semester,
        year: course.year,
        approvedCases: approved,
        targetCases: target,
        totalTypes: typeCountMap[cid] || 0,
        progressPercent: target > 0 ? (approved / target) * 100 : 0,
        averageScore: approved > 0 ? (totalScore / approved) : 0,
        enrolled_locations: course.enrolled_locations || [],
      };
    });

    // 5. ดึงข้อมูลกราฟ (เหมือนเดิม)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyStats = await LogbookCase.aggregate([
      { $match: { student_id: studentId, evaluation_status: 'approved', createdAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const graphData = Array.from({ length: 6 }).map((_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (5 - i));
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const stat = monthlyStats.find(s => s._id.year === year && s._id.month === month);
      return { name: monthNames[month - 1], cases: stat ? stat.count : 0 };
    });

    return res.status(200).json({
      success: true,
      data: {
        totalCases: summary.totalCases,
        approvedCases: summary.approvedCases,
        pendingCases: summary.pendingCases,
        rejectedCases: summary.rejectedCases,
        verifiedShifts: sSummary.verifiedShifts,
        pendingShifts: sSummary.pendingShifts,
        normalShifts: sSummary.normalShifts,
        lateShifts: sSummary.lateShifts,
        absentShifts: sSummary.absentShifts,
        leaveShifts: sSummary.leaveShifts,
        courseProgress,
        graphData,
        unreadNotificationsCount,
        overallProgress: calculatedOverallProgress,
        averageScore: calculatedGPA,
        totalProceduresCount,
        totalProceduresDone
      },
    });
  } catch (err) {
    console.error('Get student dashboard stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

// ... (rest of the file remains the same)
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
      Procedure.find({ course_id: course_id })
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

    const [
      evaluatedCases,
      pendingCases,
      verifiedShifts,
      pendingShifts,
      studentStats,
      unreadCount,
    ] = await Promise.all([
      LogbookCase.countDocuments({
        preceptor_id: preceptorId,
        evaluation_status: { $in: ['approved', 'rejected'] },
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
    ]);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyStats = await LogbookCase.aggregate([
      {
        $match: {
          preceptor_id: preceptorId,
          evaluation_status: { $in: ['approved', 'rejected'] },
          evaluated_at: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: { year: { $year: '$evaluated_at' }, month: { $month: '$evaluated_at' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const graphData = Array.from({ length: 6 }).map((_, i) => {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - (5 - i));
        const year = d.getFullYear();
        const month = d.getMonth() + 1;
        const stat = monthlyStats.find(s => s._id.year === year && s._id.month === month);
        return { name: monthNames[month - 1], cases: stat ? stat.count : 0 };
    });

    const approvedCount = await LogbookCase.countDocuments({
      preceptor_id: preceptorId,
      evaluation_status: 'approved'
    });
    const totalEvaluated = evaluatedCases;
    const passingRate = totalEvaluated > 0 ? Math.round((approvedCount / totalEvaluated) * 100) : 0;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const [recentCases, previousCases] = await Promise.all([
      LogbookCase.countDocuments({
        preceptor_id: preceptorId,
        evaluation_status: { $in: ['approved', 'rejected'] },
        evaluated_at: { $gte: thirtyDaysAgo }
      }),
      LogbookCase.countDocuments({
        preceptor_id: preceptorId,
        evaluation_status: { $in: ['approved', 'rejected'] },
        evaluated_at: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo }
      })
    ]);

    let growthPercentage = 0;
    if (previousCases > 0) {
      growthPercentage = Math.round(((recentCases - previousCases) / previousCases) * 100);
    } else if (recentCases > 0) {
      growthPercentage = 100;
    }

    return res.status(200).json({
      success: true,
      data: {
        evaluatedCases,
        pendingCases,
        verifiedShifts,
        pendingShifts,
        totalStudents: studentStats[0]?.totalStudents || 0,
        unreadNotificationsCount: unreadCount,
        graphData,
        passingRate,
        performanceGrowth: growthPercentage
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
      courses,
      procedureStats,
      caseStats,
      unreadNotificationsCount
    ] = await Promise.all([
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
      Location.countDocuments(),
      Course.countDocuments(),
      Procedure.countDocuments(),
      Course.find().lean(),
      Procedure.find().lean(),
      LogbookCase.aggregate([
        { $match: { evaluation_status: 'approved' } },
        { $group: { _id: '$procedure_id', count: { $sum: 1 }, avgScore: { $avg: '$evaluation_result' } } }
      ]),
      Notification.countDocuments({ recipient_id: req.user.id, is_read: false })
    ]);

    const roleCounts = usersByRole.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, { student: 0, preceptor: 0, admin: 0 });

    const totalUsers = Object.values(roleCounts).reduce((a, b) => a + b, 0);

    // 1. Calculate Subject Cards Data
    const populatedCourses = await Course.find().populate({
      path: 'enrolled_students',
      select: 'year',
      model: 'User'
    }).lean();

    const courseProgress = populatedCourses.map(course => {
      const courseIdStr = course._id.toString();
      const enrolledStudents = course.enrolled_students || [];

      // Calculate year distribution for this specific course
      const courseStudentsByYear = enrolledStudents.reduce((acc, s) => {
        if (s && s.year) {
          acc[s.year] = (acc[s.year] || 0) + 1;
        }
        return acc;
      }, {});

      const courseProcedures = procedureStats.filter(p => p.course_id.toString() === courseIdStr);
      const totalRequiredPerStudent = courseProcedures.reduce((sum, p) => sum + (p.required_cases || p.target_score || 1), 0);
      const targetCases = totalRequiredPerStudent * enrolledStudents.length;
      
      const approvedCases = caseStats.filter(cs => 
        courseProcedures.some(cp => cp._id.toString() === cs._id.toString())
      ).reduce((sum, cs) => sum + cs.count, 0);

      return {
        _id: course._id,
        course_name: course.course_name,
        course_code: course.course_code,
        semester: course.semester,
        year: course.year,
        targetCases,
        approvedCases,
        progressPercent: targetCases > 0 ? Math.round((approvedCases / targetCases) * 100) : 0,
        studentsCount: enrolledStudents.length,
        studentsByYear: courseStudentsByYear
      };
    });

    // 2. Overall Progress Graph Data
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyStats = await LogbookCase.aggregate([
      {
        $match: {
          evaluation_status: 'approved',
          evaluated_at: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: { year: { $year: '$evaluated_at' }, month: { $month: '$evaluated_at' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const graphData = Array.from({ length: 6 }).map((_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (5 - i));
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const stat = monthlyStats.find(s => s._id.year === year && s._id.month === month);
      return { name: monthNames[month - 1], cases: stat ? stat.count : 0 };
    });

    const totalTargetCases = courseProgress.reduce((sum, c) => sum + c.targetCases, 0);
    
    // To calculate capped total approved cases for the overall dashboard progress,
    // we need to sum up the cappedApproved for all courses.
    const totalCappedApprovedCases = courseProgress.reduce((sum, c) => sum + c.approvedCases, 0);

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
        overallProgress: totalTargetCases > 0 ? Math.round((totalCappedApprovedCases / totalTargetCases) * 100) : 0,
        totalTargetCases,
        totalApprovedCases: totalCappedApprovedCases,
        averageScore,
        unreadNotificationsCount
      },
    });
  } catch (err) {
    console.error('Get admin dashboard stats error:', err);
    return res.status(500).json({ success: false, data: null });
  }
};

exports.getStudentProgress = async (req, res) => {
  try {
    // 1. Get all students
    const students = await User.find({ role: 'student' }).select('firstname_lastname profile_image student_id year enrolled_courses').lean();

    if (!students || students.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const studentIds = students.map(s => s._id);

    // 2. Fetch all required data in parallel
    const [allEvaluatedCases, allShifts, allProcedures] = await Promise.all([
      LogbookCase.find({ 
        student_id: { $in: studentIds }, 
        evaluation_status: { $in: ['approved', 'rejected'] } 
      }).lean(),
      Shift.find({ student_id: { $in: studentIds } }).lean(),
      Procedure.find().lean()
    ]);

    // 3. Process data per student
    const results = students.map(student => {
      const studentId = student._id.toString();
      
      // Filter data for this student
      const studentCases = allEvaluatedCases.filter(c => c.student_id.toString() === studentId);
      const studentShifts = allShifts.filter(s => s.student_id.toString() === studentId);

      // C. Evaluation & Procedures
      const studentEnrolledCourseIds = (student.enrolled_courses || []).map(id => id.toString());
      const studentProcedures = allProcedures.filter(p => 
        p.course_id && studentEnrolledCourseIds.includes(p.course_id.toString())
      );
      
      let cappedCompletedCases = 0;
      let totalRequiredCases = 0;
      let completedProceduresCount = 0;
      
      const approvedCases = studentCases.filter(c => c.evaluation_status === 'approved');
      const totalEvaluatedCount = studentCases.length;
      
      // Passing rate logic: (Approved with score > 0) / (Total Evaluated)
      const approvedWithScore = approvedCases.filter(c => (c.evaluation_result || 0) > 0).length;
      const evaluationPct = totalEvaluatedCount > 0 ? Math.round((approvedWithScore / totalEvaluatedCount) * 100) : 0;

      studentProcedures.forEach(proc => {
        const pid = proc._id.toString();
        const target = proc.required_cases || proc.target_score || 1;
        const approvedForThisProc = approvedCases.filter(c => c.procedure_id.toString() === pid).length;
        
        totalRequiredCases += target;
        cappedCompletedCases += Math.min(approvedForThisProc, target);

        if (approvedForThisProc >= target) {
          completedProceduresCount++;
        }
      });

      // A. Completed Cases Count
      const rawCompletedCasesCount = approvedCases.length;

      // B. Attendance Percentage
      const totalShifts = studentShifts.length;
      const verifiedShifts = studentShifts.filter(s => s.verify_status === 'verified').length;
      const attendancePct = totalShifts > 0 ? Math.round((verifiedShifts / totalShifts) * 100) : 0;

      // D. Average Score Percentage
      const totalScore = approvedCases.reduce((sum, c) => sum + (c.evaluation_result || 0), 0);
      const avgScoreRaw = rawCompletedCasesCount > 0 ? (totalScore / rawCompletedCasesCount) : 0;
      const avgScorePct = Math.round((avgScoreRaw / 4) * 100);

      return {
        _id: student._id,
        firstname_lastname: student.firstname_lastname,
        profile_image: student.profile_image,
        student_id: student.student_id,
        year: student.year,
        semester: student.semester || '-', // Ensure semester is included if available
        approvedCases: cappedCompletedCases,
        targetCases: totalRequiredCases,
        overallProgress: evaluationPct,
        attendance_pct: attendancePct,
        avg_score_pct: avgScorePct,
        enrolled_courses_count: studentEnrolledCourseIds.length
      };
    });

    return res.status(200).json({
      success: true,
      data: results
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

    // Reusing logic from getStudentStats but for a specific student ID
    const user = await User.findById(studentId).populate({
      path: 'enrolled_courses',
      select: 'course_name course_code semester year evaluation_type enrolled_locations',
      populate: {
        path: 'enrolled_locations',
        model: 'Location',
        select: 'Location_name _id',
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    let enrolledCourses = (user.enrolled_courses || []).filter(c => !c.is_archived);
    const enrolledCourseIds = enrolledCourses.map(c => c._id);

    const [caseSummary, shiftSummary, approvedCasesData] = await Promise.all([
      LogbookCase.aggregate([
        { $match: { student_id: studentId } },
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
          }
        }
      ]),
      LogbookCase.aggregate([
        { $match: { student_id: studentId, evaluation_status: 'approved' } },
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
                  '$evaluation_result'
                ]
              }
            }
          }
        }
      ])
    ]);

    const summary = caseSummary[0] || { totalCases: 0, approvedCases: 0, pendingCases: 0, rejectedCases: 0 };
    const sSummary = shiftSummary[0] || { verifiedShifts: 0, pendingShifts: 0, normalShifts: 0, lateShifts: 0, absentShifts: 0, leaveShifts: 0 };

    const approvedProcMap = {};
    const approvedCourseScoreMap = {};
    const approvedCourseCaseCountMap = {};
    let grandTotalScore = 0;
    let grandTotalApprovedCases = 0;

    approvedCasesData.forEach(item => {
      const pid = item._id.toString();
      const cid = item.course_id.toString();
      approvedProcMap[pid] = item.count;
      approvedCourseScoreMap[cid] = (approvedCourseScoreMap[cid] || 0) + item.totalScore;
      approvedCourseCaseCountMap[cid] = (approvedCourseCaseCountMap[cid] || 0) + item.count;
      grandTotalScore += item.totalScore;
      grandTotalApprovedCases += item.count;
    });

    const allProceduresInEnrolledCourses = await Procedure.find({ course_id: { $in: enrolledCourseIds } });
    const targetMap = {};
    const typeCountMap = {};
    let totalAllProceduresTarget = 0;
    let totalAllProceduresApproved = 0;

    allProceduresInEnrolledCourses.forEach(proc => {
      const cid = proc.course_id.toString();
      const pid = proc._id.toString();
      const target = proc.required_cases || proc.target_score || 1;
      const approved = approvedProcMap[pid] || 0;
      targetMap[cid] = (targetMap[cid] || 0) + target;
      typeCountMap[cid] = (typeCountMap[cid] || 0) + 1;
      totalAllProceduresTarget += target;
      totalAllProceduresApproved += approved;
    });

    const calculatedOverallProgress = totalAllProceduresTarget > 0 ? (totalAllProceduresApproved / totalAllProceduresTarget) * 100 : 0;
    const calculatedGPA = grandTotalApprovedCases > 0 ? (grandTotalScore / grandTotalApprovedCases) : 0;

    const courseProgress = enrolledCourses.map(course => {
      const cid = course._id.toString();
      const approved = approvedCourseCaseCountMap[cid] || 0;
      const target = targetMap[cid] || 0;
      const totalScore = approvedCourseScoreMap[cid] || 0;
      return {
        _id: course._id,
        course_name: course.course_name,
        course_code: course.course_code,
        semester: course.semester,
        year: course.year,
        approvedCases: approved,
        targetCases: target,
        totalTypes: typeCountMap[cid] || 0,
        progressPercent: target > 0 ? (approved / target) * 100 : 0,
        averageScore: approved > 0 ? (totalScore / approved) : 0,
        enrolled_locations: course.enrolled_locations || [],
      };
    });

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyStats = await LogbookCase.aggregate([
      { $match: { student_id: studentId, evaluation_status: 'approved', createdAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const graphData = Array.from({ length: 6 }).map((_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (5 - i));
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const stat = monthlyStats.find(s => s._id.year === year && s._id.month === month);
      return { name: monthNames[month - 1], cases: stat ? stat.count : 0 };
    });

    return res.status(200).json({
      success: true,
      data: {
        studentInfo: {
          firstname_lastname: user.firstname_lastname,
          profile_image: user.profile_image,
          student_id: user.student_id,
          year: user.year,
          role: user.role
        },
        totalCases: summary.totalCases,
        approvedCases: summary.approvedCases,
        pendingCases: summary.pendingCases,
        rejectedCases: summary.rejectedCases,
        verifiedShifts: sSummary.verifiedShifts,
        pendingShifts: sSummary.pendingShifts,
        normalShifts: sSummary.normalShifts,
        lateShifts: sSummary.lateShifts,
        absentShifts: sSummary.absentShifts,
        leaveShifts: sSummary.leaveShifts,
        courseProgress,
        graphData,
        overallProgress: Math.min(Math.round(calculatedOverallProgress), 100),
        totalProceduresCount: totalAllProceduresTarget,
        totalProceduresDone: totalAllProceduresApproved,
        averageScore: calculatedGPA
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
    const studentId = new mongoose.Types.ObjectId(studentIdStr);

    const [course, procedures] = await Promise.all([
      Course.findById(course_id),
      Procedure.find({ course_id: course_id })
    ]);

    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    if (!procedures || procedures.length === 0) return res.status(200).json({ success: true, data: [] });

    const stats = await LogbookCase.aggregate([
      { $match: { student_id: studentId, procedure_id: { $in: procedures.map((p) => p._id) } } },
      { $group: { 
          _id: { procedure_id: '$procedure_id', status: '$evaluation_status' }, 
          count: { $sum: 1 },
          totalScore: { $sum: '$evaluation_result' }
      } },
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
      
      // Calculation: (approvedScore / (target * 4)) * target_score
      const obtainedScore = target > 0 ? (s.approvedScore / (target * 4)) * p.target_score : 0;

      return {
        _id: p._id,
        procedure_name: p.procedure_name,
        approvedCount: s.approved,
        pendingCount: s.pending,
        rejectedCount: s.rejected,
        targetCount: target,
        obtainedScore: obtainedScore,
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

exports.getAdminCourseSkillsStats = async (req, res) => {
  try {
    const { course_id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const courseId = new mongoose.Types.ObjectId(course_id);

    // 1. Get the course and its procedures
    const [course, procedures] = await Promise.all([
      Course.findById(courseId).lean(),
      Procedure.find({ course_id: courseId }).lean()
    ]);

    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    
    // 2. Get students enrolled in this course
    const students = await User.find({ 
      role: 'student', 
      enrolled_courses: courseId 
    }).select('_id').lean();

    const totalStudents = students.length;

    if (totalStudents === 0 || procedures.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const studentIds = students.map(s => s._id);

    // 3. Get all approved cases for these students and these procedures
    const approvedCases = await LogbookCase.aggregate([
      { 
        $match: { 
          student_id: { $in: studentIds },
          procedure_id: { $in: procedures.map(p => p._id) },
          evaluation_status: 'approved'
        } 
      },
      {
        $group: {
          _id: { student_id: '$student_id', procedure_id: '$procedure_id' },
          count: { $sum: 1 }
        }
      }
    ]);

    // 4. Calculate completion per procedure
    const results = procedures.map(p => {
      const procIdStr = p._id.toString();
      const required = p.required_cases || p.target_score || 1;
      
      const studentsCompleted = approvedCases.filter(c => 
        c._id.procedure_id.toString() === procIdStr && c.count >= required
      ).length;

      return {
        procedure_name: p.procedure_name,
        completedStudents: studentsCompleted,
        totalStudents: totalStudents,
        percent: totalStudents > 0 ? Math.round((studentsCompleted / totalStudents) * 100) : 0
      };
    });

    return res.status(200).json({
      success: true,
      data: results
    });
  } catch (err) {
    console.error('Get admin course skills stats error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
