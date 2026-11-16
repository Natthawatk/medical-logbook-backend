const mongoose = require('mongoose');
const Course = require('../models/Course');
const User = require('../models/User');
const Location = require('../models/Location');
const CourseAssignment = require('../models/CourseAssignment');
const CourseLocation = require('../models/CourseLocation');
const Procedure = require('../models/Procedure');
const LogbookCase = require('../models/LogbookCase');
const { canManageCourse, hasCourseAccess } = require('../services/courseAccessService');

const validId = (value) => mongoose.Types.ObjectId.isValid(value);

const loadCourseAndAuthorize = async (req, res, manage = false) => {
  if (!validId(req.params.id)) {
    res.status(400).json({ success: false, data: null, message: 'Invalid course id.' });
    return null;
  }
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404).json({ success: false, data: null, message: 'Course not found.' });
    return null;
  }
  const allowed = manage
    ? await canManageCourse(req.user, course._id)
    : await hasCourseAccess(req.user, course._id);
  if (!allowed) {
    res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์ในรายวิชานี้' });
    return null;
  }
  return course;
};

exports.getCourseContext = async (req, res) => {
  try {
    const course = await loadCourseAndAuthorize(req, res);
    if (!course) return;
    const procedureIds = await Procedure.find({ course_id: course._id }).distinct('_id');
    const inferredPreceptorIds = procedureIds.length > 0
      ? await LogbookCase.find({ procedure_id: { $in: procedureIds } }).distinct('preceptor_id')
      : [];
    const [assignments, locations, legacyLocations, inferredPreceptors, legacyUsers] = await Promise.all([
      CourseAssignment.find({ course_id: course._id, status: 'active' })
        .populate('user_id', 'email firstname_lastname role student_id year semester phone_number profile_image academic_status')
        .sort({ assignment_role: 1, createdAt: 1 }).lean(),
      CourseLocation.find({ course_id: course._id, status: 'active' })
        .populate('location_id')
        .sort({ createdAt: 1 }),
      Location.find({ _id: { $in: course.enrolled_locations || [] } }),
      User.find({ _id: { $in: inferredPreceptorIds }, role: 'preceptor', academic_status: 'active' })
        .select('email firstname_lastname role student_id phone_number profile_image academic_status')
        .lean(),
      User.find({
        $or: [
          { _id: { $in: course.enrolled_students || [] } },
          { enrolled_courses: course._id },
        ],
        role: 'student',
      })
        .select('email firstname_lastname role student_id year semester phone_number profile_image academic_status')
        .lean(),
    ]);
    const assignmentKeys = new Set(assignments
      .filter((assignment) => assignment.user_id)
      .map((assignment) => `${assignment.assignment_role}:${assignment.user_id._id}`));
    legacyUsers.forEach((student) => {
      const key = `student:${student._id}`;
      if (!assignmentKeys.has(key)) {
        assignmentKeys.add(key);
        assignments.push({
          course_id: course._id,
          user_id: student,
          assignment_role: 'student',
          status: 'active',
          legacy_inferred: true,
        });
      }
    });
    inferredPreceptors.forEach((preceptor) => {
      const key = `preceptor:${preceptor._id}`;
      if (!assignmentKeys.has(key)) {
        assignments.push({
          course_id: course._id,
          user_id: preceptor,
          assignment_role: 'preceptor',
          status: 'active',
          legacy_inferred: true,
        });
      }
    });
    const locationById = new Map();
    locations.forEach((link) => {
      if (link.location_id) locationById.set(String(link.location_id._id), link);
    });
    legacyLocations.forEach((location) => {
      if (!locationById.has(String(location._id))) {
        locationById.set(String(location._id), { course_id: course._id, location_id: location, status: 'active' });
      }
    });
    return res.json({ success: true, data: { course, assignments, locations: [...locationById.values()] }, message: 'Course context fetched successfully.' });
  } catch (err) {
    console.error('Get course context error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Unable to fetch course context.' });
  }
};

exports.addMember = async (req, res) => {
  try {
    const course = await loadCourseAndAuthorize(req, res, true);
    if (!course) return;
    const { user_id } = req.body || {};
    if (!validId(user_id)) return res.status(400).json({ success: false, data: null, message: 'Invalid user_id.' });

    const user = await User.findById(user_id);
    if (!user || !['student', 'preceptor', 'course_instructor'].includes(user.role)) {
      return res.status(400).json({ success: false, data: null, message: 'User role cannot be assigned to a course.' });
    }
    if (user.academic_status !== 'active') {
      return res.status(400).json({ success: false, data: null, message: 'เพิ่มได้เฉพาะบัญชีที่มีสถานะ active' });
    }
    if (req.user.role === 'course_instructor' && user.role === 'course_instructor') {
      return res.status(403).json({ success: false, data: null, message: 'เฉพาะ Admin เท่านั้นที่แต่งตั้งอาจารย์ผู้รับผิดชอบรายวิชาได้' });
    }

    const assignment = await CourseAssignment.findOneAndUpdate(
      { course_id: course._id, user_id: user._id, assignment_role: user.role },
      { $set: { status: 'active', revoked_at: null, assigned_by: req.user.id, assigned_at: new Date() } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    if (user.role === 'student') {
      await Promise.all([
        Course.updateOne({ _id: course._id }, { $addToSet: { enrolled_students: user._id } }),
        User.updateOne({ _id: user._id }, { $addToSet: { enrolled_courses: course._id } }),
      ]);
      const count = await CourseAssignment.countDocuments({ course_id: course._id, assignment_role: 'student', status: 'active' });
      await Course.updateOne({ _id: course._id }, { $set: { enrolled_student_count: count } });
    }

    return res.status(201).json({ success: true, data: assignment, message: 'เพิ่มผู้ใช้เข้ารายวิชาแล้ว' });
  } catch (err) {
    console.error('Add course member error:', err);
    return res.status(500).json({ success: false, data: null, message: err.message || 'Unable to add course member.' });
  }
};

exports.removeMember = async (req, res) => {
  try {
    const course = await loadCourseAndAuthorize(req, res, true);
    if (!course) return;
    const { userId } = req.params;
    if (!validId(userId)) return res.status(400).json({ success: false, data: null, message: 'Invalid user id.' });

    const assignment = await CourseAssignment.findOne({ course_id: course._id, user_id: userId, status: 'active' });
    if (!assignment) return res.status(404).json({ success: false, data: null, message: 'Active assignment not found.' });
    if (assignment.assignment_role === 'course_instructor' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, data: null, message: 'เฉพาะ Admin เท่านั้นที่ยกเลิกผู้รับผิดชอบรายวิชาได้' });
    }

    assignment.status = 'inactive';
    assignment.revoked_at = new Date();
    await assignment.save();
    if (assignment.assignment_role === 'student') {
      await Promise.all([
        Course.updateOne({ _id: course._id }, { $pull: { enrolled_students: userId } }),
        User.updateOne({ _id: userId }, { $pull: { enrolled_courses: course._id } }),
      ]);
      const count = await CourseAssignment.countDocuments({ course_id: course._id, assignment_role: 'student', status: 'active' });
      await Course.updateOne({ _id: course._id }, { $set: { enrolled_student_count: count } });
    }
    return res.json({ success: true, data: assignment, message: 'นำผู้ใช้ออกจากรายวิชาแล้ว โดยไม่ได้ลบบัญชี' });
  } catch (err) {
    console.error('Remove course member error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Unable to remove course member.' });
  }
};

exports.addLocation = async (req, res) => {
  try {
    const course = await loadCourseAndAuthorize(req, res, true);
    if (!course) return;
    const { location_id } = req.body || {};
    if (!validId(location_id) || !(await Location.exists({ _id: location_id }))) {
      return res.status(400).json({ success: false, data: null, message: 'Invalid or missing location.' });
    }
    const link = await CourseLocation.findOneAndUpdate(
      { course_id: course._id, location_id },
      { $set: { status: 'active', added_by: req.user.id } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await Course.updateOne({ _id: course._id }, { $addToSet: { enrolled_locations: location_id } });
    return res.status(201).json({ success: true, data: link, message: 'เพิ่มสถานที่ในรายวิชาแล้ว' });
  } catch (err) {
    console.error('Add course location error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Unable to add course location.' });
  }
};

exports.removeLocation = async (req, res) => {
  try {
    const course = await loadCourseAndAuthorize(req, res, true);
    if (!course) return;
    const { locationId } = req.params;
    if (!validId(locationId)) return res.status(400).json({ success: false, data: null, message: 'Invalid location id.' });
    const link = await CourseLocation.findOneAndUpdate(
      { course_id: course._id, location_id: locationId, status: 'active' },
      { $set: { status: 'inactive' } },
      { new: true }
    );
    if (!link) return res.status(404).json({ success: false, data: null, message: 'Active course location not found.' });
    await Course.updateOne({ _id: course._id }, { $pull: { enrolled_locations: locationId } });
    return res.json({ success: true, data: link, message: 'นำสถานที่ออกจากรายวิชาแล้ว' });
  } catch (err) {
    console.error('Remove course location error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Unable to remove course location.' });
  }
};
