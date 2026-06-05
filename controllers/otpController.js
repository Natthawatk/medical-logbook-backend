const OTP = require('../models/OTP');
const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');

const generateOTP = () => String(Math.floor(100000 + Math.random() * 900000));

exports.sendOTP = async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมล',
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // Check if user exists in the system
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบบัญชีผู้ใช้ในระบบ กรุณาติดต่อผู้ดูแลระบบ',
      });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await OTP.create({
      email: normalizedEmail,
      otp_code: otp,
      expires_at: expiresAt,
      is_used: false,
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
      console.warn('Email sending failed. Please check your .env configuration.');
      emailSent = false;
    }

    return res.status(200).json({
      success: true,
      data: {
        email_sent: emailSent,
      },
      message: emailSent 
        ? 'ส่งรหัส OTP เรียบร้อยแล้ว' 
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
    const { email, otp } = req.body || {};

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมลและรหัส OTP',
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedOtp = String(otp).trim();

    const otpDoc = await OTP.findOne({
      email: normalizedEmail,
      otp_code: normalizedOtp,
    }).sort({ created_at: -1 });

    if (!otpDoc) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'รหัส OTP ไม่ถูกต้อง',
      });
    }

    if (otpDoc.is_used) {
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

    otpDoc.is_used = true;
    await otpDoc.save();

    return res.status(200).json({
      success: true,
      data: null,
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
