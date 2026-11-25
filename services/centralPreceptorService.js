const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Location = require('../models/Location');
const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const CourseLocation = require('../models/CourseLocation');
const Shift = require('../models/Shift');
const LogbookCase = require('../models/LogbookCase');
const {
  asString,
  asTrimmedString,
  validatePassword,
  resolveInitialPassword,
} = require('../middlewares/securityMiddleware');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeVerifierText = (value) =>
  String(value || '').trim().replace(/\s+/g, ' ');

const sanitizeSavedVerifiersInput = (rawList, actorId) => {
  if (!Array.isArray(rawList)) return null;
  const seen = new Set();
  const cleaned = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const name = normalizeVerifierText(item.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = {
      name,
      position: normalizeVerifierText(item.position),
      phone: normalizeVerifierText(item.phone),
      is_active: item.is_active !== false,
      created_by: item.created_by && mongoose.Types.ObjectId.isValid(item.created_by)
        ? item.created_by
        : actorId || null,
      created_at: item.created_at ? new Date(item.created_at) : new Date(),
    };
    if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
      entry._id = item._id;
    }
    cleaned.push(entry);
  }

  return cleaned;
};

const upsertLocationVerifier = async (locationDoc, { name, position = '', phone = '', createdBy = null }) => {
  const normalizedName = normalizeVerifierText(name);
  if (!locationDoc || !normalizedName) return null;

  const normalizedPos = normalizeVerifierText(position);
  const normalizedPhone = normalizeVerifierText(phone);
  const key = normalizedName.toLowerCase();

  if (!Array.isArray(locationDoc.saved_verifiers)) {
    locationDoc.saved_verifiers = [];
  }

  const existing = locationDoc.saved_verifiers.find(
    (entry) => normalizeVerifierText(entry.name).toLowerCase() === key
  );

  if (existing) {
    existing.is_active = true;
    if (!existing.position && normalizedPos) existing.position = normalizedPos;
    if (!existing.phone && normalizedPhone) existing.phone = normalizedPhone;
  } else {
    locationDoc.saved_verifiers.push({
      name: normalizedName,
      position: normalizedPos,
      phone: normalizedPhone,
      is_active: true,
      created_by: createdBy || null,
      created_at: new Date(),
    });
  }

  await locationDoc.save();
  return locationDoc.saved_verifiers.find(
    (entry) => normalizeVerifierText(entry.name).toLowerCase() === key
  );
};

const syncCentralPreceptorForLocationCourses = async (locationId, centralPreceptorId, actorId) => {
  if (!locationId || !centralPreceptorId) return;

  const [linkedCourseIds, legacyCourses] = await Promise.all([
    CourseLocation.find({ location_id: locationId, status: 'active' }).distinct('course_id'),
    Course.find({ enrolled_locations: locationId }).distinct('_id'),
  ]);

  const courseIds = [...new Set([
    ...linkedCourseIds.map((id) => String(id)),
    ...legacyCourses.map((id) => String(id)),
  ])];

  if (courseIds.length === 0) return;

  await Promise.all(
    courseIds.map((courseId) =>
      CourseAssignment.findOneAndUpdate(
        { course_id: courseId, user_id: centralPreceptorId, assignment_role: 'preceptor' },
        { $set: { status: 'active', revoked_at: null, assigned_by: actorId || null, assigned_at: new Date() } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      )
    )
  );
};

const syncCentralPreceptorsForCourse = async (courseId, locationIds, actorId) => {
  if (!courseId || !Array.isArray(locationIds) || locationIds.length === 0) return;

  const locations = await Location.find({
    _id: { $in: locationIds },
    central_preceptor_id: { $ne: null },
  })
    .select('central_preceptor_id')
    .lean();

  const preceptorIds = [...new Set(
    locations.map((loc) => String(loc.central_preceptor_id || '')).filter(Boolean)
  )];

  if (preceptorIds.length === 0) return;

  await Promise.all(
    preceptorIds.map((userId) =>
      CourseAssignment.findOneAndUpdate(
        { course_id: courseId, user_id: userId, assignment_role: 'preceptor' },
        { $set: { status: 'active', revoked_at: null, assigned_by: actorId || null, assigned_at: new Date() } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      )
    )
  );
};

const makeHttpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const validateCentralPreceptorPayload = async ({
  locationId = null,
  central_preceptor_id,
  central_preceptor,
  requireCentral = false,
  hasExistingCentral = false,
}) => {
  if (central_preceptor && central_preceptor.mode === 'create') {
    const firstname_lastname = asTrimmedString(central_preceptor.firstname_lastname);
    const email = asTrimmedString(central_preceptor.email).toLowerCase();
    const rawPassword = central_preceptor.password !== undefined && central_preceptor.password !== null
      ? asString(central_preceptor.password)
      : '';

    if (!firstname_lastname || !email) {
      throw makeHttpError(400, 'กรุณาระบุชื่อบัญชีกลางและอีเมลให้ครบถ้วน');
    }
    if (!EMAIL_REGEX.test(email)) {
      throw makeHttpError(400, 'รูปแบบอีเมลของบัญชีกลางไม่ถูกต้อง');
    }
    if (rawPassword !== '') {
      const passwordError = validatePassword(rawPassword, { email });
      if (passwordError) {
        throw makeHttpError(400, passwordError);
      }
    }
    const existing = await User.exists({ email });
    if (existing) {
      throw makeHttpError(409, 'อีเมลนี้มีบัญชีอยู่ในระบบแล้ว กรุณาเลือกผูกบัญชีที่มีอยู่หรือใช้อีเมลอื่น');
    }
    return { action: 'create', payload: { ...central_preceptor, firstname_lastname, email, password: rawPassword } };
  }

  if (central_preceptor_id === undefined) {
    if (requireCentral && !hasExistingCentral) {
      throw makeHttpError(400, 'กรุณาสร้างหรือผูกบัญชีกลางประจำสถานที่ (1 สถานที่ต้องมี 1 บัญชีกลาง)');
    }
    return { action: 'none' };
  }

  if (central_preceptor_id === null || central_preceptor_id === '') {
    if (requireCentral) {
      throw makeHttpError(400, 'ทุกสถานที่ต้องมีบัญชีกลางประจำสถานที่ (1 สถานที่ต้องมี 1 บัญชีกลาง)');
    }
    return { action: 'unlink' };
  }

  if (!mongoose.Types.ObjectId.isValid(central_preceptor_id)) {
    throw makeHttpError(400, 'รหัสบัญชีกลางไม่ถูกต้อง');
  }

  const preceptor = await User.findById(central_preceptor_id).select('role academic_status').lean();
  if (!preceptor) {
    throw makeHttpError(404, 'ไม่พบบัญชีอาจารย์พี่เลี้ยงที่เลือก');
  }
  if (preceptor.role !== 'preceptor') {
    throw makeHttpError(400, 'บัญชีกลางประจำสถานที่ต้องมีบทบาทเป็นอาจารย์พี่เลี้ยง (preceptor) เท่านั้น');
  }
  if (preceptor.academic_status !== 'active') {
    throw makeHttpError(400, 'บัญชีกลางที่เลือกต้องมีสถานะใช้งานอยู่ (active)');
  }

  const conflictQuery = { central_preceptor_id };
  if (locationId) conflictQuery._id = { $ne: locationId };
  const conflictLocation = await Location.findOne(conflictQuery).select('Location_name').lean();
  if (conflictLocation) {
    throw makeHttpError(
      409,
      `บัญชีนี้ถูกผูกเป็นบัญชีกลางของ "${conflictLocation.Location_name}" อยู่แล้ว (กำหนดได้ 1 สถานที่ต่อ 1 บัญชี)`
    );
  }

  return { action: 'link', preceptorId: central_preceptor_id };
};

const clearPreviousSharedLocationIfUnused = async (prevUserId, excludeLocationId) => {
  if (!prevUserId) return;
  const stillUsed = await Location.exists({
    _id: { $ne: excludeLocationId },
    central_preceptor_id: prevUserId,
  });
  if (!stillUsed) {
    await User.updateOne(
      { _id: prevUserId },
      { $set: { shared_location_id: null, is_shared_account: false } }
    );
  }
};

const transferPendingCentralWork = async ({ locationId, fromPreceptorId, toPreceptorId }) => {
  if (!locationId || !fromPreceptorId || !toPreceptorId || String(fromPreceptorId) === String(toPreceptorId)) {
    return { transferredShifts: 0, transferredCases: 0 };
  }

  const [shiftRes, caseRes] = await Promise.all([
    Shift.updateMany(
      {
        location_id: locationId,
        preceptor_id: fromPreceptorId,
        verify_status: 'pending',
      },
      { $set: { preceptor_id: toPreceptorId } }
    ),
    LogbookCase.updateMany(
      {
        location_id: locationId,
        preceptor_id: fromPreceptorId,
        evaluation_status: 'pending',
      },
      { $set: { preceptor_id: toPreceptorId } }
    ),
  ]);

  return {
    transferredShifts: Number(shiftRes?.modifiedCount || 0),
    transferredCases: Number(caseRes?.modifiedCount || 0),
  };
};

const applyCentralPreceptorAction = async ({ location, actorId, validated }) => {
  if (!validated || validated.action === 'none') {
    return { transferredShifts: 0, transferredCases: 0, generatedCentralCredentials: null };
  }

  const prevPreceptorId = location.central_preceptor_id ? String(location.central_preceptor_id) : null;

  if (validated.action === 'unlink') {
    location.central_preceptor_id = null;
    await location.save();
    if (prevPreceptorId) {
      await clearPreviousSharedLocationIfUnused(prevPreceptorId, location._id);
    }
    return { transferredShifts: 0, transferredCases: 0, generatedCentralCredentials: null };
  }

  let nextPreceptorId = null;
  let generatedCentralCredentials = null;

  if (validated.action === 'create') {
    const { firstname_lastname, email, phone_number, password } = validated.payload;
    const resolved = resolveInitialPassword(password, { email });
    if (resolved.error) {
      throw makeHttpError(400, resolved.error);
    }
    const hashedPassword = await bcrypt.hash(resolved.password, 10);
    const createdUser = await User.create({
      email,
      password: hashedPassword,
      role: 'preceptor',
      firstname_lastname,
      phone_number: asTrimmedString(phone_number),
      semester: location.semester || undefined,
      academic_status: 'active',
      is_shared_account: true,
      must_change_password: false,
      shared_location_id: location._id,
      created_by: actorId,
    });
    nextPreceptorId = createdUser._id;
    if (resolved.isAutoGenerated) {
      generatedCentralCredentials = {
        email,
        firstname_lastname,
        temporary_password: resolved.password,
      };
    }
  } else if (validated.action === 'link') {
    nextPreceptorId = validated.preceptorId;
    await User.updateOne(
      { _id: nextPreceptorId },
      { $set: { is_shared_account: true, must_change_password: false, shared_location_id: location._id } }
    );
  }

  location.central_preceptor_id = nextPreceptorId;
  await location.save();

  let transferResult = { transferredShifts: 0, transferredCases: 0 };
  if (prevPreceptorId && prevPreceptorId !== String(nextPreceptorId)) {
    await clearPreviousSharedLocationIfUnused(prevPreceptorId, location._id);
    transferResult = await transferPendingCentralWork({
      locationId: location._id,
      fromPreceptorId: prevPreceptorId,
      toPreceptorId: nextPreceptorId,
    });
  }

  await syncCentralPreceptorForLocationCourses(location._id, nextPreceptorId, actorId);
  return {
    ...transferResult,
    generatedCentralCredentials,
  };
};

module.exports = {
  normalizeVerifierText,
  sanitizeSavedVerifiersInput,
  upsertLocationVerifier,
  syncCentralPreceptorForLocationCourses,
  syncCentralPreceptorsForCourse,
  validateCentralPreceptorPayload,
  transferPendingCentralWork,
  applyCentralPreceptorAction,
};
