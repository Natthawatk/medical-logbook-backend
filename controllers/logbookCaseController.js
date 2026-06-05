const mongoose = require('mongoose');
const LogbookCase = require('../models/LogbookCase');
const Procedure = require('../models/Procedure');
const Course = require('../models/Course');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { createNotification } = require('./notificationController');

const ALLOWED_EVALUATION_STATUS = ['approved', 'rejected'];

exports.createCase = async (req, res) => {
  try {
    const { procedure_id, preceptor_id, location_id, case_data, case_date } = req.body || {};

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

    const [procedure, preceptor, student] = await Promise.all([
      Procedure.findById(procedure_id),
      User.findById(preceptor_id),
      User.findById(req.user.id),
    ]);

    if (!procedure) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลหัตถการ',
      });
    }

    if (!preceptor || preceptor.role !== 'preceptor') {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบข้อมูลอาจารย์พี่เลี้ยง',
      });
    }

    // Validation: Prevent graduated students from creating new records
    if (req.user.academic_status === 'graduated') {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'ไม่สามารถส่งเคสใหม่ได้ เนื่องจากคุณสำเร็จการศึกษาแล้ว',
      });
    }

    // Validation: Check if student is enrolled in the course associated with this procedure
    const isEnrolled = student.enrolled_courses.some(
      (courseId) => courseId.toString() === procedure.course_id.toString()
    );

    if (!isEnrolled) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'คุณไม่ได้ลงทะเบียนในรายวิชาที่เกี่ยวข้องกับหัตถการนี้ จึงไม่สามารถบันทึกเคสได้',
      });
    }

    const createdCase = await LogbookCase.create({
      student_id: req.user.id,
      procedure_id,
      preceptor_id,
      location_id,
      case_data,
      case_date,
      evaluation_status: 'pending',
    });

    // Calculate progress (e.g., 2/10) - นับรวมทั้งที่ผ่านแล้วและที่รอประเมินเพื่อหาลำดับล่าสุด
    const recordedCount = await LogbookCase.countDocuments({
      student_id: req.user.id,
      procedure_id: procedure_id,
      evaluation_status: { $in: ['approved', 'pending'] },
    });

    const totalTarget = procedure.required_cases || procedure.target_score || 1;
    const progressString = `(${recordedCount}/${totalTarget})`;

    // 1. Notify the Preceptor
    await createNotification({
      recipient_id: preceptor_id,
      sender_id: req.user.id,
      target_id: createdCase._id,
      type: 'case_submitted',
      message: `มีเคสใหม่สำหรับ ${procedure.procedure_name} ${progressString} รอการประเมินจากคุณ`,
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
    const cases = await LogbookCase.find({ student_id: req.user.id })
      .populate('procedure_id')
      .populate('preceptor_id', 'firstname_lastname email')
      .populate('location_id', 'Location_name')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: cases,
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
    const cases = await LogbookCase.find({
      preceptor_id: req.user.id,
      evaluation_status: 'pending',
    })
      .populate('student_id', 'firstname_lastname email student_id')
      .populate('procedure_id')
      .populate('location_id', 'Location_name')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: cases,
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
    const cases = await LogbookCase.find({ preceptor_id: req.user.id })
      .populate('student_id', 'firstname_lastname profile_image year')
      .populate('procedure_id', 'procedure_name required_cases target_score')
      .populate('location_id', 'Location_name')
      .sort({ createdAt: -1 });

    const casesWithProgress = await Promise.all(cases.map(async (c) => {
      if (!c.student_id || !c.procedure_id) {
        return {
          ...c.toObject(),
          progress: '0/1'
        };
      }

      const recordedCount = await LogbookCase.countDocuments({
        student_id: c.student_id._id,
        procedure_id: c.procedure_id._id,
        evaluation_status: { $in: ['approved', 'pending'] },
      });

      const target = c.procedure_id.required_cases || c.procedure_id.target_score || 1;

      return {
        ...c.toObject(),
        progress: `${recordedCount}/${target}`
      };
    }));

    return res.status(200).json({
      success: true,
      data: casesWithProgress,
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
      .populate('preceptor_id', 'firstname_lastname email profile_image workplace')
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

    if (!isOwner && !isPreceptor && !isAdmin) {
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

    logbookCase.evaluation_status = normalizedStatus;
    logbookCase.evaluation_result = evaluation_result;
    if (feedback !== undefined) logbookCase.feedback = feedback;
    logbookCase.evaluated_at = new Date();

    await logbookCase.save();

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
    const cases = await LogbookCase.find()
      .populate('student_id', 'firstname_lastname email student_id')
      .populate('preceptor_id', 'firstname_lastname email workplace')
      .populate('location_id', 'Location_name')
      .populate({
        path: 'procedure_id',
        populate: { path: 'course_id', model: 'Course' },
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: cases,
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
