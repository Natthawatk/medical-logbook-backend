const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const Location = require('../models/Location');
const CourseAssignment = require('../models/CourseAssignment');
const CourseLocation = require('../models/CourseLocation');
const Course = require('../models/Course');
const User = require('../models/User');
const { getAccessibleCourseIds, hasCourseAccess } = require('../services/courseAccessService');
const { calculateDistanceInMeters } = require('../utils/distanceHelper');
const { normalizeVerifierText, upsertLocationVerifier } = require('../services/centralPreceptorService');
const { invalidateDashboardCache } = require('../services/dashboardCacheService');

const { createNotification, notifyCourseInstructors } = require('./notificationController');

exports.checkIn = async (req, res) => {
  try {
    const {
      course_id,
      location_id,
      preceptor_id,
      latitude,
      longitude,
      on_site_verifier_name,
      on_site_verifier_position,
      on_site_verifier_phone,
    } = req.body || {};

    if (!course_id || !location_id || !preceptor_id || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุสถานที่ปฏิบัติงาน พิกัดละติจูด และพิกัดลองจิจูด',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(course_id) || !mongoose.Types.ObjectId.isValid(location_id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัสสถานที่ปฏิบัติงานไม่ถูกต้อง',
      });
    }

    if (preceptor_id && !mongoose.Types.ObjectId.isValid(preceptor_id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัสอาจารย์พี่เลี้ยงไม่ถูกต้อง',
      });
    }


    const location = await Location.findById(location_id);
    if (!location) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบสถานที่ปฏิบัติงาน',
      });
    }

    const [studentAssignment, preceptorAssignment, courseLocation, legacyCourseLocation, preceptorDoc] = await Promise.all([
      hasCourseAccess(req.user, course_id, ['student']),
      hasCourseAccess({ id: preceptor_id, role: 'preceptor' }, course_id, ['preceptor']),
      CourseLocation.exists({ course_id, location_id, status: 'active' }),
      Course.exists({ _id: course_id, enrolled_locations: location_id }),
      User.findById(preceptor_id).select('role is_shared_account academic_status').lean(),
    ]);
    if (!studentAssignment) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่ได้เป็นนักศึกษาในรายวิชานี้' });
    }
    if (!courseLocation && !legacyCourseLocation) {
      return res.status(400).json({ success: false, data: null, message: 'สถานที่ไม่ได้อยู่ในรายวิชานี้' });
    }
    if (!preceptorDoc || preceptorDoc.role !== 'preceptor') {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลอาจารย์พี่เลี้ยง' });
    }
    const isCentralForLocation = String(location.central_preceptor_id || '') === String(preceptor_id);
    if (preceptorDoc.is_shared_account && !isCentralForLocation) {
      return res.status(400).json({ success: false, data: null, message: 'บัญชีกลางที่เลือกไม่ได้ผูกกับสถานที่ปฏิบัติงานนี้' });
    }
    if (!preceptorAssignment) {
      if (isCentralForLocation) {
        await CourseAssignment.findOneAndUpdate(
          { course_id, user_id: preceptor_id, assignment_role: 'preceptor' },
          { $set: { status: 'active', revoked_at: null, assigned_at: new Date() } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );
      } else {
        return res.status(400).json({ success: false, data: null, message: 'พี่เลี้ยงไม่ได้อยู่ในรายวิชานี้' });
      }
    }

    const verifierName = normalizeVerifierText(on_site_verifier_name);
    const verifierPosition = normalizeVerifierText(on_site_verifier_position);
    const verifierPhone = normalizeVerifierText(on_site_verifier_phone);

    if (isCentralForLocation && !verifierName) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาเลือกหรือกรอกชื่อผู้ยืนยันหน้างานเมื่อใช้บัญชีกลางประจำสถานที่',
      });
    }

    const allowedRadius = Number(location.radius || 0);
    const distance = calculateDistanceInMeters(
      Number(latitude),
      Number(longitude),
      Number(location.latitude),
      Number(location.longitude)
    );

    if (distance > allowedRadius) {
      return res.status(400).json({
        success: false,
        data: null,
        message: `ลงเวลาไม่สำเร็จ คุณอยู่นอกระยะที่กำหนด (${Math.round(distance)}ม. > ${allowedRadius}ม.)`,
      });
    }

    const createdShift = await Shift.create({
      course_id,
      student_id: req.user.id,
      location_id,
      preceptor_id,
      on_site_verifier_name: isCentralForLocation ? verifierName : '',
      on_site_verifier_position: isCentralForLocation ? verifierPosition : '',
      on_site_verifier_phone: isCentralForLocation ? verifierPhone : '',
      shift_date: new Date(),
      Check_in_lat: Number(latitude),
      Check_in_lng: Number(longitude),
      shift_status: 'normal',
      verify_status: 'pending',
    });
    invalidateDashboardCache();

    if (isCentralForLocation && verifierName) {
      await upsertLocationVerifier(location, {
        name: verifierName,
        position: verifierPosition,
        phone: verifierPhone,
        createdBy: req.user.id,
      });
    }

    const checkinStudent = preceptor_id
      ? await User.findById(req.user.id).select('firstname_lastname student_id').lean()
      : null;
    const checkinLabel = checkinStudent
      ? `${checkinStudent.firstname_lastname || 'นักศึกษา'}${checkinStudent.student_id ? ` (${checkinStudent.student_id})` : ''}`
      : 'นักศึกษา';
    const verifierSuffix = isCentralForLocation && verifierName ? ` (ผู้ยืนยันหน้างาน: ${verifierName})` : '';

    // 1. Notify the Preceptor
    if (preceptor_id) {
      await createNotification({
        recipient_id: preceptor_id,
        sender_id: req.user.id,
        target_id: createdShift._id,
        type: 'shift_checkin', // Adjusted type for shifts
        message: `นักศึกษา ${checkinLabel} ลงเวลาเข้าเวรที่ ${location.Location_name}${verifierSuffix} รอการยืนยันจากคุณ`,
      });
    }

    // 2. Notify the Student (Confirmation)
    await createNotification({
      recipient_id: req.user.id,
      sender_id: req.user.id,
      target_id: createdShift._id,
      type: 'shift_checkin',
      message: `ลงเวลาเข้าเวรที่ ${location.Location_name} เรียบร้อยแล้ว รอดำเนินการยืนยัน`,
    });

    return res.status(201).json({
      success: true,
      data: createdShift,
      message: 'ลงเวลาเข้าเวรสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Check-in error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดระหว่างการลงเวลา',
    });
  }
};

exports.getMyShifts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const query = { student_id: req.user.id };
    const total = await Shift.countDocuments(query);
    const shifts = await Shift.find(query)
      .populate('location_id')
      .populate('preceptor_id', 'firstname_lastname email')
      .sort({ shift_date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: shifts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'ดึงข้อมูลประวัติการเข้าเวรสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get my shifts error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลประวัติการเข้าเวร',
    });
  }
};

exports.getPreceptorShifts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const query = { preceptor_id: req.user.id };
    const total = await Shift.countDocuments(query);
    const shifts = await Shift.find(query)
      .populate('student_id', 'firstname_lastname profile_image student_id year')
      .populate('location_id', 'Location_name')
      .sort({ shift_date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: shifts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'ดึงข้อมูลการเข้าเวรของนักศึกษาสำเร็จ',
    });
  } catch (err) {
    console.error('Get preceptor shifts error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลการเข้าเวรของนักศึกษา',
    });
  }
};

exports.verifyShift = async (req, res) => {
  try {
    const { id } = req.params;
    const { verify_status, shift_status, preceptor_id } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัสการเข้าเวรไม่ถูกต้อง',
      });
    }

    const normalizedStatus = String(verify_status || '').toLowerCase();
    const allowedStatuses = ['pending', 'verified', 'rejected'];
    if (verify_status && !allowedStatuses.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "สถานะการยืนยันต้องเป็น 'pending', 'verified' หรือ 'rejected'",
      });
    }

    const updateData = {};
    if (verify_status) {
        updateData.verify_status = normalizedStatus;
        if (normalizedStatus === 'verified' || normalizedStatus === 'rejected') {
          updateData.verified_at = new Date();
        }
    }

    if (shift_status) {
        const allowedShiftStatuses = ['normal', 'late', 'absent', 'leave'];
        if (!allowedShiftStatuses.includes(shift_status)) {
            return res.status(400).json({
                success: false,
                message: "สถานะการเข้าเวรไม่ถูกต้อง"
            });
        }
        updateData.shift_status = shift_status;
    }

    if (req.user.role === 'preceptor') {
      updateData.preceptor_id = req.user.id;
    } else if (req.user.role === 'admin' && preceptor_id) {
      if (!mongoose.Types.ObjectId.isValid(preceptor_id)) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'รหัสอาจารย์พี่เลี้ยงไม่ถูกต้อง',
        });
      }
      updateData.preceptor_id = preceptor_id;
    }

    const shift = await Shift.findById(id);
    if (!shift) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลการเข้าเวร',
      });
    }

    if (req.user.role === 'preceptor') {
      if (!shift.preceptor_id || String(shift.preceptor_id) !== String(req.user.id)) {
        return res.status(403).json({ success: false, data: null, message: 'คุณไม่ได้เป็นพี่เลี้ยงที่ระบุในเวรนี้' });
      }
      if (shift.course_id) {
        const activeAssignment = await CourseAssignment.exists({
          course_id: shift.course_id,
          user_id: req.user.id,
          assignment_role: 'preceptor',
          status: 'active',
        });
        if (!activeAssignment) {
          return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์ยืนยันเวรในรายวิชานี้' });
        }
      }
    }

    const updatedShift = await Shift.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: false }
    ).populate('student_id', 'firstname_lastname profile_image student_id year')
     .populate('location_id', 'Location_name');
    invalidateDashboardCache();

    const studentId = updatedShift.student_id?._id || updatedShift.student_id;

    // Notify the Student about the verification result - ONLY when finalized
    if (normalizedStatus === 'verified' || normalizedStatus === 'rejected') {
        const statusText = normalizedStatus === 'verified' ? 'ได้รับการยืนยันแล้ว' : 'ถูกปฏิเสธ';
        await createNotification({
          recipient_id: studentId,
          sender_id: req.user.id,
          target_id: updatedShift._id,
          type: 'shift_verified',
          message: `การเข้าเวรที่ ${updatedShift.location_id?.Location_name || 'สถานที่ปฏิบัติงาน'} ${statusText}`,
        });
    }

    const nextShiftStatus = updatedShift.shift_status;
    const isLateOrAbsent = nextShiftStatus === 'late' || nextShiftStatus === 'absent';
    const becameLateOrAbsent = isLateOrAbsent && (
      shift.shift_status !== nextShiftStatus ||
      (normalizedStatus === 'verified' && shift.verify_status !== 'verified')
    );
    const shiftCourseId = updatedShift.course_id?._id || updatedShift.course_id;

    if (becameLateOrAbsent && shiftCourseId) {
      const studentName = updatedShift.student_id?.firstname_lastname || 'นักศึกษา';
      const studentCode = updatedShift.student_id?.student_id ? ` (${updatedShift.student_id.student_id})` : '';
      const locationName = updatedShift.location_id?.Location_name || 'สถานที่ปฏิบัติงาน';
      const course = await Course.findById(shiftCourseId).select('course_code').lean();
      const courseCodeLabel = course?.course_code ? ` [${course.course_code}]` : '';
      const alertLabel = nextShiftStatus === 'absent' ? 'ขาดการเข้าเวร' : 'มาสายในการเข้าเวร';

      await notifyCourseInstructors({
        courseId: shiftCourseId,
        senderId: req.user.id,
        targetId: updatedShift._id,
        type: 'instructor_shift_alert',
        severity: nextShiftStatus === 'absent' ? 'danger' : 'warning',
        actionUrl: `/admin/students/${studentId}`,
        message: `${studentName}${studentCode} ${alertLabel} ที่ ${locationName}${courseCodeLabel}`,
      });

      const accumulatedAlerts = await Shift.countDocuments({
        student_id: studentId,
        course_id: shiftCourseId,
        shift_status: { $in: ['late', 'absent'] },
        verify_status: { $ne: 'rejected' },
      });
      if (accumulatedAlerts >= 3 && accumulatedAlerts % 3 === 0) {
        await notifyCourseInstructors({
          courseId: shiftCourseId,
          senderId: req.user.id,
          targetId: updatedShift._id,
          type: 'instructor_attendance_threshold',
          severity: 'danger',
          actionUrl: `/admin/students/${studentId}`,
          message: `${studentName}${studentCode} มีประวัติมาสาย/ขาดเวรสะสมครบ ${accumulatedAlerts} ครั้งในรายวิชา${courseCodeLabel || ''}`,
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: updatedShift,
      message: 'อัปเดตสถานะการเข้าเวรสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Verify shift error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะยืนยันการเข้าเวร',
    });
  }
};


exports.getUserShifts = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, data: null, message: 'รหัสนักศึกษาไม่ถูกต้อง' });
    }

    const query = { student_id: new mongoose.Types.ObjectId(id) };
    if (req.user.role === 'course_instructor') {
      const courseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
      query.course_id = { $in: courseIds };
    }

    const shifts = await Shift.find(query)
      .populate('course_id', 'course_code course_name')
      .populate('location_id', 'Location_name')
      .populate('preceptor_id', 'firstname_lastname email')
      .sort({ shift_date: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: shifts });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get user shifts error:', err);
    return res.status(500).json({ success: false, data: null, message: 'ไม่สามารถดึงข้อมูลการเข้าเวรได้' });
  }
};

exports.updateShiftByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, data: null, message: 'รหัสการเข้าเวรไม่ถูกต้อง' });
    }

    const shift = await Shift.findById(id);
    if (!shift) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลการเข้าเวร' });
    }

    const { location_id, preceptor_id, shift_date, shift_status, verify_status } = req.body || {};

    if (location_id !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(location_id)) {
        return res.status(400).json({ success: false, data: null, message: 'รหัสสถานที่ไม่ถูกต้อง' });
      }
      if (shift.course_id) {
        const linked = await CourseLocation.exists({
          course_id: shift.course_id,
          location_id,
          status: 'active',
        });
        if (!linked) {
          return res.status(400).json({ success: false, data: null, message: 'สถานที่ที่เลือกไม่ได้อยู่ในรายวิชานี้' });
        }
      } else if (!(await Location.exists({ _id: location_id }))) {
        return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลสถานที่' });
      }
      shift.location_id = location_id;
    }

    if (preceptor_id !== undefined) {
      if (!preceptor_id) {
        shift.preceptor_id = undefined;
      } else {
        if (!mongoose.Types.ObjectId.isValid(preceptor_id)) {
          return res.status(400).json({ success: false, data: null, message: 'รหัสอาจารย์พี่เลี้ยงไม่ถูกต้อง' });
        }
        if (shift.course_id) {
          const assigned = await CourseAssignment.exists({
            course_id: shift.course_id,
            user_id: preceptor_id,
            assignment_role: 'preceptor',
            status: 'active',
          });
          if (!assigned) {
            return res.status(400).json({ success: false, data: null, message: 'อาจารย์พี่เลี้ยงไม่ได้อยู่ในรายวิชานี้' });
          }
        }
        shift.preceptor_id = preceptor_id;
      }
    }

    if (shift_date !== undefined) {
      const parsedDate = new Date(shift_date);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ success: false, data: null, message: 'วันเวลาที่ลงเวลาไม่ถูกต้อง' });
      }
      shift.shift_date = parsedDate;
    }

    if (shift_status !== undefined) {
      const allowedShiftStatuses = ['normal', 'late', 'absent', 'leave'];
      if (!allowedShiftStatuses.includes(shift_status)) {
        return res.status(400).json({ success: false, data: null, message: 'ประเภทการเข้าเวรไม่ถูกต้อง' });
      }
      shift.shift_status = shift_status;
    }

    if (verify_status !== undefined) {
      const allowedVerifyStatuses = ['pending', 'verified', 'rejected'];
      if (!allowedVerifyStatuses.includes(verify_status)) {
        return res.status(400).json({ success: false, data: null, message: 'สถานะการยืนยันไม่ถูกต้อง' });
      }
      shift.verify_status = verify_status;
      if (verify_status === 'verified' || verify_status === 'rejected') {
        shift.verified_at = shift.verified_at || new Date();
      } else {
        shift.verified_at = undefined;
      }
    }

    await shift.save();
    invalidateDashboardCache();

    const updated = await Shift.findById(shift._id)
      .populate('course_id', 'course_code course_name')
      .populate('location_id', 'Location_name')
      .populate('preceptor_id', 'firstname_lastname email')
      .lean();

    return res.status(200).json({
      success: true,
      data: updated,
      message: 'อัปเดตประวัติการเข้าเวรเรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Admin update shift error:', err);
    return res.status(500).json({ success: false, data: null, message: 'ไม่สามารถอัปเดตประวัติการเข้าเวรได้' });
  }
};

exports.deleteShiftByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, data: null, message: 'รหัสการเข้าเวรไม่ถูกต้อง' });
    }

    const deleted = await Shift.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลการเข้าเวร' });
    }
    invalidateDashboardCache();

    return res.status(200).json({
      success: true,
      data: null,
      message: 'ลบประวัติการเข้าเวรเรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Admin delete shift error:', err);
    return res.status(500).json({ success: false, data: null, message: 'ไม่สามารถลบประวัติการเข้าเวรได้' });
  }
};
