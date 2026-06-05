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
      enrolled_courses, // Added
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
      if (!workplace) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุสถานที่ปฏิบัติงานสำหรับอาจารย์พี่เลี้ยง' });
      }
      const location = await Location.findById(workplace);
      if (!location) {
        return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานไม่ถูกต้อง' });
      }
      if (semester && location.semester !== semester) {
        return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานต้องอยู่ในเทอมเดียวกับผู้ใช้' });
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
      workplace: role === 'preceptor' ? workplace : undefined,
      year: role === 'student' ? year : undefined,
      // Semester is allowed for both student and preceptor.
      semester,
      academic_status: academic_status || 'active',
      enrolled_courses: Array.isArray(enrolled_courses) ? enrolled_courses : [], // Added
    });

    // Sync with Course model if student (Added)
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
    // eslint-disable-next-line no-console
    console.error('Create user error:', err);

    // Handle duplicate email gracefully
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
          workplace // This comes from row.workplace_id in frontend
        } = userData;

        if (!email || !role || !firstname_lastname) {
          throw new Error('ขาดข้อมูลสำคัญ (email, role, name)');
        }

        const allowedRoles = ['student', 'preceptor'];
        if (!allowedRoles.includes(role.toLowerCase())) {
          throw new Error(`บทบาทไม่ถูกต้อง: ${role} (อนุญาตเฉพาะ student หรือ preceptor)`);
        }

        let validWorkplaceId = undefined;

        if (role === 'preceptor') {
          if (!workplace) {
            throw new Error('อาจารย์พี่เลี้ยงต้องระบุสถานที่ปฏิบัติงาน (workplace_id)');
          }
          
          if (!mongoose.Types.ObjectId.isValid(workplace)) {
            throw new Error(`รหัสสถานที่ปฏิบัติงานไม่ถูกต้อง: ${workplace}`);
          }

          const location = await Location.findById(workplace);
          if (!location) {
             throw new Error(`ไม่พบสถานที่ปฏิบัติงานรหัส: ${workplace}`);
          }
          
          if (semester && location.semester !== semester) {
             throw new Error(`สถานที่ปฏิบัติงานต้องอยู่ในเทอมเดียวกับผู้ใช้ (เทอม ${semester})`);
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
    // eslint-disable-next-line no-console
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
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบผู้ใช้งาน',
      });
    }

    return res.status(200).json({
      success: true,
      data: user,
      message: 'ดึงข้อมูลผู้ใช้งานสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get user by id error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลผู้ใช้งาน',
    });
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password').populate('workplace', 'Location_name semester');

    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลโปรไฟล์',
      });
    }

    return res.status(200).json({
      success: true,
      data: user,
      message: 'ดึงข้อมูลโปรไฟล์สำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get my profile error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลโปรไฟล์',
    });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    const {
      firstname_lastname,
      phone_number,
      profile_image,
      workplace,
      password,
    } = req.body || {};

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบผู้ใช้งาน',
      });
    }

    if (firstname_lastname !== undefined)
      user.firstname_lastname = firstname_lastname;
    if (phone_number !== undefined) user.phone_number = phone_number;
    if (profile_image !== undefined) user.profile_image = profile_image;

    if (user.role === 'preceptor' && workplace !== undefined) {
      const location = await Location.findById(workplace);
      if (!location) {
        return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานไม่ถูกต้อง' });
      }
      if (user.semester && location.semester !== user.semester) {
        return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานต้องอยู่ในเทอมเดียวกับผู้ใช้' });
      }
      user.workplace = workplace;
    }

    if (password !== undefined && password !== null && password !== '') {
      user.password = password;
    }

    await user.save();
    
    const updatedUser = await User.findById(user._id).select('-password').populate('workplace', 'Location_name semester');

    return res.status(200).json({
      success: true,
      data: safeUser(updatedUser),
      message: 'อัปเดตโปรไฟล์เรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Update my profile error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะอัปเดตโปรไฟล์',
    });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
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
      password,
      enrolled_courses, // Added
    } = req.body || {};

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบผู้ใช้งาน',
      });
    }

    const allowedRoles = ['student', 'preceptor'];
    const nextRole = role !== undefined ? role : user.role;
    const nextSemester = semester !== undefined ? semester : user.semester;
    const allowedAcademicStatuses = ['active', 'graduated', 'inactive'];

    // Prevent role changes to admin (and prevent setting any other role).
    if (role !== undefined && !allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        data: null,
        message: "บทบาทต้องเป็น 'student' หรือ 'preceptor' เท่านั้น ไม่สามารถตั้งเป็น 'admin' ได้",
      });
    }

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

    // Validate role-specific required fields using "next" values.
    const effectiveStudentId =
      student_id !== undefined ? student_id : user.student_id;
    const effectiveWorkplace =
      workplace !== undefined ? workplace : user.workplace;

    if (nextRole === 'student' && (!effectiveStudentId || effectiveStudentId === '')) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุรหัสนิสิตสำหรับบทบาทนักศึกษา',
      });
    }

    if (nextRole === 'preceptor') {
       if (!effectiveWorkplace || effectiveWorkplace === '') {
          return res.status(400).json({
            success: false,
            data: null,
            message: 'กรุณาระบุสถานที่ปฏิบัติงานสำหรับบทบาทอาจารย์พี่เลี้ยง',
          });
       }
       const location = await Location.findById(effectiveWorkplace);
       if (!location) {
         return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานไม่ถูกต้อง' });
       }
       if (nextSemester && location.semester !== nextSemester) {
         return res.status(400).json({ success: false, message: 'สถานที่ปฏิบัติงานต้องอยู่ในเทอมเดียวกับผู้ใช้' });
       }
    }

    // Update allowed fields only
    if (email !== undefined) user.email = email;
    if (role !== undefined) user.role = role;
    if (firstname_lastname !== undefined)
      user.firstname_lastname = firstname_lastname;
    if (phone_number !== undefined) user.phone_number = phone_number;
    if (profile_image !== undefined) user.profile_image = profile_image;

    // Only update role-specific fields for the effective role.
    if (nextRole === 'student') {
      user.workplace = undefined; // clear preceptor field on student role
      if (student_id !== undefined) user.student_id = student_id;
      if (year !== undefined) user.year = year;

      // Handle enrolled_courses sync (Added)
      if (Array.isArray(enrolled_courses)) {
        const previousCourseIds = (user.enrolled_courses || []).map(id => id.toString());
        const newCourseIds = enrolled_courses.map(id => id.toString());

        const removedCourses = previousCourseIds.filter(id => !newCourseIds.includes(id));
        const addedCourses = newCourseIds.filter(id => !previousCourseIds.includes(id));

        if (removedCourses.length > 0) {
          await Course.updateMany(
            { _id: { $in: removedCourses } },
            { 
              $pull: { enrolled_students: user._id },
              $inc: { enrolled_student_count: -1 }
            }
          );
        }

        if (addedCourses.length > 0) {
          await Course.updateMany(
            { _id: { $in: addedCourses } },
            { 
              $addToSet: { enrolled_students: user._id },
              $inc: { enrolled_student_count: 1 }
            }
          );
        }

        user.enrolled_courses = enrolled_courses;
      }
    } else if (nextRole === 'preceptor') {
      user.student_id = undefined; // clear student field on preceptor role
      user.year = undefined;
      if (workplace !== undefined) user.workplace = workplace;
      
      // Clear enrolled courses for non-students (Added)
      if (user.enrolled_courses && user.enrolled_courses.length > 0) {
        await Course.updateMany(
          { enrolled_students: user._id },
          { 
            $pull: { enrolled_students: user._id },
            $inc: { enrolled_student_count: -1 }
          }
        );
        user.enrolled_courses = [];
      }
    }

    // Semester is shared by both student and preceptor.
    if (semester !== undefined) user.semester = semester;
    if (academic_status !== undefined) user.academic_status = academic_status;

    // If password is supplied, treat it as plain-text new password;
    // User model hook will hash it.
    if (password !== undefined && password !== null && password !== '') {
      user.password = password;
    }

    await user.save();
    
    const updatedUser = await User.findById(user._id).select('-password').populate('workplace', 'Location_name semester');

    return res.status(200).json({
      success: true,
      data: safeUser(updatedUser),
      message: 'อัปเดตข้อมูลผู้ใช้งานเรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Update user error:', err);

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
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะอัปเดตข้อมูลผู้ใช้งาน',
    });
  }
};
exports.getPreceptors = async (req, res) => {
  try {
    const { semester } = req.query;
    const filter = { role: 'preceptor' };
    if (semester) filter.semester = semester;

    const preceptors = await User.find(filter).select('-password');

    return res.status(200).json({
      success: true,
      data: preceptors,
      message: 'ดึงข้อมูลอาจารย์พี่เลี้ยงสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get preceptors error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลอาจารย์พี่เลี้ยง',
    });
  }
};

exports.getPreceptorsByLocation = async (req, res) => {
  try {
    const { locationId, semester } = req.query;

    if (!locationId || !semester) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุรหัสสถานที่และเทอม',
      });
    }

    const filter = {
      role: 'preceptor',
      workplace: locationId,
      semester: semester,
    };

    const preceptors = await User.find(filter).select('firstname_lastname');

    return res.status(200).json({
      success: true,
      data: preceptors,
    });
  } catch (err) {
    console.error('Error fetching preceptors by location:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลอาจารย์พี่เลี้ยงตามสถานที่',
    });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await User.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบผู้ใช้งาน',
      });
    }

    return res.status(200).json({
      success: true,
      data: null,
      message: 'ลบผู้ใช้งานเรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Delete user error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะลบผู้ใช้งาน',
    });
  }
};

