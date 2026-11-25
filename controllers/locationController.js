const mongoose = require('mongoose');
const Location = require('../models/Location');
const Course = require('../models/Course');
const CourseLocation = require('../models/CourseLocation');
const User = require('../models/User');
const { getAccessibleCourseIds } = require('../services/courseAccessService');
const { asTrimmedString } = require('../middlewares/securityMiddleware');
const { createNotification, notifyAdmins, getActorLabel } = require('./notificationController');
const { invalidateDashboardCache } = require('../services/dashboardCacheService');
const {
  sanitizeSavedVerifiersInput,
  validateCentralPreceptorPayload,
  applyCentralPreceptorAction,
} = require('../services/centralPreceptorService');

const CENTRAL_PRECEPTOR_SELECT = 'firstname_lastname email phone_number is_shared_account academic_status';

const canAccessLocation = async (user, location, assignmentRoles) => {
  if (user.role === 'admin') return true;
  if (
    user.role === 'course_instructor' &&
    String(location.created_by || '') === String(user.id)
  ) {
    return true;
  }

  const courseIds = await getAccessibleCourseIds(user, assignmentRoles);
  if (!courseIds || courseIds.length === 0) return false;

  const [linked, legacyLinked] = await Promise.all([
    CourseLocation.exists({
      course_id: { $in: courseIds },
      location_id: location._id,
      status: 'active',
    }),
    Course.exists({ _id: { $in: courseIds }, enrolled_locations: location._id }),
  ]);
  return Boolean(linked || legacyLinked);
};

const canManageLocation = (user, location) => {
  if (user.role === 'admin') return Promise.resolve(true);
  if (user.role !== 'course_instructor') return Promise.resolve(false);
  return canAccessLocation(user, location, ['course_instructor']);
};

exports.createLocation = async (req, res) => {
  try {
    const {
      Location_name,
      semester,
      Location_image,
      latitude,
      longitude,
      radius,
      central_preceptor_id,
      central_preceptor,
      saved_verifiers,
    } = req.body || {};

    if (!Location_name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Location_name, latitude, and longitude are required.',
      });
    }

    const duplicate = await Location.findOne({ Location_name: String(Location_name).trim() });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'Location with this name already exists.',
      });
    }

    let validatedCentral;
    try {
      validatedCentral = await validateCentralPreceptorPayload({
        central_preceptor_id,
        central_preceptor,
        requireCentral: true,
        hasExistingCentral: false,
      });
    } catch (validationErr) {
      return res.status(validationErr.status || 400).json({
        success: false,
        data: null,
        message: validationErr.message,
      });
    }

    const cleanedVerifiers = sanitizeSavedVerifiersInput(saved_verifiers, req.user.id);

    const created = await Location.create({
      created_by: req.user.id,
      Location_name: String(Location_name).trim(),
      semester,
      Location_image,
      latitude,
      longitude,
      radius,
      ...(cleanedVerifiers ? { saved_verifiers: cleanedVerifiers } : {}),
    });

    const centralResult = await applyCentralPreceptorAction({
      location: created,
      actorId: req.user.id,
      validated: validatedCentral,
    });

    const populated = await Location.findById(created._id)
      .populate('central_preceptor_id', CENTRAL_PRECEPTOR_SELECT)
      .lean();

    const actorLabel = await getActorLabel(req.user.id);
    const semLabel = created.semester ? ` (เทอม ${created.semester})` : '';
    await notifyAdmins({
      senderId: req.user.id,
      type: 'admin_location_alert',
      severity: 'success',
      sendPush: true,
      actionUrl: '/admin/locations',
      message: `${actorLabel} เพิ่มสถานที่ปฏิบัติงาน "${created.Location_name}"${semLabel}`,
    });

    invalidateDashboardCache();
    return res.status(201).json({
      success: true,
      data: populated || created,
      ...(centralResult?.generatedCentralCredentials
        ? { generated_central_credentials: centralResult.generatedCentralCredentials }
        : {}),
      message: 'Location created successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Create location error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while creating the location.',
    });
  }
};

exports.getLocations = async (req, res) => {
  try {
    const semester = asTrimmedString(req.query.semester);
    const scope = asTrimmedString(req.query.scope);
    const filter = {};
    if (semester) filter.semester = semester;

    const allowEnrollable = req.user.role === 'course_instructor' && scope === 'enrollable';
    if (req.user.role !== 'admin' && !allowEnrollable) {
      const courseIds = await getAccessibleCourseIds(req.user);
      const [linkedIds, courses] = await Promise.all([
        CourseLocation.find({ course_id: { $in: courseIds }, status: 'active' }).distinct('location_id'),
        Course.find({ _id: { $in: courseIds } }).select('enrolled_locations').lean(),
      ]);
      const uniqueLocationIds = [...new Set([
        ...linkedIds.map((id) => String(id)),
        ...courses.flatMap((course) => (course.enrolled_locations || []).map((id) => String(id))),
      ])];
      if (req.user.role === 'course_instructor') {
        filter.$or = [
          { _id: { $in: uniqueLocationIds } },
          { created_by: req.user.id },
        ];
      } else {
        filter._id = { $in: uniqueLocationIds };
      }
    }

    const locations = await Location.find(filter)
      .populate('central_preceptor_id', CENTRAL_PRECEPTOR_SELECT)
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: locations,
      message: 'Locations fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get locations error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching locations.',
    });
  }
};

exports.getLocationById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid location id.',
      });
    }

    const location = await Location.findById(id)
      .populate('central_preceptor_id', CENTRAL_PRECEPTOR_SELECT)
      .lean();
    if (!location) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Location not found.',
      });
    }

    if (!(await canAccessLocation(req.user, location))) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'คุณไม่มีสิทธิ์เข้าถึงสถานที่นี้',
      });
    }

    return res.status(200).json({
      success: true,
      data: location,
      message: 'Location fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get location by id error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching the location.',
    });
  }
};

exports.updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid location id.',
      });
    }

    const location = await Location.findById(id);
    if (!location) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Location not found.',
      });
    }

    if (!(await canManageLocation(req.user, location))) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'คุณไม่มีสิทธิ์แก้ไขสถานที่นี้',
      });
    }

    const prevLocation = {
      Location_name: location.Location_name,
      semester: location.semester,
      latitude: location.latitude,
      longitude: location.longitude,
      radius: location.radius,
      central_preceptor_id: location.central_preceptor_id ? String(location.central_preceptor_id) : null,
    };

    const {
      Location_name,
      semester,
      Location_image,
      latitude,
      longitude,
      radius,
      central_preceptor_id,
      central_preceptor,
      saved_verifiers,
    } = req.body || {};

    let validatedCentral;
    try {
      validatedCentral = await validateCentralPreceptorPayload({
        locationId: location._id,
        central_preceptor_id,
        central_preceptor,
        requireCentral: true,
        hasExistingCentral: Boolean(location.central_preceptor_id),
      });
    } catch (validationErr) {
      return res.status(validationErr.status || 400).json({
        success: false,
        data: null,
        message: validationErr.message,
      });
    }

    if (Location_name !== undefined) {
      const trimmedName = String(Location_name).trim();
      if (!trimmedName) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'Location_name cannot be empty.',
        });
      }
      const duplicate = await Location.findOne({
        Location_name: trimmedName,
        _id: { $ne: id },
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          data: null,
          message: 'Location with this name already exists.',
        });
      }
      location.Location_name = trimmedName;
    }

    if (semester !== undefined && semester !== location.semester) {
      const Shift = mongoose.model('Shift');
      const hasShifts = await Shift.exists({ location_id: id });

      if (hasShifts) {
        return res.status(400).json({
          success: false,
          message: 'ไม่สามารถแก้ไขเทอมของสถานที่ได้ เนื่องจากมีประวัติการลงเวลาแล้ว',
        });
      }
      location.semester = semester;
    }
    if (Location_image !== undefined) location.Location_image = Location_image;
    if (latitude !== undefined) location.latitude = latitude;
    if (longitude !== undefined) location.longitude = longitude;
    if (radius !== undefined) location.radius = radius;

    if (saved_verifiers !== undefined) {
      const cleanedVerifiers = sanitizeSavedVerifiersInput(saved_verifiers, req.user.id);
      if (cleanedVerifiers !== null) {
        location.saved_verifiers = cleanedVerifiers;
      }
    }

    await location.save();

    const transferResult = await applyCentralPreceptorAction({
      location,
      actorId: req.user.id,
      validated: validatedCentral,
    });
    const transferredShifts = transferResult?.transferredShifts || 0;
    const transferredCases = transferResult?.transferredCases || 0;

    const populated = await Location.findById(location._id)
      .populate('central_preceptor_id', CENTRAL_PRECEPTOR_SELECT)
      .lean();

    const locChanges = [];
    if (Location_name !== undefined && String(Location_name).trim() !== prevLocation.Location_name) {
      locChanges.push(`เปลี่ยนชื่อจาก "${prevLocation.Location_name}" เป็น "${String(Location_name).trim()}"`);
    }
    if (semester !== undefined && semester !== prevLocation.semester) {
      locChanges.push(`เปลี่ยนเทอมเป็น ${semester || '-'}`);
    }
    if (
      (latitude !== undefined && Number(latitude) !== Number(prevLocation.latitude)) ||
      (longitude !== undefined && Number(longitude) !== Number(prevLocation.longitude)) ||
      (radius !== undefined && Number(radius) !== Number(prevLocation.radius))
    ) {
      locChanges.push('อัปเดตพิกัด/รัศมี');
    }
    const nextCentralId = location.central_preceptor_id ? String(location.central_preceptor_id) : null;
    if (nextCentralId !== prevLocation.central_preceptor_id) {
      const transferNote = (transferredShifts > 0 || transferredCases > 0)
        ? ` และโอนงานค้างตรวจ (เวร ${transferredShifts}, เคส ${transferredCases})`
        : '';
      locChanges.push((nextCentralId ? 'ตั้งค่าบัญชีกลางประจำสถานที่' : 'ยกเลิกบัญชีกลางประจำสถานที่') + transferNote);
    }
    const locSummary = locChanges.length > 0 ? ` (${locChanges.join(', ')})` : ' (แก้ไขข้อมูลทั่วไป)';
    const actorLabel = await getActorLabel(req.user.id);
    await notifyAdmins({
      senderId: req.user.id,
      type: 'admin_location_alert',
      severity: 'info',
      sendPush: false,
      actionUrl: '/admin/locations',
      message: `${actorLabel} แก้ไขสถานที่ "${location.Location_name}"${locSummary}`,
    });

    if (nextCentralId && (transferredShifts > 0 || transferredCases > 0)) {
      await createNotification({
        recipient_id: nextCentralId,
        sender_id: req.user.id,
        type: 'course_membership_changed',
        severity: 'info',
        sendPush: true,
        action_url: transferredCases > 0 ? '/evaluate-procedures' : '/verify-shifts',
        message: `คุณได้รับโอนงานค้างตรวจของสถานที่ "${location.Location_name}" จำนวน ${transferredCases} เคส และ ${transferredShifts} เวร`,
      });
    }

    const generatedCentralCredentials = transferResult?.generatedCentralCredentials || null;

    invalidateDashboardCache();
    return res.status(200).json({
      success: true,
      data: populated || location,
      transferred: { shifts: transferredShifts, cases: transferredCases },
      ...(generatedCentralCredentials ? { generated_central_credentials: generatedCentralCredentials } : {}),
      message: (transferredShifts > 0 || transferredCases > 0)
        ? `อัปเดตสถานที่สำเร็จ และโอนย้ายงานค้างตรวจ (เวร ${transferredShifts}, เคส ${transferredCases}) ไปยังบัญชีกลางใหม่แล้ว`
        : 'Location updated successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Update location error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while updating the location.',
    });
  }
};

exports.deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid location id.',
      });
    }

    // Dependency Check: Prevent deleting location if linked to data
    const Shift = mongoose.model('Shift');
    const hasShifts = await Shift.exists({ location_id: id });

    if (hasShifts) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลบสถานที่นี้ได้ เนื่องจากมีประวัติการลงเวลาของนักศึกษา กรุณาย้ายข้อมูลที่เกี่ยวข้องก่อนทำการลบ',
      });
    }

    const deleted = await Location.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Location not found.',
      });
    }
    invalidateDashboardCache();

    if (deleted.central_preceptor_id) {
      const stillUsed = await Location.exists({ central_preceptor_id: deleted.central_preceptor_id });
      if (!stillUsed) {
        await User.updateOne(
          { _id: deleted.central_preceptor_id },
          { $set: { shared_location_id: null, is_shared_account: false } }
        );
      }
    }

    const actorLabel = await getActorLabel(req.user.id);
    await notifyAdmins({
      senderId: req.user.id,
      type: 'admin_location_alert',
      severity: 'danger',
      sendPush: true,
      actionUrl: '/admin/locations',
      message: `${actorLabel} ลบสถานที่ปฏิบัติงาน "${deleted.Location_name}"`,
    });

    return res.status(200).json({
      success: true,
      data: null,
      message: 'Location deleted successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Delete location error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while deleting the location.',
    });
  }
};
