const mongoose = require('mongoose');
const LogbookCase = require('../models/LogbookCase');
const User = require('../models/User');
const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const { createNotification, notifyCourseInstructors } = require('../controllers/notificationController');

/**
 * Given a list of procedure definitions and student IDs, return a Set of student ID strings
 * who currently satisfy required approved case counts for ALL procedures in the list.
 */
async function getCompletedStudentSetForProcedures(procedures, studentIds) {
  if (!Array.isArray(procedures) || procedures.length === 0) return new Set();
  if (!Array.isArray(studentIds) || studentIds.length === 0) return new Set();

  const procedureIds = procedures.map((p) => new mongoose.Types.ObjectId(p._id));
  const studentObjectIds = studentIds.map((id) => new mongoose.Types.ObjectId(id));

  const stats = await LogbookCase.aggregate([
    {
      $match: {
        student_id: { $in: studentObjectIds },
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
  ]);

  const countByStudentProc = new Map();
  for (const row of stats) {
    countByStudentProc.set(`${row._id.student_id}:${row._id.procedure_id}`, row.count);
  }

  const completed = new Set();
  for (const sid of studentIds) {
    const sidStr = String(sid);
    const allMet = procedures.every((proc) => {
      const reqCount = Number(proc.required_cases || proc.target_score || 1);
      const count = countByStudentProc.get(`${sidStr}:${proc._id}`) || 0;
      return count >= reqCount;
    });
    if (allMet) completed.add(sidStr);
  }
  return completed;
}

/**
 * Send completion alerts to course instructors and congratulatory notification to student.
 */
async function notifyCourseCompletionForStudents({
  studentIds,
  courseId,
  courseDoc,
  senderId,
  targetId,
  procedures,
  reasonLabel,
}) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return;

  const course = courseDoc || await Course.findById(courseId).select('course_code course_name').lean();
  const courseLabel = course?.course_code
    ? `[${course.course_code}] ${course.course_name || ''}`.trim()
    : course?.course_name || 'รายวิชา';

  const totalProcedures = procedures.length;
  const totalRequiredCases = procedures.reduce(
    (sum, proc) => sum + Number(proc.required_cases || proc.target_score || 1),
    0
  );

  const students = await User.find({ _id: { $in: studentIds } })
    .select('firstname_lastname student_id')
    .lean();
  const studentMap = new Map(students.map((s) => [String(s._id), s]));

  await Promise.all(
    studentIds.map(async (sid) => {
      const sidStr = String(sid);
      const student = studentMap.get(sidStr);
      const studentLabel = student
        ? `${student.firstname_lastname || 'นักศึกษา'}${student.student_id ? ` (${student.student_id})` : ''}`
        : 'นักศึกษา';
      const detailSuffix = reasonLabel ? ` (${totalProcedures} หัตถการ / ${totalRequiredCases} เคส ${reasonLabel})` : ` (${totalProcedures} หัตถการ / ${totalRequiredCases} เคส)`;

      await notifyCourseInstructors({
        courseId,
        senderId,
        targetId,
        type: 'instructor_course_completed',
        severity: 'success',
        actionUrl: `/admin/students/${sidStr}`,
        message: `${studentLabel} ทำเคสครบทุกหัตถการในรายวิชา ${courseLabel} แล้ว${detailSuffix}`,
      });

      await createNotification({
        recipient_id: sidStr,
        sender_id: senderId || sidStr,
        target_id: targetId,
        type: 'student_course_completed',
        severity: 'success',
        action_url: '/logbook-cases',
        message: `ยินดีด้วย! คุณทำเคสครบทุกหัตถการในรายวิชา ${courseLabel} แล้ว (${totalProcedures} หัตถการ)`,
      });
    })
  );
}

/**
 * Helper to fetch active student IDs of a course.
 */
async function getActiveStudentIdsForCourse(courseId) {
  if (!courseId) return [];
  const ids = await CourseAssignment.find({
    course_id: courseId,
    assignment_role: 'student',
    status: 'active',
  }).distinct('user_id');
  return [...new Set(ids.map(String))];
}

module.exports = {
  getCompletedStudentSetForProcedures,
  notifyCourseCompletionForStudents,
  getActiveStudentIdsForCourse,
};
