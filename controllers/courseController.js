const mongoose = require('mongoose');
const Course = require('../models/Course');
const Procedure = require('../models/Procedure');
const User = require('../models/User');
const CourseAssignment = require('../models/CourseAssignment');
const CourseLocation = require('../models/CourseLocation');
const { getAccessibleCourseIds, hasCourseAccess, canManageCourse } = require('../services/courseAccessService');

const ALLOWED_EVALUATION_TYPES = ['Pass/Fail', '0-4'];

exports.createCourse = async (req, res) => {
  try {
    const {
      course_code,
      course_name,
      semester,
      year,
      evaluation_type,
      enrolled_students,
      enrolled_instructors,
      enrolled_preceptors,
      enrolled_locations,
      enrolled_procedures, // Array of existing procedure IDs to clone into this course
      new_procedures,      // Array of new procedure objects
      is_archived,
    } = req.body || {};

    if (
      !course_code ||
      !course_name ||
      !semester ||
      year === undefined ||
      !evaluation_type
    ) {
      return res.status(400).json({
        success: false,
        data: null,
        message:
          'course_code, course_name, semester, year, and evaluation_type are required.',
      });
    }

    if (enrolled_instructors !== undefined && !Array.isArray(enrolled_instructors)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'enrolled_instructors must be an array of course_instructor ids.',
      });
    }

    let normalizedInstructors = Array.isArray(enrolled_instructors)
      ? [...new Set(enrolled_instructors.map((id) => String(id)).filter(Boolean))]
      : [];

    if (req.user.role === 'course_instructor') {
      normalizedInstructors = [...new Set([String(req.user.id), ...normalizedInstructors])];
    }

    if (normalizedInstructors.length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาเลือกอาจารย์ประจำรายวิชาอย่างน้อย 1 คน',
      });
    }

    if (normalizedInstructors.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'All enrolled_instructors must be valid ObjectId values.',
      });
    }

    const validInstructorCount = await User.countDocuments({
      _id: { $in: normalizedInstructors },
      role: 'course_instructor',
      academic_status: 'active',
    });
    if (validInstructorCount !== normalizedInstructors.length) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'อาจารย์ประจำรายวิชาบางรายชื่อไม่ถูกต้อง หรือไม่ได้อยู่ในสถานะ active',
      });
    }

    if (enrolled_preceptors !== undefined && !Array.isArray(enrolled_preceptors)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'enrolled_preceptors must be an array of preceptor ids.',
      });
    }

    const normalizedPreceptors = Array.isArray(enrolled_preceptors)
      ? [...new Set(enrolled_preceptors.map((id) => String(id)).filter(Boolean))]
      : [];

    if (normalizedPreceptors.length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาเลือกพี่เลี้ยงประจำรายวิชาอย่างน้อย 1 คน',
      });
    }

    if (normalizedPreceptors.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'All enrolled_preceptors must be valid ObjectId values.',
      });
    }

    const validPreceptorCount = await User.countDocuments({
      _id: { $in: normalizedPreceptors },
      role: 'preceptor',
      academic_status: 'active',
    });
    if (validPreceptorCount !== normalizedPreceptors.length) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'พี่เลี้ยงบางรายชื่อไม่ถูกต้อง หรือไม่ได้อยู่ในสถานะ active',
      });
    }

    if (enrolled_procedures !== undefined && !Array.isArray(enrolled_procedures)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'enrolled_procedures must be an array of procedure ids.',
      });
    }

    if (new_procedures !== undefined && !Array.isArray(new_procedures)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'new_procedures must be an array of procedure objects.',
      });
    }

    const normalizedProcedureIds = Array.isArray(enrolled_procedures)
      ? [...new Set(enrolled_procedures.map((id) => String(id)).filter(Boolean))]
      : [];

    const normalizedNewProcedures = [];
    if (Array.isArray(new_procedures)) {
      for (const proc of new_procedures) {
        const procedureName = String(proc?.procedure_name || '').trim();
        const targetScore = Number(proc?.target_score);
        const requiredCases = Number(proc?.required_cases);
        if (
          !procedureName ||
          !Number.isFinite(targetScore) ||
          targetScore < 0 ||
          !Number.isFinite(requiredCases) ||
          requiredCases < 1
        ) {
          return res.status(400).json({
            success: false,
            data: null,
            message: 'ข้อมูลหัตถการไม่ครบถ้วน กรุณาระบุชื่อหัตถการ จำนวนเคส (>= 1) และคะแนนเป้าหมาย',
          });
        }
        const { error: formError, normalized: normalizedForm } = Procedure.validateFormStructure(
          proc?.form_structure,
          procedureName
        );
        if (formError) {
          return res.status(400).json({
            success: false,
            data: null,
            message: formError,
          });
        }
        normalizedNewProcedures.push({
          procedure_name: procedureName,
          target_score: targetScore,
          required_cases: requiredCases,
          form_structure: normalizedForm,
        });
      }
    }

    if (normalizedProcedureIds.length === 0 && normalizedNewProcedures.length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาเลือกหรือเพิ่มหัตถการอย่างน้อย 1 รายการ',
      });
    }

    let sourceProceduresToClone = [];
    if (normalizedProcedureIds.length > 0) {
      if (normalizedProcedureIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'All enrolled_procedures must be valid ObjectId values.',
        });
      }

      sourceProceduresToClone = await Procedure.find({
        _id: { $in: normalizedProcedureIds },
      }).lean();

      if (sourceProceduresToClone.length !== normalizedProcedureIds.length) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'Some enrolled_procedures are invalid or do not exist in the system.',
        });
      }
    }

    if (!ALLOWED_EVALUATION_TYPES.includes(evaluation_type)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "evaluation_type must be either 'Pass/Fail' or '0-4'.",
      });
    }

    if (enrolled_students !== undefined && !Array.isArray(enrolled_students)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'enrolled_students must be an array of student ids.',
      });
    }

    const normalizedEnrolledStudents = Array.isArray(enrolled_students)
      ? [...new Set(enrolled_students.map((studentId) => String(studentId)))]
      : [];

    if (
      normalizedEnrolledStudents.some(
        (studentId) => !mongoose.Types.ObjectId.isValid(studentId)
      )
    ) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'All enrolled_students must be valid ObjectId values.',
      });
    }

    if (
      is_archived !== undefined &&
      typeof is_archived !== 'boolean'
    ) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'is_archived must be a boolean.',
      });
    }

    const duplicate = await Course.findOne({
      course_code: course_code.trim(),
      semester,
      year,
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'Course with this code already exists.',
      });
    }

    if (normalizedEnrolledStudents.length > 0) {
      const validStudentCount = await User.countDocuments({
        _id: { $in: normalizedEnrolledStudents },
        role: 'student',
      });
      if (validStudentCount !== normalizedEnrolledStudents.length) {
        return res.status(400).json({ success: false, data: null, message: 'Some enrolled_students are invalid or do not belong to role student.' });
      }
    }
    const normalizedLocations = Array.isArray(enrolled_locations)
      ? [...new Set(enrolled_locations.map(String).filter(Boolean))]
      : [];
    if (normalizedLocations.length > 0) {
      const Location = mongoose.model('Location');
      if (normalizedLocations.some((locationId) => !mongoose.Types.ObjectId.isValid(locationId))) {
        return res.status(400).json({ success: false, data: null, message: 'All enrolled_locations must be valid ObjectId values.' });
      }
      const validLocationCount = await Location.countDocuments({ _id: { $in: normalizedLocations } });
      if (validLocationCount !== normalizedLocations.length) {
        return res.status(400).json({ success: false, data: null, message: 'Some enrolled_locations do not exist.' });
      }
    }

    const created = await Course.create({
      created_by: req.user.id,
      course_code,
      course_name,
      semester,
      year,
      evaluation_type,
      enrolled_students: normalizedEnrolledStudents,
      enrolled_student_count: normalizedEnrolledStudents.length,
      enrolled_locations: normalizedLocations,
      is_archived: is_archived === undefined ? false : is_archived,
    });

    const assignmentWrites = [
      ...normalizedEnrolledStudents.map((userId) =>
        CourseAssignment.findOneAndUpdate(
          { course_id: created._id, user_id: userId, assignment_role: 'student' },
          { $set: { status: 'active', revoked_at: null, assigned_by: req.user.id, assigned_at: new Date() } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        )
      ),
      ...normalizedPreceptors.map((userId) =>
        CourseAssignment.findOneAndUpdate(
          { course_id: created._id, user_id: userId, assignment_role: 'preceptor' },
          { $set: { status: 'active', revoked_at: null, assigned_by: req.user.id, assigned_at: new Date() } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        )
      ),
      ...normalizedInstructors.map((userId) =>
        CourseAssignment.findOneAndUpdate(
          { course_id: created._id, user_id: userId, assignment_role: 'course_instructor' },
          { $set: { status: 'active', revoked_at: null, assigned_by: req.user.id, assigned_at: new Date() } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        )
      ),
    ];
    await Promise.all(assignmentWrites);

    if (normalizedLocations.length > 0) {
      await Promise.all(normalizedLocations.map((locationId) =>
        CourseLocation.findOneAndUpdate(
          { course_id: created._id, location_id: locationId },
          { $set: { status: 'active', added_by: req.user.id } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        )
      ));
    }

    const proceduresToInsert = [
      ...sourceProceduresToClone.map((proc) => ({
        course_id: created._id,
        procedure_name: proc.procedure_name,
        target_score: proc.target_score,
        required_cases: proc.required_cases,
        form_structure: Procedure.normalizeFormStructure(proc.form_structure),
      })),
      ...normalizedNewProcedures.map((proc) => ({
        ...proc,
        course_id: created._id,
      })),
    ];
    if (proceduresToInsert.length > 0) {
      await Procedure.insertMany(proceduresToInsert);
    }

    if (normalizedEnrolledStudents.length > 0) {
      await User.updateMany(
        { _id: { $in: normalizedEnrolledStudents } },
        { $addToSet: { enrolled_courses: created._id } }
      );
    }

    return res.status(201).json({
      success: true,
      data: created,
      message: 'Course created successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Create course error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while creating the course.',
    });
  }
};

exports.getCourses = async (req, res) => {
  try {
    const accessibleIds = await getAccessibleCourseIds(req.user);
    const filter = accessibleIds === null ? {} : { _id: { $in: accessibleIds } };
    const courses = await Course.find(filter).sort({ createdAt: -1 }).lean();
    const courseIds = courses.map((course) => course._id);
    const activeAssignments = courseIds.length > 0
      ? await CourseAssignment.find({
          course_id: { $in: courseIds },
          assignment_role: { $in: ['course_instructor', 'preceptor'] },
          status: 'active',
        })
          .populate('user_id', 'firstname_lastname profile_image')
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const instructorIdsByCourse = new Map();
    const preceptorsByCourse = new Map();

    activeAssignments.forEach((item) => {
      if (!item.user_id) return;
      const courseId = String(item.course_id);
      const userId = String(item.user_id._id);

      if (item.assignment_role === 'course_instructor') {
        if (!instructorIdsByCourse.has(courseId)) instructorIdsByCourse.set(courseId, new Set());
        instructorIdsByCourse.get(courseId).add(userId);
      } else if (item.assignment_role === 'preceptor') {
        if (!preceptorsByCourse.has(courseId)) preceptorsByCourse.set(courseId, new Map());
        const map = preceptorsByCourse.get(courseId);
        if (!map.has(userId)) {
          map.set(userId, {
            _id: item.user_id._id,
            firstname_lastname: item.user_id.firstname_lastname,
            profile_image: item.user_id.profile_image,
          });
        }
      }
    });

    const data = courses.map((course) => {
      const cid = String(course._id);
      const preceptors = preceptorsByCourse.has(cid)
        ? Array.from(preceptorsByCourse.get(cid).values())
        : [];
      return {
        ...course,
        course_instructor_count: instructorIdsByCourse.get(cid)?.size || 0,
        preceptor_count: preceptors.length,
        preceptors,
      };
    });
    return res.status(200).json({
      success: true,
      data,
      message: 'Courses fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get courses error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching courses.',
    });
  }
};

exports.getCourseById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid course id.',
      });
    }

    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Course not found.',
      });
    }

    if (!(await hasCourseAccess(req.user, course._id))) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'คุณไม่มีสิทธิ์เข้าถึงรายวิชานี้',
      });
    }

    return res.status(200).json({
      success: true,
      data: course,
      message: 'Course fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get course by id error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching the course.',
    });
  }
};

exports.updateCourse = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid course id.',
      });
    }

    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Course not found.',
      });
    }

    if (!(await canManageCourse(req.user, course._id))) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'คุณไม่มีสิทธิ์จัดการรายวิชานี้',
      });
    }

    const {
      course_code,
      course_name,
      semester,
      year,
      evaluation_type,
      enrolled_students,
      enrolled_locations,
      is_archived,
    } = req.body || {};
    if (enrolled_students !== undefined && !Array.isArray(enrolled_students)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'enrolled_students must be an array of student ids.',
      });
    }

    const normalizedEnrolledStudents = Array.isArray(enrolled_students)
      ? [...new Set(enrolled_students.map((studentId) => String(studentId)))]
      : null;

    if (
      Array.isArray(normalizedEnrolledStudents) &&
      normalizedEnrolledStudents.some(
        (studentId) => !mongoose.Types.ObjectId.isValid(studentId)
      )
    ) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'All enrolled_students must be valid ObjectId values.',
      });
    }

    if (is_archived !== undefined && typeof is_archived !== 'boolean') {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'is_archived must be a boolean.',
      });
    }


    if (evaluation_type !== undefined && !ALLOWED_EVALUATION_TYPES.includes(evaluation_type)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "evaluation_type must be either 'Pass/Fail' or '0-4'.",
      });
    }

    if (course_code !== undefined && course_code !== course.course_code) {
      const [hasStudents, hasProcedures] = await Promise.all([
        User.exists({ enrolled_courses: id }),
        Procedure.exists({ course_id: id })
      ]);
      
      if (hasStudents || hasProcedures) {
        return res.status(400).json({
          success: false,
          message: 'ไม่สามารถแก้ไขรหัสวิชาได้เนื่องจากมีข้อมูลนักศึกษาหรือหัตถการผูกอยู่ (แนะนำให้สร้างวิชาใหม่แทน)'
        });
      }

      const duplicate = await Course.findOne({
        course_code: course_code.trim(),
        semester: semester !== undefined ? semester : course.semester,
        year: year !== undefined ? year : course.year,
        _id: { $ne: id },
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          data: null,
          message: 'Course with this code already exists.',
        });
      }
      course.course_code = course_code;
    }

    if (semester !== undefined && semester !== course.semester) {
       const hasData = await User.exists({ enrolled_courses: id });
       if (hasData) {
         return res.status(400).json({
           success: false,
           message: 'ไม่สามารถแก้ไขเทอมของวิชาได้เนื่องจากมีนักศึกษาลงทะเบียนอยู่'
         });
       }
       course.semester = semester;
    }
    if (year !== undefined) course.year = year;
    if (evaluation_type !== undefined) course.evaluation_type = evaluation_type;
    if (is_archived !== undefined) course.is_archived = is_archived;
    if (enrolled_locations !== undefined) course.enrolled_locations = enrolled_locations;

    if (Array.isArray(normalizedEnrolledStudents)) {
      const validStudents = await User.find({
        _id: { $in: normalizedEnrolledStudents },
        role: 'student',
      })
        .select('_id')
        .lean();
      const validStudentSet = new Set(validStudents.map((s) => String(s._id)));
      const previousStudentSet = new Set(
        (course.enrolled_students || []).map((studentId) => String(studentId))
      );
      const newlySubmittedInvalidIds = normalizedEnrolledStudents.filter(
        (studentId) => !validStudentSet.has(studentId) && !previousStudentSet.has(studentId)
      );

      if (newlySubmittedInvalidIds.length > 0) {
        return res.status(400).json({
          success: false,
          data: null,
          message:
            'Some enrolled_students are invalid or do not belong to role student.',
        });
      }

      const cleanEnrolledStudents = normalizedEnrolledStudents.filter((studentId) =>
        validStudentSet.has(studentId)
      );

      course.enrolled_students = cleanEnrolledStudents;
      course.enrolled_student_count = cleanEnrolledStudents.length;

      await User.updateMany(
        {
          role: 'student',
          enrolled_courses: course._id,
          _id: { $nin: cleanEnrolledStudents },
        },
        { $pull: { enrolled_courses: course._id } }
      );
      if (cleanEnrolledStudents.length > 0) {
        await User.updateMany(
          { _id: { $in: cleanEnrolledStudents } },
          { $addToSet: { enrolled_courses: course._id } }
        );
      }

      await Promise.all([
        ...cleanEnrolledStudents.map((userId) => CourseAssignment.findOneAndUpdate(
          { course_id: course._id, user_id: userId, assignment_role: 'student' },
          { $set: { status: 'active', revoked_at: null, assigned_by: req.user.id, assigned_at: new Date() } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        )),
        CourseAssignment.updateMany(
          { course_id: course._id, assignment_role: 'student', user_id: { $nin: cleanEnrolledStudents }, status: 'active' },
          { $set: { status: 'inactive', revoked_at: new Date() } }
        ),
      ]);
    }

    if (Array.isArray(enrolled_locations)) {
      await Promise.all([
        ...enrolled_locations.map((locationId) => CourseLocation.findOneAndUpdate(
          { course_id: course._id, location_id: locationId },
          { $set: { status: 'active', added_by: req.user.id } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        )),
        CourseLocation.updateMany(
          { course_id: course._id, location_id: { $nin: enrolled_locations }, status: 'active' },
          { $set: { status: 'inactive' } }
        ),
      ]);
    }

    await course.save();

    return res.status(200).json({
      success: true,
      data: course,
      message: 'Course updated successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Update course error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while updating the course.',
    });
  }
};

exports.deleteCourse = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid course id.',
      });
    }

    // Dependency Check: Prevent deleting course if linked to data
    const [hasStudents, hasProcedures] = await Promise.all([
      User.exists({ enrolled_courses: id }),
      Procedure.exists({ course_id: id })
    ]);

    if (hasStudents || hasProcedures) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลบรายวิชานี้ได้ เนื่องจากมีนักศึกษาลงทะเบียนเรียนอยู่ หรือมีหัตถการผูกกับวิชานี้ กรุณาย้ายหรือลบข้อมูลที่เกี่ยวข้องก่อน'
      });
    }

    const deleted = await Course.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Course not found.',
      });
    }

    return res.status(200).json({
      success: true,
      data: null,
      message: 'Course deleted successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Delete course error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while deleting the course.',
    });
  }
};

exports.rolloverCourses = async (req, res) => {
  try {
    const {
      from_semester,
      to_semester,
      from_year,
      to_year,
      archive_old_offerings = true,
      clear_old_enrollments = true,
      copy_procedures = true,
    } = req.body || {};

    if (!from_semester || !to_semester || from_year === undefined || to_year === undefined) {
      return res.status(400).json({
        success: false,
        data: null,
        message:
          'from_semester, to_semester, from_year, and to_year are required.',
      });
    }

    const sourceCourses = await Course.find({
      semester: from_semester,
      year: from_year,
    });

    if (sourceCourses.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'No source courses found for the provided from_semester/from_year.',
      });
    }

    // ตรวจสอบว่าวิชาในเทอมเป้าหมายมีอยู่แล้วหรือไม่
    const targetCourses = await Course.find({
      semester: to_semester,
      year: to_year,
    });
    const existingCourseCodes = new Set(targetCourses.map((c) => c.course_code));

    const createdCourses = [];
    const skippedCourses = [];
    const courseIdMap = new Map();

    for (const sourceCourse of sourceCourses) {
      // ถ้ามีรหัสวิชานี้ในเทอมเป้าหมายแล้ว ให้ข้ามไป
      if (existingCourseCodes.has(sourceCourse.course_code)) {
        skippedCourses.push(sourceCourse.course_code);
        continue;
      }

      const created = await Course.create({
        course_code: sourceCourse.course_code,
        course_name: sourceCourse.course_name,
        semester: to_semester,
        year: to_year,
        evaluation_type: sourceCourse.evaluation_type,
        enrolled_students: [],
        is_archived: false,
      });
      createdCourses.push(created);
      courseIdMap.set(String(sourceCourse._id), created._id);
    }

    if (createdCourses.length === 0 && skippedCourses.length > 0) {
      return res.status(400).json({
        success: false,
        data: { skipped_courses: skippedCourses },
        message: 'All courses already exist in the target semester and year.',
      });
    }

    if (copy_procedures && createdCourses.length > 0) {
      const sourceProcedures = await Procedure.find({
        course_id: { $in: sourceCourses.map((course) => course._id) },
      });

      if (sourceProcedures.length > 0) {
        const clonedProcedures = sourceProcedures.map((procedure) => ({
          course_id: courseIdMap.get(String(procedure.course_id)),
          procedure_name: procedure.procedure_name,
          target_score: procedure.target_score,
          required_cases: procedure.required_cases,
          form_structure: Procedure.normalizeFormStructure(procedure.form_structure),
        }));
        await Procedure.insertMany(clonedProcedures);
      }
    }

    if (archive_old_offerings) {
      await Course.updateMany(
        { _id: { $in: sourceCourses.map((course) => course._id) } },
        { $set: { is_archived: true } }
      );
    }

    if (clear_old_enrollments) {
      const sourceCourseIds = sourceCourses.map((course) => course._id);
      await Course.updateMany(
        { _id: { $in: sourceCourseIds } },
        { $set: { enrolled_students: [] } }
      );
      await User.updateMany(
        { enrolled_courses: { $in: sourceCourseIds } },
        { $pull: { enrolled_courses: { $in: sourceCourseIds } } }
      );
    }

    return res.status(201).json({
      success: true,
      data: {
        from: { semester: from_semester, year: from_year },
        to: { semester: to_semester, year: to_year },
        created_courses_count: createdCourses.length,
        created_course_ids: createdCourses.map((course) => course._id),
        copied_procedures: copy_procedures,
        archived_old_offerings: archive_old_offerings,
        cleared_old_enrollments: clear_old_enrollments,
      },
      message: 'Course rollover completed successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Course rollover error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while performing course rollover.',
    });
  }
};
