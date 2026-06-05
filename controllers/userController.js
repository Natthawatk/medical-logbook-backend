const mongoose = require('mongoose');
const User = require('../models/User');
const Location = require('../models/Location');
const Course = require('../models/Course');
const bcrypt = require('bcryptjs');

const DEFAULT_USER_PASSWORD =
  process.env.DEFAULT_USER_PASSWORD || 'password123';

const safeUser = (userDoc) => {
  if (!userDoc) return null;

  const obj = userDoc.toObject ? userDoc.toObject() : userDoc;
  // Ensure password is never returned
  delete obj.password;
  return obj;
};

exports.createUser = async (req, res) => {
  try {
    const {
      email,
      role,
      firstname_lastname,
      phone_number,
      profile_image,
      student_id,
      workplace,
      year,
      semester,
      academic_status,
      defaultPassword,
      enrolled_courses,
    } = req.body || {};

    if (!email || !role || !firstname_lastname) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมล บทบาท และชื่อ-นามสกุล',
      });
    }

    const allowedRoles = ['student', 'preceptor'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "บทบาทต้องเป็น 'student' หรือ 'preceptor' เท่านั้น",
      });
    }

    if (role === 'preceptor') {
      if (workplace && workplace !== '') {
        const location = await Location.findById(workplace);
        if (!location) {
          return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานไม่ถูกต้อง' });
        }
      }
    }

    const allowedAcademicStatuses = ['active', 'graduated', 'inactive'];
    if (
      academic_status !== undefined &&
      !allowedAcademicStatuses.includes(academic_status)
    ) {
      return res.status(400).json({
        success: false,
        data: null,
        message:
          "สถานะทางวิชาการต้องเป็น 'active', 'graduated' หรือ 'inactive'",
      });
    }

    const passwordToUse = defaultPassword || DEFAULT_USER_PASSWORD;
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(passwordToUse, salt);

    const createdUser = await User.create({
      email,
      password: hashedPassword,
      role,
      firstname_lastname,
      phone_number,
      profile_image,
      student_id: role === 'student' ? student_id : undefined,
      workplace: (role === 'preceptor' && workplace && workplace !== '') ? workplace : null,
      year: role === 'student' ? year : undefined,
      semester,
      academic_status: academic_status || 'active',
      enrolled_courses: Array.isArray(enrolled_courses) ? enrolled_courses : [],
    });

    if (role === 'student' && Array.isArray(enrolled_courses) && enrolled_courses.length > 0) {
      await Course.updateMany(
        { _id: { $in: enrolled_courses } },
        { 
          $addToSet: { enrolled_students: createdUser._id },
          $inc: { enrolled_student_count: 1 }
        }
      );
    }

    return res.status(201).json({
      success: true,
      data: safeUser(createdUser),
      message: 'สร้างผู้ใช้งานเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Create user error:', err);
    if (err && err.code === 11000) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'อีเมลนี้มีอยู่ในระบบแล้ว กรุณาใช้อีเมลอื่น',
      });
    }
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะสร้างผู้ใช้งาน',
    });
  }
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

    const salt = await bcrypt.genSalt(10);
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    const creationPromises = users.map(async (userData, index) => {
      try {
        const {
          email,
          role,
          firstname_lastname,
          phone_number,
          student_id,
          year,
          semester,
          password,
          workplace
        } = userData;

        if (!email || !role || !firstname_lastname) {
          throw new Error('ขาดข้อมูลสำคัญ (email, role, name)');
        }

        const allowedRoles = ['student', 'preceptor'];
        if (!allowedRoles.includes(role.toLowerCase())) {
          throw new Error(`บทบาทไม่ถูกต้อง: ${role} (อนุญาตเฉพาะ student หรือ preceptor)`);
        }

        let validWorkplaceId = null;

        if (role === 'preceptor' && workplace && workplace !== '') {
          if (!mongoose.Types.ObjectId.isValid(workplace)) {
            throw new Error(`รหัสสถานที่ปฏิบัติงานไม่ถูกต้อง: ${workplace}`);
          }
          const location = await Location.findById(workplace);
          if (!location) {
             throw new Error(`ไม่พบสถานที่ปฏิบัติงานรหัส: ${workplace}`);
          }
          validWorkplaceId = workplace;
        }

        const hashedPassword = await bcrypt.hash(password || DEFAULT_USER_PASSWORD, salt);

        await User.create({
          email: email.toLowerCase().trim(),
          password: hashedPassword,
          role,
          firstname_lastname: firstname_lastname.trim(),
          phone_number,
          student_id: role === 'student' ? student_id : undefined,
          year: role === 'student' ? year : undefined,
          workplace: validWorkplaceId,
          semester,
          academic_status: 'active'
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
const fs = require('fs');
const stripBom = require('strip-bom-stream');

exports.importUsersCSV = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'กรุณาอัปโหลดไฟล์ CSV' });
  }

  const results = {
    created: 0,
    updated: 0,
    failed: 0,
    errors: []
  };

  const usersToProcess = [];
  let stream = fs.createReadStream(req.file.path);
  
  if (typeof stripBom === 'function') {
    stream = stream.pipe(stripBom());
  }

  stream
    .pipe(csv({
      mapHeaders: ({ header }) => header.trim()
    }))
    .on('data', (data) => usersToProcess.push(data))
    .on('end', async () => {
      const salt = await bcrypt.genSalt(10);

      for (let i = 0; i < usersToProcess.length; i++) {
        const row = usersToProcess[i];
        try {
          const getVal = (thaiKey, engKey) => {
            return row[thaiKey] || row[engKey] || '';
          };

          const firstname_lastname = getVal('ชื่อ-นามสกุล', 'firstname_lastname').trim();
          const email = getVal('อีเมล', 'email').toLowerCase().trim();
          const phone_number = getVal('เบอร์โทรศัพท์', 'phone_number').trim();
          const roleRaw = getVal('บทบาท (student/preceptor/admin)', 'role').toLowerCase().trim();
          const student_id = getVal('รหัสนักศึกษา', 'student_id').trim();
          const year = getVal('ชั้นปี', 'year').trim();
          const semester = getVal('เทอม (เช่น 1/2569)', 'semester').trim();
          const workplace_id_raw = getVal('รหัสสถานที่ (ID)', 'workplace_id').trim();
          const workplace_id = workplace_id_raw === '' ? null : workplace_id_raw;
          const password = getVal('รหัสผ่าน', 'password').trim();

          let role = '';
          if (roleRaw.includes('student')) role = 'student';
          else if (roleRaw.includes('preceptor')) role = 'preceptor';
          else if (roleRaw.includes('admin')) role = 'admin';

          if (!email || !role || !firstname_lastname) {
            throw new Error(`ขาดข้อมูลสำคัญ (อีเมล: ${email || 'ว่าง'}, บทบาท: ${role || 'ว่าง'}, ชื่อ: ${firstname_lastname || 'ว่าง'})`);
          }

          if (!['student', 'preceptor', 'admin'].includes(role)) {
            throw new Error(`บทบาทไม่ถูกต้อง: ${role} (ต้องเป็น student, preceptor หรือ admin)`);
          }

          let workplace = null;
          if (role === 'preceptor' && workplace_id) {
            if (mongoose.Types.ObjectId.isValid(workplace_id)) {
              workplace = workplace_id;
            } else {
              throw new Error(`รหัสสถานที่ปฏิบัติงานไม่ถูกต้อง: ${workplace_id}`);
            }
          }

          const userData = {
            email,
            role,
            firstname_lastname,
            phone_number,
            student_id: role === 'student' ? student_id : undefined,
            year: role === 'student' ? year : undefined,
            workplace,
            semester,
            academic_status: 'active'
          };

          const existingUser = await User.findOne({ email });
          if (existingUser) {
            if (password) {
              userData.password = await bcrypt.hash(password, salt);
            }
            await User.updateOne({ _id: existingUser._id }, { $set: userData });
            results.updated++;
          } else {
            userData.password = await bcrypt.hash(password || DEFAULT_USER_PASSWORD, salt);
            await User.create(userData);
            results.created++;
          }
        } catch (err) {
          results.failed++;
          results.errors.push({
            row: i + 2,
            email: row['อีเมล'] || row.email || 'ไม่ระบุ',
            message: err.message
          });
        }
      }

      fs.unlinkSync(req.file.path);

      return res.status(200).json({
        success: true,
        ...results,
        message: `นำเข้าสำเร็จ: สร้างใหม่ ${results.created} บัญชี, อัปเดต ${results.updated} บัญชี`
      });
    });
};

exports.getUsers = async (req, res) => {
  try {
    const { role } = req.query;
    const filter = {};
    if (role) filter.role = role;
    const users = await User.find(filter).select('-password').populate('workplace', 'Location_name semester');
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
    const user = await User.findById(id).select('-password').populate('workplace', 'Location_name semester');
    if (!user) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบผู้ใช้งาน' });
    }
    return res.status(200).json({ success: true, data: user, message: 'ดึงข้อมูลผู้ใช้งานสำเร็จ' });
  } catch (err) {
    console.error('Get user by id error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลผู้ใช้งาน' });
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password').populate('workplace', 'Location_name semester');
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
    const { firstname_lastname, phone_number, profile_image, workplace, password } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบผู้ใช้งาน' });
    }
    if (firstname_lastname !== undefined) user.firstname_lastname = firstname_lastname;
    if (phone_number !== undefined) user.phone_number = phone_number;
    if (profile_image !== undefined) user.profile_image = profile_image;
    if (user.role === 'preceptor' && workplace !== undefined) {
      if (workplace && workplace !== '') {
        const location = await Location.findById(workplace);
        if (!location) return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานไม่ถูกต้อง' });
        user.workplace = workplace;
      } else {
        user.workplace = null;
      }
    }
    if (password !== undefined && password !== null && password !== '') user.password = password;
    await user.save();
    const updatedUser = await User.findById(user._id).select('-password').populate('workplace', 'Location_name semester');
    return res.status(200).json({ success: true, data: safeUser(updatedUser), message: 'อัปเดตโปรไฟล์เรียบร้อยแล้ว' });
  } catch (err) {
    console.error('Update my profile error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะอัปเดตโปรไฟล์' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role, firstname_lastname, phone_number, profile_image, student_id, workplace, year, semester, academic_status, password, enrolled_courses } = req.body || {};
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบผู้ใช้งาน' });
    }
    const allowedRoles = ['student', 'preceptor'];
    const nextRole = role !== undefined ? role : user.role;
    const allowedAcademicStatuses = ['active', 'graduated', 'inactive'];

    if (user.role === 'admin' && academic_status === 'inactive') {
      const activeAdminsCount = await User.countDocuments({ role: 'admin', academic_status: 'active' });
      if (activeAdminsCount <= 1 && user.academic_status === 'active') {
         return res.status(400).json({ success: false, message: 'ไม่สามารถปิดการใช้งานแอดมินคนสุดท้ายของระบบได้' });
      }
    }

    if (role !== undefined && role !== user.role) {
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({ success: false, message: "บทบาทไม่ถูกต้อง" });
      }

      // Check if user has active records before allowing role change
      const LogbookCase = mongoose.model('LogbookCase');
      const Shift = mongoose.model('Shift');
      const [hasCases, hasShifts] = await Promise.all([
        LogbookCase.exists({ student_id: id }),
        Shift.exists({ $or: [{ student_id: id }, { preceptor_id: id }] })
      ]);

      if (hasCases || hasShifts) {
        return res.status(400).json({
          success: false,
          message: 'ไม่สามารถเปลี่ยนบทบาทผู้ใช้งานได้ เนื่องจากมีข้อมูลประวัติการใช้งานในบทบาทเดิมค้างอยู่'
        });
      }
    }

    if (academic_status !== undefined && !allowedAcademicStatuses.includes(academic_status)) {
      return res.status(400).json({ success: false, data: null, message: "สถานะต้องเป็น 'active', 'graduated' หรือ 'inactive'" });
    }

    const effectiveStudentId = student_id !== undefined ? student_id : user.student_id;
    if (nextRole === 'student' && (!effectiveStudentId || effectiveStudentId === '')) {
      return res.status(400).json({ success: false, data: null, message: 'กรุณาระบุรหัสนิสิตสำหรับบทบาทนักศึกษา' });
    }

    if (nextRole === 'preceptor' && workplace && workplace !== '') {
       const location = await Location.findById(workplace);
       if (!location) return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานไม่ถูกต้อง' });
    }

    if (email !== undefined) user.email = email;
    if (role !== undefined) user.role = role;
    if (firstname_lastname !== undefined) user.firstname_lastname = firstname_lastname;
    if (phone_number !== undefined) user.phone_number = phone_number;
    if (profile_image !== undefined) user.profile_image = profile_image;

    if (nextRole === 'student') {
      user.workplace = null;
      if (student_id !== undefined) user.student_id = student_id;
      if (year !== undefined) user.year = year;
      if (Array.isArray(enrolled_courses)) {
        const previousCourseIds = (user.enrolled_courses || []).map(id => id.toString());
        const newCourseIds = enrolled_courses.map(id => id.toString());
        const removedCourses = previousCourseIds.filter(id => !newCourseIds.includes(id));
        const addedCourses = newCourseIds.filter(id => !previousCourseIds.includes(id));

        if (removedCourses.length > 0) {
          await Course.updateMany({ _id: { $in: removedCourses } }, { $pull: { enrolled_students: user._id }, $inc: { enrolled_student_count: -1 } });
        }
        if (addedCourses.length > 0) {
          await Course.updateMany({ _id: { $in: addedCourses } }, { $addToSet: { enrolled_students: user._id }, $inc: { enrolled_student_count: 1 } });
        }
        user.enrolled_courses = enrolled_courses;
      }
    } else if (nextRole === 'preceptor') {
      user.student_id = undefined;
      user.year = undefined;
      if (workplace !== undefined) {
        user.workplace = (workplace === '' || workplace === null) ? null : workplace;
      }
      if (user.enrolled_courses && user.enrolled_courses.length > 0) {
        await Course.updateMany({ enrolled_students: user._id }, { $pull: { enrolled_students: user._id }, $inc: { enrolled_student_count: -1 } });
        user.enrolled_courses = [];
      }
    }

    if (semester !== undefined) user.semester = semester;
    if (academic_status !== undefined) user.academic_status = academic_status;
    if (password !== undefined && password !== null && password !== '') user.password = password;

    await user.save();
    const updatedUser = await User.findById(user._id).select('-password').populate('workplace', 'Location_name semester');
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
    const { semester } = req.query;
    const filter = { role: 'preceptor' };
    if (semester) filter.semester = semester;
    
    const preceptors = await User.find(filter).select('-password');
    
    // Auto-cleanup stale workplaces (Added)
    // Check if assigned workplaces actually exist
    const preceptorWithWorkplace = preceptors.filter(p => p.workplace);
    const workplaceIds = [...new Set(preceptorWithWorkplace.map(p => p.workplace.toString()))];
    
    if (workplaceIds.length > 0) {
      const activeLocations = await Location.find({ _id: { $in: workplaceIds } }).select('_id');
      const activeIds = activeLocations.map(l => l._id.toString());
      
      const stalePreceptors = preceptorWithWorkplace.filter(p => !activeIds.includes(p.workplace.toString()));
      
      if (stalePreceptors.length > 0) {
        await User.updateMany(
          { _id: { $in: stalePreceptors.map(p => p._id) } },
          { $set: { workplace: null } }
        );
        // Refresh the list for response
        return exports.getPreceptors(req, res);
      }
    }

    return res.status(200).json({ success: true, data: preceptors, message: 'ดึงข้อมูลอาจารย์พี่เลี้ยงสำเร็จ' });
  } catch (err) {
    console.error('Get preceptors error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลอาจารย์พี่เลี้ยง' });
  }
};

exports.getPreceptorsByLocation = async (req, res) => {
  try {
    const { locationId, semester } = req.query;
    if (!locationId || !semester) {
      return res.status(400).json({ success: false, data: null, message: 'กรุณาระบุรหัสสถานที่และเทอม' });
    }
    const filter = { role: 'preceptor', workplace: locationId, semester: semester };
    const preceptors = await User.find(filter).select('firstname_lastname');
    return res.status(200).json({ success: true, data: preceptors });
  } catch (err) {
    console.error('Error fetching preceptors by location:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลอาจารย์พี่เลี้ยงตามสถานที่' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });

    // Safeguard: Prevent deleting the last active admin
    if (user.role === 'admin' && user.academic_status === 'active') {
      const activeAdminsCount = await User.countDocuments({ role: 'admin', academic_status: 'active' });
      if (activeAdminsCount <= 1) {
        return res.status(400).json({ success: false, message: 'ไม่สามารถลบแอดมินคนสุดท้ายของระบบได้' });
      }
    }

    // Dependency Check: Prevent deleting students/preceptors with active records
    const LogbookCase = mongoose.model('LogbookCase');
    const Shift = mongoose.model('Shift');

    const [hasCases, hasShifts] = await Promise.all([
      LogbookCase.exists({ student_id: id }),
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
    return res.status(200).json({ success: true, data: null, message: 'ลบผู้ใช้งานเรียบร้อยแล้ว' });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะลบผู้ใช้งาน' });
  }
};
