const crypto = require('crypto');
const OTP = require('../models/OTP');
const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');
const {
  asTrimmedString,
  hashScopedToken,
  timingSafeEqualHex,
} = require('../middlewares/securityMiddleware');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_VERIFY_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const generateOTP = () => String(crypto.randomInt(100000, 1000000));

exports.sendOTP = async (req, res) => {
  try {
    const normalizedEmail = asTrimmedString(req.body?.email).toLowerCase();

    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมล',
      });
    }

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รูปแบบอีเมลไม่ถูกต้อง',
      });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('_id academic_status');
    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบบัญชีอีเมลนี้ในระบบ กรุณาตรวจสอบอีกครั้งหรือติดต่อผู้ดูแลระบบ',
      });
    }

    if (user.academic_status === 'inactive') {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
      });
    }

    const existingLatest = await OTP.findOne({ email: normalizedEmail }).sort({ created_at: -1 });
    if (
      existingLatest &&
      existingLatest.created_at &&
      Date.now() - existingLatest.created_at.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      return res.status(429).json({
        success: false,
        data: null,
        message: 'กรุณารอสักครู่ (60 วินาที) ก่อนขอรหัส OTP ใหม่อีกครั้ง',
      });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await OTP.deleteMany({ email: normalizedEmail });
    await OTP.create({
      email: normalizedEmail,
      otp_code: hashScopedToken(`otp:${normalizedEmail}`, otp),
      expires_at: expiresAt,
      is_used: false,
      attempts: 0,
    });

    const subject = 'รหัส OTP สำหรับเข้าใช้งาน Medical Logbook';
    const text = `รหัส OTP ของคุณคือ ${otp} รหัสนี้จะหมดอายุภายใน 5 นาที`;
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.4;">
        <h2>รหัส OTP สำหรับ Medical Logbook</h2>
        <p>รหัส OTP ของคุณคือ:</p>
        <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px;">${otp}</p>
        <p>รหัสนี้จะหมดอายุภายใน <strong>5 นาที</strong></p>
      </div>
    `;

    let emailSent = true;
    try {
      await sendEmail(normalizedEmail, subject, text, html);
    } catch (emailErr) {
      // eslint-disable-next-line no-console
      console.error('Email sending failed:', emailErr);
      emailSent = false;
    }

    return res.status(200).json({
      success: true,
      data: {
        email_sent: emailSent,
      },
      message: emailSent
        ? 'ส่งรหัส OTP ไปยังอีเมลของคุณเรียบร้อยแล้ว'
        : 'สร้างรหัส OTP สำเร็จ (แต่ส่งอีเมลไม่สำเร็จ กรุณาติดต่อผู้ดูแลระบบ)',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Send OTP error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะส่งรหัส OTP',
    });
  }
};

exports.verifyOTP = async (req, res) => {
  try {
    const normalizedEmail = asTrimmedString(req.body?.email).toLowerCase();
    const normalizedOtp = asTrimmedString(req.body?.otp);

    if (!normalizedEmail || !normalizedOtp) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมลและรหัส OTP',
      });
    }

    const otpDoc = await OTP.findOne({
      email: normalizedEmail,
      is_used: false,
    }).sort({ created_at: -1 });

    if (!otpDoc) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัส OTP ไม่ถูกต้องหรือหมดอายุแล้ว',
      });
    }

    if (new Date() > otpDoc.expires_at) {
      await OTP.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัส OTP หมดอายุแล้ว กรุณาขอรหัสใหม่',
      });
    }

    if ((otpDoc.attempts || 0) >= MAX_OTP_VERIFY_ATTEMPTS) {
      await OTP.deleteOne({ _id: otpDoc._id });
      return res.status(429).json({
        success: false,
        data: null,
        message: 'กรอกรหัส OTP ผิดเกินจำนวนครั้งที่กำหนด กรุณาขอรหัสใหม่',
      });
    }

    const submittedHash = hashScopedToken(`otp:${normalizedEmail}`, normalizedOtp);
    const isValid = timingSafeEqualHex(otpDoc.otp_code, submittedHash);

    if (!isValid) {
      const nextAttempts = (otpDoc.attempts || 0) + 1;
      if (nextAttempts >= MAX_OTP_VERIFY_ATTEMPTS) {
        await OTP.deleteOne({ _id: otpDoc._id });
        return res.status(429).json({
          success: false,
          data: null,
          message: 'กรอกรหัส OTP ผิดเกินจำนวนครั้งที่กำหนด กรุณาขอรหัสใหม่',
        });
      }

      otpDoc.attempts = nextAttempts;
      await otpDoc.save();

      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัส OTP ไม่ถูกต้อง',
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    otpDoc.is_used = true;
    otpDoc.reset_token_hash = hashScopedToken(`reset:${normalizedEmail}`, resetToken);
    otpDoc.reset_token_expires_at = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await otpDoc.save();

    return res.status(200).json({
      success: true,
      data: {
        resetToken,
      },
      message: 'ยืนยันรหัส OTP สำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Verify OTP error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะยืนยันรหัส OTP',
    });
  }
};
