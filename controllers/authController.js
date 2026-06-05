const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const OTP = require('../models/OTP');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมลและรหัสผ่าน',
      });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบบัญชีผู้ใช้ในระบบ กรุณาติดต่อผู้ดูแลระบบ',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
      });
    }

    // Check if account is active
    if (user.academic_status === 'inactive') {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
      });
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const safeUser = {
      id: user._id,
      email: user.email,
      role: user.role,
      firstname_lastname: user.firstname_lastname,
      student_id: user.student_id,
    };

    return res.status(200).json({
      success: true,
      data: {
        token,
        user: safeUser,
      },
      message: 'เข้าสู่ระบบสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Login error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดระหว่างการเข้าสู่ระบบ',
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, new_password } = req.body || {};

    if (!email || !otp || !new_password) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมล รหัส OTP และรหัสผ่านใหม่',
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // 1. ตรวจสอบความถูกต้องของ OTP
    const otpDoc = await OTP.findOne({
      email: normalizedEmail,
      otp_code: String(otp).trim(),
    }).sort({ created_at: -1 });

    if (!otpDoc) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัส OTP ไม่ถูกต้อง',
      });
    }

    // ถ้า OTP ถูกใช้ไปนานแล้ว (เกิน 5 นาที) ถึงจะถือว่าใช้ไม่ได้
    // แต่ถ้าเพิ่งใช้ไปหยกๆ (อาจเกิดจากการกด verify ก่อนหน้า) ให้ยอมให้ผ่านได้
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (otpDoc.is_used && otpDoc.updated_at < fiveMinutesAgo) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัส OTP นี้ถูกใช้งานไปแล้ว',
      });
    }

    if (new Date() > otpDoc.expires_at) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัส OTP หมดอายุแล้ว',
      });
    }

    // 2. ค้นหา User และอัปเดตรหัสผ่าน
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบผู้ใช้งาน',
      });
    }

    // อัปเดตรหัสผ่าน (pre-save hook ใน models/User.js จะทำการ hash ให้เอง)
    user.password = new_password;
    await user.save();

    // 3. ปิดการใช้งาน OTP นี้
    otpDoc.is_used = true;
    await otpDoc.save();

    return res.status(200).json({
      success: true,
      data: null,
      message: 'รีเซ็ตรหัสผ่านเรียบร้อยแล้ว',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Reset password error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะรีเซ็ตรหัสผ่าน',
    });
  }
};

