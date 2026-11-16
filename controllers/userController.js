const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Course = require('../models/Course');
const CourseAssignment = require('../models/CourseAssignment');
const LogbookCase = require('../models/LogbookCase');
const Shift = require('../models/Shift');
const { getAccessibleCourseIds, canManageCourse } = require('../services/courseAccessService');
const { buildUserImportTemplateWorkbook } = require('../services/userImportTemplateService');
const { JWT_SECRET } = require('../config/environment');
const {
  asString,
  asTrimmedString,
  isValidImageUrlOrPath,
  validatePassword,
  hasDangerousFormulaPrefix,
} = require('../middlewares/securityMiddleware');
const bcrypt = require('bcryptjs');

const DEFAULT_USER_PASSWORD =
  process.env.DEFAULT_USER_PASSWORD || 'password123';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const MAX_IMPORT_ROWS = 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = new Set(['student', 'preceptor', 'course_instructor', 'admin']);

const canManageTargetUser = async (actor, targetUser) => {
  if (actor.role === 'admin') return true;
  if (actor.role !== 'course_instructor') return false;
  if (!['student', 'preceptor'].includes(targetUser.role)) return false;
  if (targetUser.created_by && String(targetUser.created_by) === String(actor.id)) return true;

  const courseIds = await getAccessibleCourseIds(actor, ['course_instructor']);
  if (!courseIds || courseIds.length === 0) return false;

  return Boolean(
    await CourseAssignment.exists({
      course_id: { $in: courseIds },
      user_id: targetUser._id,
      assignment_role: { $in: ['student', 'preceptor'] },
      status: 'active',
    })
  );
};

const safeUser = (userDoc) => {
  if (!userDoc) return null;

  const obj = userDoc.toObject ? userDoc.toObject() : userDoc;
  // Ensure password is never returned
  delete obj.password;
  return obj;
};

exports.createUsersBulk = async (req, res) => {
  try {
    const { users } = req.body || {};

    if (!users || !Array.isArray(users) || users.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาส่งข้อมูลผู้ใช้งานเป็นอาร์เรย์ (Array)',
      });
    }

    if (users.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({
        success: false,
        message: `สามารถนำเข้าข้อมูลได้สูงสุดครั้งละ ${MAX_IMPORT_ROWS} รายการ`,
      });
    }

    const salt = await bcrypt.genSalt(10);
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    const creationPromises = users.map(async (userData, index) => {
      try {
        if (!userData || typeof userData !== 'object') {
          throw new Error('รูปแบบข้อมูลผู้ใช้ไม่ถูกต้อง');
        }
        const email = asTrimmedString(userData.email).toLowerCase();
        const role = asTrimmedString(userData.role).toLowerCase();
        const firstname_lastname = asTrimmedString(userData.firstname_lastname);
        const phone_number = asTrimmedString(userData.phone_number);
        const student_id = asTrimmedString(userData.student_id);
        const semester = asTrimmedString(userData.semester);
        const year = userData.year;
        const password = userData.password !== undefined ? asString(userData.password) : '';

        if (!email || !role || !firstname_lastname) {
          throw new Error('ขาดข้อมูลสำคัญ (email, role, name)');
        }
        if (!EMAIL_REGEX.test(email)) {
          throw new Error(`รูปแบบอีเมลไม่ถูกต้อง: ${email}`);
        }
        if (hasDangerousFormulaPrefix(firstname_lastname) || hasDangerousFormulaPrefix(student_id) || hasDangerousFormulaPrefix(semester)) {
          throw new Error('ข้อมูลมีอักขระขึ้นต้นที่ไม่อนุญาต (=, +, -, @)');
        }
        if (!ALLOWED_ROLES.has(role)) {
          throw new Error(`บทบาทไม่ถูกต้อง: ${role}`);
        }
        if (password) {
          const passwordError = validatePassword(password);
          if (passwordError) throw new Error(passwordError);
        }

        const hashedPassword = await bcrypt.hash(password || DEFAULT_USER_PASSWORD, salt);

        await User.create({
          email,
          password: hashedPassword,
          role,
          firstname_lastname,
          phone_number,
          student_id: role === 'student' ? student_id : undefined,
          year: role === 'student' ? year : undefined,
          semester,
          academic_status: 'active',
          created_by: req.user.id,
        });

        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push({
          index,
          email: userData.email || 'Unknown',
          message: err.code === 11000 ? 'อีเมลนี้มีอยู่ในระบบแล้ว' : err.message
        });
      }
    });

    await Promise.all(creationPromises);

    return res.status(200).json({
      success: true,
      data: results,
      message: `สำเร็จ ${results.success} รายการ, ล้มเหลว ${results.failed} รายการ`
    });
  } catch (err) {
    console.error('Bulk create error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการนำเข้าข้อมูล' });
  }
};

const csv = require('csv-parser');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const stripBom = require('strip-bom-stream');

const cleanupTempFile = (filePath) => {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (unlinkErr) {
    console.error('Temp file cleanup error:', unlinkErr);
  }
};

const extractExcelCellValue = (cell) => {
  let raw = cell?.value;
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object' && !(raw instanceof Date)) {
    if ('result' in raw) {
      raw = raw.result;
    } else if (Array.isArray(raw.richText)) {
      return raw.richText.map((part) => part.text || '').join('');
    } else if ('text' in raw) {
      return String(raw.text || '');
    }
  }
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) {
    const month = raw.getUTCMonth() + 1;
    const year = raw.getUTCFullYear();
    return year >= 2500 ? `${month}/${year}` : (cell.text || `${month}/${year}`);
  }
  return String(raw);
};

const detectUploadKind = (filePath, originalName) => {
  const ext = path.extname(originalName || '').toLowerCase();
  if (!['.xlsx', '.csv'].includes(ext)) {
    return 'unsupported';
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const headerBuf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, headerBuf, 0, 4, 0);
    if (bytesRead >= 4) {
      if (headerBuf[0] === 0x50 && headerBuf[1] === 0x4b && headerBuf[2] === 0x03 && headerBuf[3] === 0x04) {
        return ext === '.xlsx' ? 'xlsx' : 'unsupported';
      }
      if (headerBuf[0] === 0xd0 && headerBuf[1] === 0xcf && headerBuf[2] === 0x11 && headerBuf[3] === 0xe0) {
        return 'legacy-xls';
      }
      // Reject common disguised binary headers (PDF, PE/MZ, ELF)
      if (
        (headerBuf[0] === 0x25 && headerBuf[1] === 0x50 && headerBuf[2] === 0x44 && headerBuf[3] === 0x46) ||
        (headerBuf[0] === 0x4d && headerBuf[1] === 0x5a) ||
        (headerBuf[0] === 0x7f && headerBuf[1] === 0x45 && headerBuf[2] === 0x4c && headerBuf[3] === 0x46)
      ) {
        return 'unsupported';
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return ext === '.xlsx' ? 'xlsx' : 'csv';
};

const parseUploadedUsers = async (filePath, originalName) => {
  const kind = detectUploadKind(filePath, originalName);
  if (kind === 'legacy-xls') {
    throw new Error('รองรับเฉพาะไฟล์ .xlsx หรือ .csv กรุณาบันทึกไฟล์เป็น .xlsx');
  }
  if (kind === 'unsupported') {
    throw new Error('ชนิดไฟล์ไม่ถูกต้อง รองรับเฉพาะไฟล์ .xlsx หรือ .csv เท่านั้น');
  }

  if (kind === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];
    if (!worksheet || worksheet.rowCount < 2) return [];
    if (worksheet.rowCount > MAX_IMPORT_ROWS + 1) {
      throw new Error(`ไฟล์มีจำนวนแถวเกินกำหนด (สูงสุด ${MAX_IMPORT_ROWS} รายการต่อไฟล์)`);
    }

    const headerRow = worksheet.getRow(1);
    const headerMap = new Map();
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const title = extractExcelCellValue(cell).trim();
      if (title) headerMap.set(colNumber, title);
    });

    const parsedRows = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const rowData = { _excelRowNumber: rowNumber };
      let hasAnyValue = false;

      headerMap.forEach((headerName, colNumber) => {
        const val = extractExcelCellValue(row.getCell(colNumber));
        rowData[headerName] = val;
        if (String(val).trim() !== '') {
          hasAnyValue = true;
        }
      });

      if (hasAnyValue) {
        parsedRows.push(rowData);
      }
    }
    return parsedRows;
  }

  return new Promise((resolve, reject) => {
    const csvRows = [];
    let aborted = false;
    let stream = fs.createReadStream(filePath);
    const rawStream = stream;
    if (typeof stripBom === 'function') {
      stream = stream.pipe(stripBom());
    }
    stream
      .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
      .on('error', (err) => {
        if (!aborted) reject(err);
      })
      .on('data', (data) => {
        if (aborted) return;
        const hasAnyValue = Object.values(data).some((v) => String(v || '').trim() !== '');
        if (hasAnyValue) {
          if (csvRows.length >= MAX_IMPORT_ROWS) {
            aborted = true;
            rawStream.destroy();
            reject(new Error(`ไฟล์มีจำนวนแถวเกินกำหนด (สูงสุด ${MAX_IMPORT_ROWS} รายการต่อไฟล์)`));
            return;
          }
          csvRows.push({ ...data, _excelRowNumber: csvRows.length + 2 });
        }
      })
      .on('end', () => {
        if (!aborted) resolve(csvRows);
      });
  });
};

exports.downloadImportTemplate = async (req, res) => {
  try {
    const workbook = buildUserImportTemplateWorkbook();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="user_import_template.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('Download import template error:', err);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถสร้างไฟล์เทมเพลต Excel ได้',
    });
  }
};

exports.importUsersCSV = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'กรุณาอัปโหลดไฟล์ Excel (.xlsx) หรือ CSV (.csv)' });
  }

  try {
    const requestedCourseId = asTrimmedString(req.body?.course_id);
    if (requestedCourseId) {
      if (!mongoose.Types.ObjectId.isValid(requestedCourseId)) {
        return res.status(400).json({ success: false, message: 'รหัสรายวิชาไม่ถูกต้อง' });
      }
      const courseExists = await Course.exists({ _id: requestedCourseId });
      if (!courseExists) {
        return res.status(404).json({ success: false, message: 'ไม่พบรายวิชาที่เลือก' });
      }
      if (!(await canManageCourse(req.user, requestedCourseId))) {
        return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์นำเข้าบัญชีเข้ารายวิชานี้' });
      }
    }

    const results = {
      created: 0,
      updated: 0,
      failed: 0,
      errors: []
    };

    let usersToProcess = [];
    try {
      usersToProcess = await parseUploadedUsers(req.file.path, req.file.originalname);
    } catch (err) {
      return res.status(400).json({ success: false, message: `ไม่สามารถอ่านไฟล์ได้: ${err.message}` });
    }

    const salt = await bcrypt.genSalt(10);
    let enrolledStudentInCourse = false;

    for (let i = 0; i < usersToProcess.length; i++) {
      const row = usersToProcess[i];
      try {
        const getVal = (...keys) => {
          for (const key of keys) {
            if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
              return String(row[key]);
            }
          }
          return '';
        };

        const firstname_lastname = getVal('ชื่อ-นามสกุล', 'firstname_lastname').trim();
        const email = getVal('อีเมล', 'email').toLowerCase().trim();
        const phone_number = getVal('เบอร์โทรศัพท์', 'phone_number').trim();
        const roleRaw = getVal(
          'บทบาท (student/preceptor/course_instructor/admin)',
          'บทบาท (student/preceptor/admin)',
          'บทบาท (student/preceptor)',
          'บทบาท',
          'role'
        ).toLowerCase().trim();
        const student_id = getVal('รหัสนักศึกษา', 'รหัสนิสิต', 'student_id').trim();
        const yearRaw = getVal('ชั้นปี', 'year').trim();
        const semester = getVal('เทอม (เช่น 1/2569)', 'เทอม', 'semester').trim();
        const password = getVal('รหัสผ่าน', 'password').trim();

        let role = '';
        if (roleRaw.includes('student') || roleRaw.includes('นักศึกษา') || roleRaw.includes('นิสิต')) role = 'student';
        else if (roleRaw.includes('preceptor') || roleRaw.includes('พี่เลี้ยง')) role = 'preceptor';
        else if (roleRaw.includes('course_instructor') || roleRaw.includes('instructor')) role = 'course_instructor';
        else if (roleRaw.includes('admin')) role = 'admin';

        if (!email || !role || !firstname_lastname) {
          throw new Error(`ขาดข้อมูลสำคัญ (อีเมล: ${email || 'ว่าง'}, บทบาท: ${role || 'ว่าง'}, ชื่อ: ${firstname_lastname || 'ว่าง'})`);
        }

        if (!EMAIL_REGEX.test(email)) {
          throw new Error(`รูปแบบอีเมลไม่ถูกต้อง: ${email}`);
        }

        if (
          hasDangerousFormulaPrefix(firstname_lastname) ||
          hasDangerousFormulaPrefix(student_id) ||
          hasDangerousFormulaPrefix(semester) ||
          hasDangerousFormulaPrefix(email)
        ) {
          throw new Error('ข้อมูลมีอักขระขึ้นต้นที่ไม่อนุญาต (=, +, -, @)');
        }

        if (!['student', 'preceptor'].includes(role)) {
          throw new Error(
            role
              ? 'การนำเข้าผ่าน Excel/CSV รองรับเฉพาะบทบาท student หรือ preceptor เท่านั้น (ไม่สามารถนำเข้าอาจารย์ประจำวิชาหรือแอดมินได้)'
              : `บทบาทไม่ถูกต้อง: ${roleRaw || 'ว่าง'}`
          );
        }

        if (role === 'student' && !student_id) {
          throw new Error('กรุณาระบุรหัสนักศึกษาสำหรับบทบาท student');
        }

        if (password) {
          const passwordError = validatePassword(password);
          if (passwordError) {
            throw new Error(passwordError);
          }
        }

        let parsedYear;
        if (role === 'student' && yearRaw !== '') {
          const numericYear = Number(yearRaw);
          if (!Number.isFinite(numericYear) || numericYear < 1) {
            throw new Error(`ชั้นปีไม่ถูกต้อง: ${yearRaw}`);
          }
          parsedYear = numericYear;
        }

        const userData = {
          email,
          role,
          firstname_lastname,
          phone_number,
          student_id: role === 'student' ? student_id : undefined,
          year: role === 'student' ? parsedYear : undefined,
          semester,
          academic_status: 'active'
        };

        let targetUserDoc = null;
        const existingUser = await User.findOne({ email });
        if (existingUser) {
          if (existingUser.role !== role) {
            throw new Error(`อีเมลนี้เป็นบทบาท ${existingUser.role} และไม่สามารถเปลี่ยนบทบาทได้`);
          }
          const canEditExisting = await canManageTargetUser(req.user, existingUser);
          if (!canEditExisting && !requestedCourseId) {
            throw new Error('อีเมลนี้มีบัญชีอยู่แล้วในระบบและไม่อยู่ในความดูแลของคุณ');
          }
          if (canEditExisting) {
            const updateOps = { $set: userData };
            if (password) {
              userData.password = await bcrypt.hash(password, salt);
              userData.failed_login_attempts = 0;
              userData.lock_until = null;
              updateOps.$inc = { token_version: 1 };
            }
            delete userData.role;
            await User.updateOne({ _id: existingUser._id }, updateOps);
          }
          targetUserDoc = existingUser;
          results.updated++;
        } else {
          userData.password = await bcrypt.hash(password || DEFAULT_USER_PASSWORD, salt);
          targetUserDoc = await User.create({ ...userData, created_by: req.user.id });
          results.created++;
        }

        if (requestedCourseId && targetUserDoc && ['student', 'preceptor'].includes(role)) {
          await CourseAssignment.findOneAndUpdate(
            { course_id: requestedCourseId, user_id: targetUserDoc._id, assignment_role: role },
            { $set: { status: 'active', revoked_at: null, assigned_by: req.user.id, assigned_at: new Date() } },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
          );
          if (role === 'student') {
            enrolledStudentInCourse = true;
            await Promise.all([
              User.updateOne({ _id: targetUserDoc._id }, { $addToSet: { enrolled_courses: requestedCourseId } }),
              Course.updateOne({ _id: requestedCourseId }, { $addToSet: { enrolled_students: targetUserDoc._id } }),
            ]);
          }
        }
      } catch (err) {
        results.failed++;
        results.errors.push({
          row: row._excelRowNumber || i + 2,
          email: row['อีเมล'] || row.email || 'ไม่ระบุ',
          message: err.message
        });
      }
    }

    if (requestedCourseId && enrolledStudentInCourse) {
      const count = await CourseAssignment.countDocuments({
        course_id: requestedCourseId,
        assignment_role: 'student',
        status: 'active',
      });
      await Course.updateOne({ _id: requestedCourseId }, { $set: { enrolled_student_count: count } });
    }

    return res.status(200).json({
      success: true,
      ...results,
      message: `นำเข้าสำเร็จ: สร้างใหม่ ${results.created} บัญชี, อัปเดต ${results.updated} บัญชี`
    });
  } finally {
    cleanupTempFile(req.file.path);
  }
};

exports.getUsers = async (req, res) => {
  try {
    const role = asTrimmedString(req.query.role);
    const filter = {};
    if (role) {
      if (!ALLOWED_ROLES.has(role)) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'บทบาทไม่ถูกต้อง',
        });
      }
      filter.role = role;
    }
    const users = await User.find(filter).select('-password');
    return res.status(200).json({
      success: true,
      data: users,
      message: 'ดึงข้อมูลผู้ใช้งานสำเร็จ',
    });
  } catch (err) {
    console.error('Get users error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลผู้ใช้งาน',
    });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, data: null, message: 'รหัสผู้ใช้งานไม่ถูกต้อง' });
    }
    const user = await User.findById(id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบผู้ใช้งาน' });
    }
    if (!(await canManageTargetUser(req.user, user))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์เข้าถึงบัญชีผู้ใช้นี้' });
    }
    return res.status(200).json({ success: true, data: user, message: 'ดึงข้อมูลผู้ใช้งานสำเร็จ' });
  } catch (err) {
    console.error('Get user by id error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลผู้ใช้งาน' });
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลโปรไฟล์' });
    }
    return res.status(200).json({ success: true, data: user, message: 'ดึงข้อมูลโปรไฟล์สำเร็จ' });
  } catch (err) {
    console.error('Get my profile error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลโปรไฟล์' });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    const body = req.body || {};
    const firstname_lastname = body.firstname_lastname !== undefined ? asTrimmedString(body.firstname_lastname) : undefined;
    const phone_number = body.phone_number !== undefined ? asTrimmedString(body.phone_number) : undefined;
    const profile_image = body.profile_image !== undefined ? asTrimmedString(body.profile_image) : undefined;
    const password = body.password !== undefined && body.password !== null && body.password !== ''
      ? asString(body.password)
      : undefined;

    if (firstname_lastname !== undefined && !firstname_lastname) {
      return res.status(400).json({ success: false, data: null, message: 'กรุณาระบุชื่อ-นามสกุล' });
    }
    if (profile_image !== undefined && !isValidImageUrlOrPath(profile_image)) {
      return res.status(400).json({ success: false, data: null, message: 'URL รูปโปรไฟล์ไม่ถูกต้อง' });
    }
    if (password !== undefined) {
      const passwordError = validatePassword(password);
      if (passwordError) {
        return res.status(400).json({ success: false, data: null, message: passwordError });
      }
    }

    const user = await User.findById(req.user.id).select('+token_version');
    if (!user) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบผู้ใช้งาน' });
    }
    if (firstname_lastname !== undefined) user.firstname_lastname = firstname_lastname;
    if (phone_number !== undefined) user.phone_number = phone_number;
    if (profile_image !== undefined) user.profile_image = profile_image;
    let passwordChanged = false;
    if (password !== undefined) {
      user.password = password;
      passwordChanged = true;
    }
    await user.save();

    const updatedUser = await User.findById(user._id).select('-password');
    const newToken = passwordChanged
      ? jwt.sign(
          { id: user._id, role: user.role, tv: user.token_version || 0 },
          JWT_SECRET,
          { expiresIn: JWT_EXPIRES_IN }
        )
      : undefined;

    return res.status(200).json({
      success: true,
      data: safeUser(updatedUser),
      ...(newToken ? { token: newToken } : {}),
      message: 'อัปเดตโปรไฟล์เรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Update my profile error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะอัปเดตโปรไฟล์' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, data: null, message: 'รหัสผู้ใช้งานไม่ถูกต้อง' });
    }
    const body = req.body || {};
    const email = body.email !== undefined ? asTrimmedString(body.email).toLowerCase() : undefined;
    const firstname_lastname = body.firstname_lastname !== undefined ? asTrimmedString(body.firstname_lastname) : undefined;
    const phone_number = body.phone_number !== undefined ? asTrimmedString(body.phone_number) : undefined;
    const profile_image = body.profile_image !== undefined ? asTrimmedString(body.profile_image) : undefined;
    const student_id = body.student_id !== undefined ? asTrimmedString(body.student_id) : undefined;
    const year = body.year;
    const semester = body.semester !== undefined ? asTrimmedString(body.semester) : undefined;
    const academic_status = body.academic_status !== undefined ? asTrimmedString(body.academic_status) : undefined;
    const password = body.password !== undefined && body.password !== null && body.password !== ''
      ? asString(body.password)
      : undefined;

    if (email !== undefined && !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ success: false, data: null, message: 'รูปแบบอีเมลไม่ถูกต้อง' });
    }
    if (profile_image !== undefined && !isValidImageUrlOrPath(profile_image)) {
      return res.status(400).json({ success: false, data: null, message: 'URL รูปโปรไฟล์ไม่ถูกต้อง' });
    }
    if (password !== undefined) {
      const passwordError = validatePassword(password);
      if (passwordError) {
        return res.status(400).json({ success: false, data: null, message: passwordError });
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'role')) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'บทบาทบัญชีเป็นค่าถาวรและไม่สามารถเปลี่ยนได้',
      });
    }
    const user = await User.findById(id).select('+token_version');
    if (!user) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบผู้ใช้งาน' });
    }
    if (!(await canManageTargetUser(req.user, user))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์แก้ไขบัญชีผู้ใช้นี้' });
    }
    const nextRole = user.role;
    const allowedAcademicStatuses = ['active', 'graduated', 'inactive'];

    if (user.role === 'admin' && academic_status === 'inactive') {
      const activeAdminsCount = await User.countDocuments({ role: 'admin', academic_status: 'active' });
      if (activeAdminsCount <= 1 && user.academic_status === 'active') {
         return res.status(400).json({ success: false, message: 'ไม่สามารถปิดการใช้งานแอดมินคนสุดท้ายของระบบได้' });
      }
    }

    if (academic_status !== undefined && !allowedAcademicStatuses.includes(academic_status)) {
      return res.status(400).json({ success: false, data: null, message: "สถานะต้องเป็น 'active', 'graduated' หรือ 'inactive'" });
    }

    const effectiveStudentId = student_id !== undefined ? student_id : user.student_id;
    if (nextRole === 'student' && (!effectiveStudentId || effectiveStudentId === '')) {
      return res.status(400).json({ success: false, data: null, message: 'กรุณาระบุรหัสนักศึกษาสำหรับบทบาทนักศึกษา' });
    }

    if (email !== undefined) user.email = email;
    if (firstname_lastname !== undefined) user.firstname_lastname = firstname_lastname;
    if (phone_number !== undefined) user.phone_number = phone_number;
    if (profile_image !== undefined) user.profile_image = profile_image;

    if (nextRole === 'student') {
      if (student_id !== undefined) user.student_id = student_id;
      if (year !== undefined) user.year = year;
    } else if (nextRole === 'preceptor') {
      user.student_id = undefined;
      user.year = undefined;
    }

    if (semester !== undefined) user.semester = semester;
    if (academic_status !== undefined) user.academic_status = academic_status;
    if (password !== undefined && password !== null && password !== '') user.password = password;

    await user.save();
    const updatedUser = await User.findById(user._id).select('-password');
    return res.status(200).json({ success: true, data: safeUser(updatedUser), message: 'อัปเดตข้อมูลผู้ใช้งานเรียบร้อยแล้ว' });
  } catch (err) {
    console.error('Update user error:', err);
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, data: null, message: 'อีเมลนี้มีอยู่ในระบบแล้ว' });
    }
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะอัปเดตข้อมูลผู้ใช้งาน' });
  }
};

exports.getPreceptors = async (req, res) => {
  try {
    const semester = asTrimmedString(req.query.semester);
    const filter = { role: 'preceptor' };
    if (semester) filter.semester = semester;
    
    const preceptors = await User.find(filter).select('-password');
    
    return res.status(200).json({ success: true, data: preceptors, message: 'ดึงข้อมูลอาจารย์พี่เลี้ยงสำเร็จ' });
  } catch (err) {
    console.error('Get preceptors error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลอาจารย์พี่เลี้ยง' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'รหัสผู้ใช้งานไม่ถูกต้อง' });
    }
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });

    if (!(await canManageTargetUser(req.user, user))) {
      return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบบัญชีผู้ใช้นี้' });
    }

    // Safeguard: Prevent deleting the last active admin
    if (user.role === 'admin' && user.academic_status === 'active') {
      const activeAdminsCount = await User.countDocuments({ role: 'admin', academic_status: 'active' });
      if (activeAdminsCount <= 1) {
        return res.status(400).json({ success: false, message: 'ไม่สามารถลบแอดมินคนสุดท้ายของระบบได้' });
      }
    }

    if (req.user.role === 'course_instructor') {
      const actorCourseIds = await getAccessibleCourseIds(req.user, ['course_instructor']);
      const inOtherCourse = await CourseAssignment.exists({
        user_id: id,
        ...(actorCourseIds.length > 0 ? { course_id: { $nin: actorCourseIds } } : {}),
        status: 'active',
      });
      if (inOtherCourse) {
        return res.status(400).json({
          success: false,
          message: 'ไม่สามารถลบบัญชีถาวรได้ เนื่องจากผู้ใช้นี้ยังอยู่ในรายวิชาอื่น กรุณานำออกจากรายวิชาของคุณแทน',
        });
      }
    }

    // Dependency Check: Prevent deleting students/preceptors with active records
    const [hasCases, hasShifts] = await Promise.all([
      LogbookCase.exists({ $or: [{ student_id: id }, { preceptor_id: id }] }),
      Shift.exists({ $or: [{ student_id: id }, { preceptor_id: id }] })
    ]);

    if (hasCases || hasShifts) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลบผู้ใช้งานนี้ได้ เนื่องจากมีข้อมูลบันทึกเคสหรือประวัติการลงเวลาค้างอยู่ในระบบ กรุณาใช้การปิดใช้งานบัญชีแทน'
      });
    }

    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, data: null, message: 'ไม่พบผู้ใช้งาน' });

    const affectedCourses = await CourseAssignment.find({ user_id: id }).distinct('course_id');
    await Promise.all([
      CourseAssignment.deleteMany({ user_id: id }),
      Course.updateMany({ enrolled_students: id }, { $pull: { enrolled_students: id } }),
    ]);
    if (affectedCourses.length > 0 && user.role === 'student') {
      await Promise.all(
        affectedCourses.map(async (courseId) => {
          const count = await CourseAssignment.countDocuments({
            course_id: courseId,
            assignment_role: 'student',
            status: 'active',
          });
          await Course.updateOne({ _id: courseId }, { $set: { enrolled_student_count: count } });
        })
      );
    }

    return res.status(200).json({ success: true, data: null, message: 'ลบผู้ใช้งานเรียบร้อยแล้ว' });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะลบผู้ใช้งาน' });
  }
};
