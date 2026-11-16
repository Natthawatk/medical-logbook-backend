const mongoose = require('mongoose');
const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const Procedure = require('../models/Procedure');
const LogbookCase = require('../models/LogbookCase');
const User = require('../models/User');

const calculateProgressPercent = (completed, total) => (
  total > 0 ? Math.min(100, (completed / total) * 100) : 0
);

/**
 * Compute per-procedure case and student completion statistics for a course.
 */
async function computeCourseSkillsStats(courseIdValue) {
  const courseId = new mongoose.Types.ObjectId(courseIdValue);

  const [course, procedures, assignedStudentIds, legacyStudents] = await Promise.all([
    Course.findById(courseId).select('enrolled_students').lean(),
    Procedure.find({ course_id: courseId }).lean(),
    CourseAssignment.find({
      course_id: courseId,
      assignment_role: 'student',
      status: 'active',
    }).distinct('user_id'),
    User.find({ role: 'student', enrolled_courses: courseId }).select('_id').lean(),
  ]);

  if (!course) {
    return { notFound: true, data: [] };
  }

  const uniqueStudentIds = [...new Set([
    ...(course.enrolled_students || []).map(String),
    ...assignedStudentIds.map(String),
    ...legacyStudents.map((student) => String(student._id)),
  ])];
  const totalStudents = uniqueStudentIds.length;

  if (totalStudents === 0 || procedures.length === 0) {
    return { notFound: false, data: [] };
  }

  const studentIds = uniqueStudentIds.map((id) => new mongoose.Types.ObjectId(id));
  const procedureIds = procedures.map((procedure) => procedure._id);

  const [approvedCases, pendingCases] = await Promise.all([
    LogbookCase.aggregate([
      {
        $match: {
          student_id: { $in: studentIds },
          procedure_id: { $in: procedureIds },
          evaluation_status: 'approved',
        },
      },
      {
        $group: {
          _id: { student_id: '$student_id', procedure_id: '$procedure_id' },
          count: { $sum: 1 },
        },
      },
    ]),
    LogbookCase.aggregate([
      {
        $match: {
          student_id: { $in: studentIds },
          procedure_id: { $in: procedureIds },
          evaluation_status: 'pending',
        },
      },
      {
        $group: {
          _id: '$procedure_id',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const approvedByProcedure = new Map();
  approvedCases.forEach((entry) => {
    const procId = String(entry._id.procedure_id);
    if (!approvedByProcedure.has(procId)) {
      approvedByProcedure.set(procId, []);
    }
    approvedByProcedure.get(procId).push(entry.count);
  });

  const pendingByProcedure = new Map(
    pendingCases.map((entry) => [String(entry._id), entry.count])
  );

  const data = procedures.map((procedure) => {
    const procIdStr = String(procedure._id);
    const required = Number(procedure.required_cases || procedure.target_score || 1);
    const studentCounts = approvedByProcedure.get(procIdStr) || [];

    const completedStudents = studentCounts.filter((count) => count >= required).length;
    const approvedCaseCount = studentCounts.reduce(
      (sum, count) => sum + Math.min(count, required),
      0
    );
    const targetCaseCount = required * totalStudents;
    const pendingCaseCount = pendingByProcedure.get(procIdStr) || 0;

    return {
      _id: procedure._id,
      procedure_name: procedure.procedure_name,
      completedStudents,
      totalStudents,
      percent: calculateProgressPercent(completedStudents, totalStudents),
      approvedCases: approvedCaseCount,
      targetCases: targetCaseCount,
      pendingCases: pendingCaseCount,
      casePercent: calculateProgressPercent(approvedCaseCount, targetCaseCount),
    };
  });

  return { notFound: false, data };
}

module.exports = {
  calculateProgressPercent,
  computeCourseSkillsStats,
};
