const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const Location = require('../models/Location');
const { calculateDistanceInMeters } = require('../utils/distanceHelper');

const { createNotification } = require('./notificationController');

exports.checkIn = async (req, res) => {
  try {
    const { location_id, preceptor_id, latitude, longitude } = req.body || {};

    if (!location_id || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุสถานที่ปฏิบัติงาน พิกัดละติจูด และพิกัดลองจิจูด',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(location_id)) {
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

    // Validation: Prevent graduated students from checking in
    if (req.user.academic_status === 'graduated') {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'ไม่สามารถลงเวลาเข้าเวรได้ เนื่องจากคุณสำเร็จการศึกษาแล้ว',
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
      student_id: req.user.id,
      location_id,
      preceptor_id,
      shift_date: new Date(),
      Check_in_lat: Number(latitude),
      Check_in_lng: Number(longitude),
      shift_status: 'normal',
      verify_status: 'pending',
    });

    // 1. Notify the Preceptor
    if (preceptor_id) {
      await createNotification({
        recipient_id: preceptor_id,
        sender_id: req.user.id,
        target_id: createdShift._id,
        type: 'shift_checkin', // Adjusted type for shifts
        message: `มีนิสิตลงเวลาเข้าเวรที่ ${location.Location_name} รอการยืนยันจากคุณ`,
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
      .limit(limit);

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
      .limit(limit);

    return res.status(200).json({
      success: true,
      data: shifts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'ดึงข้อมูลการเข้าเวรของนิสิตสำเร็จ',
    });
  } catch (err) {
    console.error('Get preceptor shifts error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะดึงข้อมูลการเข้าเวรของนิสิต',
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

    const updatedShift = await Shift.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: false }
    ).populate('student_id', 'firstname_lastname profile_image student_id year')
     .populate('location_id', 'Location_name');

    // Notify the Student about the verification result - ONLY when finalized
    if (normalizedStatus === 'verified' || normalizedStatus === 'rejected') {
        const statusText = normalizedStatus === 'verified' ? 'ได้รับการยืนยันแล้ว' : 'ถูกปฏิเสธ';
        await createNotification({
          recipient_id: updatedShift.student_id,
          sender_id: req.user.id,
          target_id: updatedShift._id,
          type: 'shift_verified',
          message: `การเข้าเวรที่ ${updatedShift.location_id?.Location_name || 'สถานที่ปฏิบัติงาน'} ${statusText}`,
        });
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
