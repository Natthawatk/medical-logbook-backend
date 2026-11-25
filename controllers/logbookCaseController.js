const mongoose = require('mongoose');
const LogbookCase = require('../models/LogbookCase');
const Procedure = require('../models/Procedure');
const Course = require('../models/Course');
const User = require('../models/User');
const Notification = require('../models/Notification');
const CourseAssignment = require('../models/CourseAssignment');
const CourseLocation = require('../models/CourseLocation');
const Location = require('../models/Location');
const { createNotification, notifyCourseInstructors } = require('./notificationController');
const { getCompletedStudentSetForProcedures, notifyCourseCompletionForStudents } = require('../services/courseCompletionService');
const { canManageCourse } = require('../services/courseAccessService');
const { normalizeVerifierText, upsertLocationVerifier } = require('../services/centralPreceptorService');
const { invalidateDashboardCache } = require('../services/dashboardCacheService');

const ALLOWED_EVALUATION_STATUS = ['approved', 'rejected'];

const validateRequiredCaseFields = (procedure, caseData) => {
  const requiredFields = Array.isArray(procedure?.form_structure)
    ? procedure.form_structure.filter((field) => field && field.is_required)
    : [];
  if (requiredFields.length === 0) return null;
  const missingFields = requiredFields
    .filter((field) => {
      const val = caseData && typeof caseData === 'object' ? caseData[field.field_name] : undefined;
      return val === undefined || val === null || String(val).trim() === '';
    })
    .map((field) => field.field_name);
  if (missingFields.length > 0) {
    return `กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน: ${missingFields.join(', ')}`;
  }
  return null;
};

exports.createCase = async (req, res) => {
  try {
    const {
      procedure_id,
      preceptor_id,
      location_id,
      case_data,
      case_date,
      on_site_verifier_name,
      on_site_verifier_position,
      on_site_verifier_phone,
    } = req.body || {};

    if (!procedure_id || !preceptor_id || !location_id || !case_data) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุข้อมูลหัตถการ อาจารย์พี่เลี้ยง สถานที่ และรายละเอียดเคสให้ครบถ้วน',
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(procedure_id) ||
      !mongoose.Types.ObjectId.isValid(preceptor_id) ||
      !mongoose.Types.ObjectId.isValid(location_id)
    ) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัสหัตถการ อาจารย์พี่เลี้ยง หรือสถานที่ ไม่ถูกต้อง',
      });
    }

    const [procedure, preceptor, student, location] = await Promise.all([
      Procedure.findById(procedure_id),
      User.findById(preceptor_id),
      User.findById(req.user.id),
      Location.findById(location_id),
    ]);

    if (!location) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลสถานที่ปฏิบัติงาน',
      });
    }

    if (!procedure) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลหัตถการ',
      });
    }

    const missingError = validateRequiredCaseFields(procedure, case_data);
    if (missingError) {
      return res.status(400).json({
        success: false,
        data: null,
        message: missingError,
      });
    }

    if (!preceptor || preceptor.role !== 'preceptor') {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลอาจารย์พี่เลี้ยง',
      });
    }


    const [studentAssignment, preceptorAssignment, courseLocation, legacyCourseLocation] = await Promise.all([
      CourseAssignment.exists({
        course_id: procedure.course_id,
        user_id: req.user.id,
        assignment_role: 'student',
        status: 'active',
      }),
      CourseAssignment.exists({
        course_id: procedure.course_id,
        user_id: preceptor_id,
        assignment_role: 'preceptor',
        status: 'active',
      }),
      CourseLocation.exists({
        course_id: procedure.course_id,
        location_id,
        status: 'active',
      }),
      Course.exists({
        _id: procedure.course_id,
        enrolled_locations: location_id,
      }),
    ]);

    if (!studentAssignment) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'คุณไม่ได้ลงทะเบียนในรายวิชาที่เกี่ยวข้องกับหัตถการนี้ จึงไม่สามารถบันทึกเคสได้',
      });
    }
    if (!courseLocation && !legacyCourseLocation) {
      return res.status(400).json({ success: false, data: null, message: 'สถานที่ไม่ได้อยู่ในรายวิชานี้' });
    }
    const isCentralForLocation = String(location.central_preceptor_id || '') === String(preceptor_id);
    if (preceptor.is_shared_account && !isCentralForLocation) {
      return res.status(400).json({ success: false, data: null, message: 'บัญชีกลางที่เลือกไม่ได้ผูกกับสถานที่ปฏิบัติงานนี้' });
    }
    if (!preceptorAssignment) {
      if (isCentralForLocation) {
        await CourseAssignment.findOneAndUpdate(
          { course_id: procedure.course_id, user_id: preceptor_id, assignment_role: 'preceptor' },
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

    const createdCase = await LogbookCase.create({
      student_id: req.user.id,
      procedure_id,
      preceptor_id,
      location_id,
      on_site_verifier_name: isCentralForLocation ? verifierName : '',
      on_site_verifier_position: isCentralForLocation ? verifierPosition : '',
      on_site_verifier_phone: isCentralForLocation ? verifierPhone : '',
      case_data,
      case_date,
      evaluation_status: 'pending',
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

    // Calculate progress (e.g., 2/10) - นับรวมทั้งที่ผ่านแล้วและที่รอประเมินเพื่อหาลำดับล่าสุด
    const recordedCount = await LogbookCase.countDocuments({
      student_id: req.user.id,
      procedure_id: procedure_id,
      evaluation_status: { $in: ['approved', 'pending'] },
    });

    const totalTarget = procedure.required_cases || procedure.target_score || 1;
    const progressString = `(${recordedCount}/${totalTarget})`;

    const submitter = await User.findById(req.user.id).select('firstname_lastname student_id').lean();
    const submitterLabel = submitter
      ? `${submitter.firstname_lastname || 'นักศึกษา'}${submitter.student_id ? ` (${submitter.student_id})` : ''}`
      : 'นักศึกษา';

    const verifierSuffix = isCentralForLocation && verifierName ? ` (ผู้ยืนยันหน้างาน: ${verifierName})` : '';

    // 1. Notify the Preceptor
    await createNotification({
      recipient_id: preceptor_id,
      sender_id: req.user.id,
      target_id: createdCase._id,
      type: 'case_submitted',
      message: `นักศึกษา ${submitterLabel} ส่งเคสใหม่สำหรับ ${procedure.procedure_name} ${progressString}${verifierSuffix} รอการประเมินจากคุณ`,
    });

    // 2. Notify the Student (Confirmation)
    await createNotification({
      recipient_id: req.user.id,
      sender_id: req.user.id,
      target_id: createdCase._id,
      type: 'case_submitted',
      message: `บันทึกเคส ${procedure.procedure_name} ${progressString} เรียบร้อยแล้ว รอดำเนินการประเมิน`,
    });

    return res.status(201).json({
      success: true,
      data: createdCase,
      message: 'บันทึกเคสเรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Create case error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะบันทึกเคส',
    });
  }
};

exports.getMyCases = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const total = await LogbookCase.countDocuments({ student_id: req.user.id });
    const cases = await LogbookCase.find({ student_id: req.user.id })
      .populate('procedure_id')
      .populate('preceptor_id', 'firstname_lastname email')
      .populate('location_id', 'Location_name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: cases,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'ดึงข้อมูลเคสของคุณสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get my cases error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลเคสของคุณ',
    });
  }
};

exports.getPendingCases = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const query = {
      preceptor_id: req.user.id,
      evaluation_status: 'pending',
    };

    const total = await LogbookCase.countDocuments(query);
    const cases = await LogbookCase.find(query)
      .populate('student_id', 'firstname_lastname email student_id')
      .populate('procedure_id')
      .populate('location_id', 'Location_name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: cases,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'ดึงข้อมูลเคสที่รอการประเมินสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get pending cases error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลเคสที่รอการประเมิน',
    });
  }
};

exports.getCasesForPreceptor = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const query = { preceptor_id: req.user.id };

    const total = await LogbookCase.countDocuments(query);
    const cases = await LogbookCase.find(query)
      .populate('student_id', 'firstname_lastname profile_image year')
      .populate('procedure_id', 'procedure_name required_cases target_score')
      .populate('location_id', 'Location_name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const uniquePairs = [];
    const seenPairs = new Set();
    for (const c of cases) {
      if (!c.student_id || !c.procedure_id) continue;
      const key = `${c.student_id._id}:${c.procedure_id._id}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      uniquePairs.push({
        student_id: c.student_id._id,
        procedure_id: c.procedure_id._id,
      });
    }

    const progressCountMap = new Map();
    if (uniquePairs.length > 0) {
      const groupedCounts = await LogbookCase.aggregate([
        {
          $match: {
            $or: uniquePairs,
            evaluation_status: { $in: ['approved', 'pending'] },
          },
        },
        {
          $group: {
            _id: {
              student_id: '$student_id',
              procedure_id: '$procedure_id',
            },
            count: { $sum: 1 },
          },
        },
      ]);
      for (const row of groupedCounts) {
        const key = `${row._id.student_id}:${row._id.procedure_id}`;
        progressCountMap.set(key, row.count);
      }
    }

    const casesWithProgress = cases.map((c) => {
      if (!c.student_id || !c.procedure_id) {
        return {
          ...c,
          progress: '0/1',
        };
      }
      const key = `${c.student_id._id}:${c.procedure_id._id}`;
      const recordedCount = progressCountMap.get(key) || 0;
      const target = c.procedure_id.required_cases || c.procedure_id.target_score || 1;
      return {
        ...c,
        progress: `${recordedCount}/${target}`,
      };
    });

    return res.status(200).json({
      success: true,
      data: casesWithProgress,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'ดึงข้อมูลเคสทั้งหมดสำเร็จ',
    });
  } catch (err) {
    console.error('Get preceptor cases error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
};

exports.getCaseById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'รหัสเคสไม่ถูกต้อง' });
    }

    const logbookCase = await LogbookCase.findById(id)
      .populate('student_id', 'firstname_lastname email student_id profile_image year')
      .populate('preceptor_id', 'firstname_lastname email profile_image')
      .populate('location_id', 'Location_name')
      .populate({
        path: 'procedure_id',
        populate: { path: 'course_id', model: 'Course' },
      });

    if (!logbookCase) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลเคส' });
    }

    // Authorization check: Only student who created it, assigned preceptor, or admin can view
    const isOwner = String(logbookCase.student_id._id) === String(req.user.id);
    const isPreceptor = String(logbookCase.preceptor_id._id) === String(req.user.id);
    const isAdmin = req.user.role === 'admin';

    let isCourseInstructor = false;
    if (req.user.role === 'course_instructor') {
      const courseId = logbookCase.procedure_id?.course_id?._id || logbookCase.procedure_id?.course_id;
      if (courseId) {
        isCourseInstructor = await canManageCourse(req.user, courseId);
      }
    }

    if (!isOwner && !isPreceptor && !isAdmin && !isCourseInstructor) {
      return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ในการดูเคสนี้' });
    }

    return res.status(200).json({ success: true, data: logbookCase });
  } catch (err) {
    console.error('Get case by id error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
};

exports.evaluateCase = async (req, res) => {
  try {
    const { id } = req.params;
    const { evaluation_status, evaluation_result, feedback } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัสเคสไม่ถูกต้อง',
      });
    }

    const logbookCase = await LogbookCase.findById(id).populate({
      path: 'procedure_id',
      populate: { path: 'course_id', model: 'Course' },
    });

    if (!logbookCase) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลเคส',
      });
    }

    if (String(logbookCase.preceptor_id) !== String(req.user.id)) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'คุณไม่ได้ถูกมอบหมายให้ประเมินเคสนี้',
      });
    }

    if (logbookCase.evaluation_status !== 'pending') {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'สามารถประเมินได้เฉพาะเคสที่อยู่ในสถานะรอการประเมินเท่านั้น',
      });
    }

    const normalizedStatus = String(evaluation_status || '').toLowerCase();
    if (!ALLOWED_EVALUATION_STATUS.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "สถานะการประเมินต้องเป็น 'approved' หรือ 'rejected'",
      });
    }

    if (evaluation_result === undefined || evaluation_result === null) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุผลการประเมิน',
      });
    }

    const procedure = logbookCase.procedure_id;
    const course = procedure ? procedure.course_id : null;
    if (!course) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลรายวิชาที่เกี่ยวข้องกับหัตถการนี้',
      });
    }
    const activePreceptorAssignment = await CourseAssignment.exists({
      course_id: course._id,
      user_id: req.user.id,
      assignment_role: 'preceptor',
      status: 'active',
    });
    if (!activePreceptorAssignment) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่ได้เป็นพี่เลี้ยงในรายวิชานี้' });
    }

    // Validate score against course evaluation type.
    if (course.evaluation_type === 'Pass/Fail') {
      const passFailScores = [0, 1];
      if (
        typeof evaluation_result !== 'number' ||
        !Number.isFinite(evaluation_result) ||
        !passFailScores.includes(evaluation_result)
      ) {
        return res.status(400).json({
          success: false,
          data: null,
          message:
            "สำหรับวิชาแบบ 'Pass/Fail' ผลการประเมินต้องเป็น 0 (ไม่ผ่าน) หรือ 1 (ผ่าน)",
        });
      }
    } else if (course.evaluation_type === '0-4') {
      if (
        typeof evaluation_result !== 'number' ||
        !Number.isFinite(evaluation_result) ||
        evaluation_result < 0 ||
        evaluation_result > 4
      ) {
        return res.status(400).json({
          success: false,
          data: null,
          message:
            "สำหรับวิชาแบบ '0-4' ผลการประเมินต้องเป็นตัวเลขระหว่าง 0 ถึง 4",
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'ไม่รองรับรูปแบบการประเมินของรายวิชานี้',
      });
    }

    const previousEvaluationStatus = logbookCase.evaluation_status;
    logbookCase.evaluation_status = normalizedStatus;
    logbookCase.evaluation_result = evaluation_result;
    if (feedback !== undefined) logbookCase.feedback = feedback;
    logbookCase.evaluated_at = new Date();

    await logbookCase.save();
    invalidateDashboardCache();

    // Mark related incoming notifications as read for the current preceptor.
    await Notification.updateMany(
      {
        recipient_id: req.user.id,
        target_id: logbookCase._id,
      },
      {
        $set: { is_read: true },
      }
    );

    await createNotification({
      recipient_id: logbookCase.student_id,
      sender_id: req.user.id,
      target_id: logbookCase._id,
      type: 'case_evaluated',
      message: `เคสหัตถการของคุณได้รับการ${normalizedStatus === 'approved' ? 'อนุมัติ' : 'ปฏิเสธ'}แล้ว`,
    });

    if (normalizedStatus === 'rejected' || Number(evaluation_result) <= 0) {
      const student = await User.findById(logbookCase.student_id).select('firstname_lastname student_id').lean();
      const studentLabel = student
        ? `${student.firstname_lastname || 'นักศึกษา'}${student.student_id ? ` (${student.student_id})` : ''}`
        : 'นักศึกษา';
      const courseCodeLabel = course?.course_code ? ` [${course.course_code}]` : '';
      const procedureLabel = procedure?.procedure_name || 'หัตถการ';
      const failedCourseId = course?._id || logbookCase.course_id;

      if (failedCourseId) {
        await notifyCourseInstructors({
          courseId: failedCourseId,
          senderId: req.user.id,
          targetId: logbookCase._id,
          type: 'instructor_case_failed',
          severity: 'danger',
          actionUrl: `/logbook-cases/${logbookCase._id}`,
          message: `${studentLabel} ไม่ผ่านการประเมินเคส "${procedureLabel}"${courseCodeLabel}`,
        });
      }
    }

    if (normalizedStatus === 'approved' && previousEvaluationStatus !== 'approved') {
      const targetCourseId = course?._id || logbookCase.course_id;
      if (targetCourseId) {
        const courseProcedures = await Procedure.find({ course_id: targetCourseId })
          .select('_id procedure_name required_cases target_score')
          .lean();

        if (courseProcedures.length > 0) {
          const studentIdStr = String(logbookCase.student_id);
          const completedSet = await getCompletedStudentSetForProcedures(courseProcedures, [studentIdStr]);
          if (completedSet.has(studentIdStr)) {
            const currentReq = Number(procedure.required_cases || procedure.target_score || 1);
            const approvedForCurrent = await LogbookCase.countDocuments({
              student_id: logbookCase.student_id,
              procedure_id: procedure._id,
              evaluation_status: 'approved',
            });
            const justReachedCurrent = Math.max(0, approvedForCurrent - 1) < currentReq && approvedForCurrent >= currentReq;
            if (justReachedCurrent) {
              await notifyCourseCompletionForStudents({
                studentIds: [studentIdStr],
                courseId: targetCourseId,
                courseDoc: course,
                senderId: req.user.id,
                targetId: logbookCase._id,
                procedures: courseProcedures,
                reasonLabel: `ปิดท้ายด้วย "${procedure?.procedure_name || 'หัตถการ'}"`,
              });
            }
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: logbookCase,
      message: 'ประเมินเคสเรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Evaluate case error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะประเมินเคส',
    });
  }
};

exports.getAllCases = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const total = await LogbookCase.countDocuments();
    const cases = await LogbookCase.find()
      .populate('student_id', 'firstname_lastname email student_id')
      .populate('preceptor_id', 'firstname_lastname email')
      .populate('location_id', 'Location_name')
      .populate({
        path: 'procedure_id',
        populate: { path: 'course_id', model: 'Course' },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    return res.status(200).json({
      success: true,
      data: cases,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'ดึงข้อมูลเคสทั้งหมดสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get all cases error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลเคสทั้งหมด',
    });
  }
};

exports.updateCaseByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, data: null, message: 'รหัสเคสไม่ถูกต้อง' });
    }

    const logbookCase = await LogbookCase.findById(id);
    if (!logbookCase) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลเคส' });
    }

    const procedure = await Procedure.findById(logbookCase.procedure_id);
    if (!procedure) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลหัตถการของเคสนี้' });
    }
    const course = await Course.findById(procedure.course_id);
    if (!course) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลรายวิชาของเคสนี้' });
    }

    const {
      location_id,
      preceptor_id,
      case_date,
      case_data,
      evaluation_status,
      evaluation_result,
      feedback,
    } = req.body || {};

    if (location_id !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(location_id)) {
        return res.status(400).json({ success: false, data: null, message: 'รหัสสถานที่ไม่ถูกต้อง' });
      }
      const courseLocation = await CourseLocation.exists({
        course_id: course._id,
        location_id,
        status: 'active',
      });
      if (!courseLocation) {
        return res.status(400).json({ success: false, data: null, message: 'สถานที่ที่เลือกไม่ได้อยู่ในรายวิชานี้' });
      }
      logbookCase.location_id = location_id;
    }

    if (preceptor_id !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(preceptor_id)) {
        return res.status(400).json({ success: false, data: null, message: 'รหัสอาจารย์พี่เลี้ยงไม่ถูกต้อง' });
      }
      const preceptorAssignment = await CourseAssignment.exists({
        course_id: course._id,
        user_id: preceptor_id,
        assignment_role: 'preceptor',
        status: 'active',
      });
      if (!preceptorAssignment) {
        return res.status(400).json({ success: false, data: null, message: 'อาจารย์พี่เลี้ยงที่เลือกไม่ได้อยู่ในรายวิชานี้' });
      }
      logbookCase.preceptor_id = preceptor_id;
    }

    if (case_date !== undefined) {
      const parsedDate = new Date(case_date);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ success: false, data: null, message: 'วันเวลาที่ทำหัตถการไม่ถูกต้อง' });
      }
      logbookCase.case_date = parsedDate;
    }

    if (case_data !== undefined) {
      if (!case_data || typeof case_data !== 'object' || Array.isArray(case_data)) {
        return res.status(400).json({ success: false, data: null, message: 'รูปแบบข้อมูลรายละเอียดเคสไม่ถูกต้อง' });
      }
      const mergedCaseData = { ...(logbookCase.case_data || {}), ...case_data };
      const missingError = validateRequiredCaseFields(procedure, mergedCaseData);
      if (missingError) {
        return res.status(400).json({ success: false, data: null, message: missingError });
      }
      logbookCase.case_data = mergedCaseData;
      logbookCase.markModified('case_data');
    }

    const previousStatus = logbookCase.evaluation_status;
    if (evaluation_status !== undefined) {
      const normalizedStatus = String(evaluation_status).toLowerCase();
      if (!['pending', 'approved', 'rejected'].includes(normalizedStatus)) {
        return res.status(400).json({ success: false, data: null, message: 'สถานะการประเมินไม่ถูกต้อง' });
      }
      if (normalizedStatus === 'pending') {
        logbookCase.evaluation_status = 'pending';
        logbookCase.evaluation_result = undefined;
        logbookCase.evaluated_at = undefined;
      } else {
        const numericScore = Number(evaluation_result);
        if (course.evaluation_type === 'Pass/Fail') {
          if (!Number.isFinite(numericScore) || ![0, 1].includes(numericScore)) {
            return res.status(400).json({
              success: false,
              data: null,
              message: "สำหรับวิชาแบบ 'Pass/Fail' ผลการประเมินต้องเป็น 0 (ไม่ผ่าน) หรือ 1 (ผ่าน)",
            });
          }
        } else if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 4) {
          return res.status(400).json({
            success: false,
            data: null,
            message: "สำหรับวิชาแบบ '0-4' ผลการประเมินต้องอยู่ระหว่าง 0 ถึง 4",
          });
        }
        logbookCase.evaluation_status = normalizedStatus;
        logbookCase.evaluation_result = numericScore;
        if (!logbookCase.evaluated_at || previousStatus !== normalizedStatus) {
          logbookCase.evaluated_at = new Date();
        }
      }
    }

    if (feedback !== undefined) {
      logbookCase.feedback = feedback;
    }

    await logbookCase.save();
    invalidateDashboardCache();

    if (logbookCase.evaluation_status === 'approved' && previousStatus !== 'approved') {
      const courseProcedures = await Procedure.find({ course_id: course._id })
        .select('_id procedure_name required_cases target_score')
        .lean();
      if (courseProcedures.length > 0) {
        const studentIdStr = String(logbookCase.student_id);
        const completedSet = await getCompletedStudentSetForProcedures(courseProcedures, [studentIdStr]);
        if (completedSet.has(studentIdStr)) {
          const currentReq = Number(procedure.required_cases || procedure.target_score || 1);
          const approvedForCurrent = await LogbookCase.countDocuments({
            student_id: logbookCase.student_id,
            procedure_id: procedure._id,
            evaluation_status: 'approved',
          });
          if (Math.max(0, approvedForCurrent - 1) < currentReq && approvedForCurrent >= currentReq) {
            await notifyCourseCompletionForStudents({
              studentIds: [studentIdStr],
              courseId: course._id,
              courseDoc: course,
              senderId: req.user.id,
              targetId: logbookCase._id,
              procedures: courseProcedures,
              reasonLabel: `ปิดท้ายด้วย "${procedure.procedure_name}"`,
            });
          }
        }
      }
    }

    const updated = await LogbookCase.findById(logbookCase._id)
      .populate('student_id', 'firstname_lastname email student_id profile_image year')
      .populate('preceptor_id', 'firstname_lastname email profile_image')
      .populate('location_id', 'Location_name')
      .populate({
        path: 'procedure_id',
        populate: { path: 'course_id', model: 'Course' },
      });

    return res.status(200).json({
      success: true,
      data: updated,
      message: 'อัปเดตข้อมูลเคสเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Admin update case error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดขณะอัปเดตข้อมูลเคส' });
  }
};

exports.deleteCaseByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, data: null, message: 'รหัสเคสไม่ถูกต้อง' });
    }

    const deleted = await LogbookCase.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, data: null, message: 'ไม่พบข้อมูลเคส' });
    }
    invalidateDashboardCache();

    await Notification.deleteMany({ target_id: id });

    return res.status(200).json({
      success: true,
      data: null,
      message: 'ลบข้อมูลบันทึกเคสเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Admin delete case error:', err);
    return res.status(500).json({ success: false, data: null, message: 'เกิดข้อผิดพลาดขณะลบข้อมูลเคส' });
  }
};
