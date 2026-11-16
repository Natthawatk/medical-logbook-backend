const CourseAssignment = require('../models/CourseAssignment');
const Course = require('../models/Course');
const User = require('../models/User');
const Procedure = require('../models/Procedure');
const LogbookCase = require('../models/LogbookCase');

const ASSIGNMENT_ROLES = ['student', 'preceptor', 'course_instructor'];

const getAccessibleCourseIds = async (user, assignmentRoles) => {
  if (user.role === 'admin') return null;

  const roles = assignmentRoles || [user.role];
  const assignments = await CourseAssignment.find({
    user_id: user.id,
    assignment_role: { $in: roles },
    status: 'active',
  }).distinct('course_id');
  if (user.role === 'preceptor' && roles.includes('preceptor')) {
    const procedureIds = await LogbookCase.find({ preceptor_id: user.id }).distinct('procedure_id');
    const legacyCourseIds = procedureIds.length > 0
      ? await Procedure.find({ _id: { $in: procedureIds } }).distinct('course_id')
      : [];
    return [...new Map([...assignments, ...legacyCourseIds].map((courseId) => [String(courseId), courseId])).values()];
  }
  if (user.role !== 'student' || !roles.includes('student')) return assignments;

  // Transitional read for trustworthy legacy student enrollments. Merge both
  // directions because production may be only partially migrated.
  const [legacyUser, legacyCourses] = await Promise.all([
    User.findById(user.id).select('enrolled_courses').lean(),
    Course.find({ enrolled_students: user.id }).distinct('_id'),
  ]);
  return [...new Map([
    ...assignments,
    ...(legacyUser?.enrolled_courses || []),
    ...legacyCourses,
  ].map((courseId) => [String(courseId), courseId])).values()];
};

const hasCourseAccess = async (user, courseId, assignmentRoles) => {
  if (user.role === 'admin') return true;
  const roles = assignmentRoles || [user.role];
  if (!ASSIGNMENT_ROLES.includes(user.role)) return false;

  const assignment = await CourseAssignment.exists({
    course_id: courseId,
    user_id: user.id,
    assignment_role: { $in: roles },
    status: 'active',
  });
  if (assignment) return true;
  if (user.role === 'preceptor' && roles.includes('preceptor')) {
    const procedureIds = await Procedure.find({ course_id: courseId }).distinct('_id');
    return Boolean(await LogbookCase.exists({ procedure_id: { $in: procedureIds }, preceptor_id: user.id }));
  }
  if (user.role !== 'student' || !roles.includes('student')) return false;

  const [legacyUser, legacyCourse] = await Promise.all([
    User.exists({ _id: user.id, enrolled_courses: courseId }),
    Course.exists({ _id: courseId, enrolled_students: user.id }),
  ]);
  return Boolean(legacyUser || legacyCourse);
};

const canManageCourse = (user, courseId) =>
  hasCourseAccess(user, courseId, ['course_instructor']);

module.exports = {
  ASSIGNMENT_ROLES,
  getAccessibleCourseIds,
  hasCourseAccess,
  canManageCourse,
};
