const mongoose = require('mongoose');
const Course = require('../models/Course');
const Procedure = require('../models/Procedure');
const User = require('../models/User');

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
      enrolled_locations,
      enrolled_procedures, // Array of existing procedure IDs
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

    // Combine existing and new procedure logic (Optional during creation now)
    const hasExistingProcedures = Array.isArray(enrolled_procedures) && enrolled_procedures.length > 0;
    const hasNewProcedures = Array.isArray(new_procedures) && new_procedures.length > 0;

    // ตรวจสอบความถูกต้องของ Procedure IDs (ถ้ามี)
    if (hasExistingProcedures) {
      if (enrolled_procedures.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'All enrolled_procedures must be valid ObjectId values.',
        });
      }

      const validProceduresCount = await Procedure.countDocuments({
        _id: { $in: enrolled_procedures },
      });

      if (validProceduresCount !== enrolled_procedures.length) {
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

    const created = await Course.create({
      course_code,
      course_name,
      semester,
      year,
      evaluation_type,
      enrolled_students: normalizedEnrolledStudents,
      enrolled_student_count: normalizedEnrolledStudents.length,
      enrolled_locations: enrolled_locations || [],
      enrolled_procedures: hasExistingProcedures ? enrolled_procedures : [],
      is_archived: is_archived === undefined ? false : is_archived,
    });

    // ถ้ามีหัตถการใหม่ ให้สร้างและเชื่อมโยง
    if (hasNewProcedures) {
      const proceduresToCreate = new_procedures.map(proc => ({
        ...proc,
        course_id: created._id
      }));
      const createdProcedures = await Procedure.insertMany(proceduresToCreate);
      const newProcedureIds = createdProcedures.map(proc => proc._id);
      
      // อัปเดตรายวิชาด้วย IDs ของหัตถการใหม่
      await Course.findByIdAndUpdate(created._id, {
        $addToSet: { enrolled_procedures: { $each: newProcedureIds } }
      });
      
      // อัปเดตตัวแปร created เพื่อส่งกลับ
      created.enrolled_procedures = [
        ...(created.enrolled_procedures || []),
        ...newProcedureIds
      ];
    }

    if (normalizedEnrolledStudents.length > 0) {
      const validStudentCount = await User.countDocuments({
        _id: { $in: normalizedEnrolledStudents },
        role: 'student',
      });
      if (validStudentCount !== normalizedEnrolledStudents.length) {
        await Course.findByIdAndDelete(created._id);
        return res.status(400).json({
          success: false,
          data: null,
          message:
            'Some enrolled_students are invalid or do not belong to role student.',
        });
      }

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
    const courses = await Course.find().sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      data: courses,
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

    if (course_code !== undefined) {
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

    if (course_name !== undefined) course.course_name = course_name;
    if (semester !== undefined) course.semester = semester;
    if (year !== undefined) course.year = year;
    if (evaluation_type !== undefined) course.evaluation_type = evaluation_type;
    if (is_archived !== undefined) course.is_archived = is_archived;
    if (enrolled_locations !== undefined) course.enrolled_locations = enrolled_locations;

    if (Array.isArray(normalizedEnrolledStudents)) {
      const validStudentCount = await User.countDocuments({
        _id: { $in: normalizedEnrolledStudents },
        role: 'student',
      });
      if (validStudentCount !== normalizedEnrolledStudents.length) {
        return res.status(400).json({
          success: false,
          data: null,
          message:
            'Some enrolled_students are invalid or do not belong to role student.',
        });
      }

      const previousStudentIds = (course.enrolled_students || []).map((studentId) =>
        String(studentId)
      );
      const removedStudentIds = previousStudentIds.filter(
        (studentId) => !normalizedEnrolledStudents.includes(studentId)
      );
      const addedStudentIds = normalizedEnrolledStudents.filter(
        (studentId) => !previousStudentIds.includes(studentId)
      );

      course.enrolled_students = normalizedEnrolledStudents;
      course.enrolled_student_count = normalizedEnrolledStudents.length;

      if (removedStudentIds.length > 0) {
        await User.updateMany(
          { _id: { $in: removedStudentIds } },
          { $pull: { enrolled_courses: course._id } }
        );
      }
      if (addedStudentIds.length > 0) {
        await User.updateMany(
          { _id: { $in: addedStudentIds } },
          { $addToSet: { enrolled_courses: course._id } }
        );
      }
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

    const deleted = await Course.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Course not found.',
      });
    }

    await User.updateMany(
      { enrolled_courses: deleted._id },
      { $pull: { enrolled_courses: deleted._id } }
    );

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
          form_structure: procedure.form_structure || [],
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
