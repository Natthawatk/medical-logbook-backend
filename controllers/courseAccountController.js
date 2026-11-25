const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const { canManageCourse, getAccessibleCourseIds } = require('../services/courseAccessService');
const { createNotification, notifyAdmins, getActorLabel } = require('./notificationController');
const { invalidateDashboardCache } = require('../services/dashboardCacheService');
const {
  asString,
  asTrimmedString,
  isValidImageUrlOrPath,
  validatePassword,
  resolveInitialPassword,
} = require('../middlewares/securityMiddleware');

const ALLOWED_ROLES = new Set(['student', 'preceptor', 'course_instructor', 'admin']);
const ALLOWED_ACADEMIC_STATUSES = new Set(['active', 'inactive']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const serializeUser = (doc) => {
  const user = doc.toObject ? doc.toObject() : { ...doc };
  delete user.password;
  return user;
};

exports.createAccount = async (req, res) => {
  try {
    const body = req.body || {};
    const email = asTrimmedString(body.email);
    const role = asTrimmedString(body.role);
    const firstname_lastname = asTrimmedString(body.firstname_lastname);
    const student_id = asTrimmedString(body.student_id);
    const course_id = asTrimmedString(body.course_id);
    if (!email || !role || !firstname_lastname) {
      return res.status(400).json({ success: false, data: null, message: 'กรุณาระบุอีเมล บทบาท และชื่อ-นามสกุล' });
    }
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ success: false, data: null, message: 'รูปแบบอีเมลไม่ถูกต้อง' });
    }
    if (!isValidImageUrlOrPath(body.profile_image)) {
      return res.status(400).json({ success: false, data: null, message: 'URL รูปโปรไฟล์ไม่ถูกต้อง' });
    }
    const rawDefaultPassword = body.defaultPassword !== undefined && body.defaultPassword !== null
      ? asString(body.defaultPassword)
      : '';
    if (rawDefaultPassword !== '') {
      const passwordError = validatePassword(rawDefaultPassword, {
        email,
        studentId: student_id,
      });
      if (passwordError) {
        return res.status(400).json({ success: false, data: null, message: passwordError });
      }
    }
    const allowedRoles = req.user.role === 'admin'
      ? ['student', 'preceptor', 'course_instructor', 'admin']
      : ['student', 'preceptor'];
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        data: null,
        message: req.user.role === 'admin' ? 'บทบาทไม่ถูกต้อง' : 'อาจารย์ผู้รับผิดชอบรายวิชาสร้างได้เฉพาะ Student หรือ Preceptor',
      });
    }
    if (role === 'student' && !student_id) {
      return res.status(400).json({ success: false, data: null, message: 'กรุณาระบุรหัสนักศึกษา' });
    }
    if (req.user.role === 'course_instructor' && !course_id) {
      return res.status(400).json({ success: false, data: null, message: 'กรุณาระบุรายวิชาที่ต้องการเพิ่มบัญชี' });
    }
    if (course_id && !mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({ success: false, data: null, message: 'Invalid course_id.' });
    }
    if (course_id && role === 'admin') {
      return res.status(400).json({ success: false, data: null, message: 'บัญชี Admin ไม่สามารถเป็นสมาชิกของรายวิชาได้' });
    }
    if (course_id && !(await canManageCourse(req.user, course_id))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์จัดการรายวิชานี้' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      if (!course_id) return res.status(409).json({ success: false, data: null, message: 'อีเมลนี้มีบัญชีอยู่แล้ว' });
      if (existing.role !== role) {
        return res.status(409).json({ success: false, data: null, message: `อีเมลนี้เป็นบทบาท ${existing.role} และบทบาทบัญชีเปลี่ยนไม่ได้` });
      }
      const assignment = await CourseAssignment.findOneAndUpdate(
        { course_id, user_id: existing._id, assignment_role: role },
        { $set: { status: 'active', revoked_at: null, assigned_by: req.user.id, assigned_at: new Date() } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );
      if (role === 'student') {
        await Promise.all([
          User.updateOne({ _id: existing._id }, { $addToSet: { enrolled_courses: course_id } }),
          Course.updateOne({ _id: course_id }, { $addToSet: { enrolled_students: existing._id } }),
        ]);
        const count = await CourseAssignment.countDocuments({ course_id, assignment_role: 'student', status: 'active' });
        await Course.updateOne({ _id: course_id }, { $set: { enrolled_student_count: count } });
      }
      const [actorLabel, assignedCourse] = await Promise.all([
        getActorLabel(req.user.id),
        Course.findById(course_id).select('course_code course_name').lean(),
      ]);
      const courseLabel = assignedCourse ? `[${assignedCourse.course_code}] ${assignedCourse.course_name}` : 'รายวิชา';
      const userActionUrl = existing.role === 'student' ? '/logbook-cases' : '/preceptor/dashboard';
      await Promise.all([
        notifyAdmins({
          senderId: req.user.id,
          type: 'admin_course_alert',
          severity: 'info',
          sendPush: false,
          actionUrl: '/admin/courses',
          message: `${actorLabel} เพิ่มสมาชิก ${existing.firstname_lastname} เข้ารายวิชา ${courseLabel}`,
        }),
        createNotification({
          recipient_id: existing._id,
          sender_id: req.user.id,
          type: 'course_membership_changed',
          severity: 'success',
          sendPush: true,
          action_url: userActionUrl,
          message: `คุณถูกเพิ่มเข้ารายวิชา ${courseLabel} แล้ว`,
        }),
      ]);
      invalidateDashboardCache();
      return res.status(200).json({ success: true, data: { user: serializeUser(existing), assignment }, message: 'บัญชีมีอยู่แล้ว ระบบเพิ่มเข้ารายวิชาโดยไม่สร้างซ้ำ' });
    }

    const resolvedPassword = resolveInitialPassword(rawDefaultPassword, {
      email: normalizedEmail,
      studentId: role === 'student' ? student_id : '',
    });
    if (resolvedPassword.error) {
      return res.status(400).json({ success: false, data: null, message: resolvedPassword.error });
    }

    const password = await bcrypt.hash(resolvedPassword.password, 10);
    const shouldForceChange = Boolean(
      resolvedPassword.isAutoGenerated || body.must_change_password === true
    );
    const created = await User.create({
      email: normalizedEmail,
      password,
      role,
      firstname_lastname,
      phone_number: body.phone_number,
      profile_image: body.profile_image,
      student_id: role === 'student' ? student_id : undefined,
      year: role === 'student' ? body.year : undefined,
      semester: body.semester,
      academic_status: body.academic_status || 'active',
      must_change_password: shouldForceChange,
      created_by: req.user.id,
    });

    let assignment = null;
    if (course_id) {
      assignment = await CourseAssignment.create({ course_id, user_id: created._id, assignment_role: role, assigned_by: req.user.id });
      if (role === 'student') {
        await Promise.all([
          User.updateOne({ _id: created._id }, { $addToSet: { enrolled_courses: course_id } }),
          Course.updateOne({ _id: course_id }, { $addToSet: { enrolled_students: created._id } }),
        ]);
        const count = await CourseAssignment.countDocuments({ course_id, assignment_role: 'student', status: 'active' });
        await Course.updateOne({ _id: course_id }, { $set: { enrolled_student_count: count } });
      }
    }
    const actorLabel = await getActorLabel(req.user.id);
    const roleLabelMap = { student: 'นักศึกษา', preceptor: 'อาจารย์พี่เลี้ยง', course_instructor: 'อาจารย์ผู้รับผิดชอบวิชา', admin: 'แอดมิน' };
    const roleLabel = roleLabelMap[role] || role;
    const codeLabel = created.student_id ? ` (${created.student_id})` : '';
    const isHighPrivilege = role === 'admin' || role === 'course_instructor';
    await notifyAdmins({
      senderId: req.user.id,
      type: 'admin_account_alert',
      severity: isHighPrivilege ? 'warning' : 'success',
      sendPush: true,
      actionUrl: role === 'student' ? `/admin/students/${created._id}` : '/admin/accounts',
      message: `${actorLabel} เพิ่มบัญชี${roleLabel} ${created.firstname_lastname}${codeLabel}`,
    });
    if (course_id) {
      const assignedCourse = await Course.findById(course_id).select('course_code course_name').lean();
      const courseLabel = assignedCourse ? `[${assignedCourse.course_code}] ${assignedCourse.course_name}` : 'รายวิชา';
      await createNotification({
        recipient_id: created._id,
        sender_id: req.user.id,
        type: 'course_membership_changed',
        severity: 'success',
        sendPush: false,
        action_url: role === 'student' ? '/logbook-cases' : role === 'preceptor' ? '/preceptor/dashboard' : '/instructor/dashboard',
        message: `คุณถูกเพิ่มเข้ารายวิชา ${courseLabel} แล้ว`,
      });
    }
    invalidateDashboardCache();
    return res.status(201).json({
      success: true,
      data: {
        user: serializeUser(created),
        assignment,
        ...(resolvedPassword.isAutoGenerated ? { temporary_password: resolvedPassword.password } : {}),
      },
      message: resolvedPassword.isAutoGenerated
        ? 'สร้างบัญชีและสุ่มรหัสผ่านเริ่มต้นที่ปลอดภัยเรียบร้อยแล้ว'
        : 'สร้างบัญชีเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Create course account error:', err);
    if (err.code === 11000) return res.status(409).json({ success: false, data: null, message: 'ข้อมูลซ้ำกับบัญชีในระบบ' });
    return res.status(500).json({ success: false, data: null, message: err.message || 'Unable to create account.' });
  }
};

exports.getAccounts = async (req, res) => {
  try {
    const rawRole = asTrimmedString(req.query.role);
    const rawAcademicStatus = asTrimmedString(req.query.academic_status);
    const rawScope = asTrimmedString(req.query.scope);
    const rawSemester = asTrimmedString(req.query.semester);
    const requestedCourse = asTrimmedString(req.query.course_id);

    const filter = {};
    if (rawRole) {
      if (!ALLOWED_ROLES.has(rawRole)) {
        return res.status(400).json({ success: false, data: null, message: 'บทบาทไม่ถูกต้อง' });
      }
      filter.role = rawRole;
    }
    if (rawAcademicStatus) {
      if (!ALLOWED_ACADEMIC_STATUSES.has(rawAcademicStatus)) {
        return res.status(400).json({ success: false, data: null, message: 'สถานะไม่ถูกต้อง' });
      }
      filter.academic_status = rawAcademicStatus;
    }
    if (rawScope === 'enrollable' && !filter.academic_status) {
      filter.academic_status = 'active';
    }
    if (req.user.role === 'admin') {
      const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
      return res.json({ success: true, data: users, message: 'Users fetched successfully.' });
    }
    if (rawScope === 'enrollable' && ['student', 'preceptor', 'course_instructor'].includes(rawRole)) {
      const enrollableFilter = { role: rawRole, academic_status: 'active' };
      if (rawSemester) enrollableFilter.semester = rawSemester;
      const users = await User.find(enrollableFilter)
        .select('_id firstname_lastname email role student_id year semester academic_status profile_image')
        .sort({ createdAt: -1 });
      return res.json({ success: true, data: users, message: `Enrollable ${rawRole}s fetched successfully.` });
    }
    const courseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
    if (requestedCourse && !mongoose.Types.ObjectId.isValid(requestedCourse)) {
      return res.status(400).json({ success: false, data: null, message: 'Invalid course_id.' });
    }
    if (requestedCourse && !courseIds.some((id) => String(id) === String(requestedCourse))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์ในรายวิชานี้' });
    }
    const userIds = await CourseAssignment.find({
      course_id: { $in: requestedCourse ? [requestedCourse] : courseIds },
      assignment_role: { $in: ['student', 'preceptor'] },
      status: 'active',
    }).distinct('user_id');
    if (requestedCourse) {
      filter._id = { $in: userIds };
    } else {
      filter.$or = [
        { _id: { $in: userIds } },
        { created_by: req.user.id, role: { $in: ['student', 'preceptor'] } },
      ];
    }
    const users = await User.find(filter).select('-password').sort({ createdAt: -1 });
    return res.json({ success: true, data: users, message: 'Course accounts fetched successfully.' });
  } catch (err) {
    console.error('Get course accounts error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Unable to fetch accounts.' });
  }
};
