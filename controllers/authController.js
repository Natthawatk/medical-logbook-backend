const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const OTP = require('../models/OTP');
const { JWT_SECRET } = require('../config/environment');
const {
  asString,
  asTrimmedString,
  validatePassword,
  hashScopedToken,
} = require('../middlewares/securityMiddleware');

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ACCOUNT_LOCK_DURATION_MS = 15 * 60 * 1000;
const DUMMY_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

exports.login = async (req, res) => {
  try {
    const rawEmail = asTrimmedString(req.body?.email).toLowerCase();
    const rawPassword = asString(req.body?.password);

    if (!rawEmail || !rawPassword) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมลและรหัสผ่าน',
      });
    }

    const user = await User.findOne({ email: rawEmail }).select(
      '+password +failed_login_attempts +lock_until +token_version'
    );

    if (!user) {
      // Constant-ish timing mitigation against user enumeration
      await bcrypt.compare(rawPassword, DUMMY_BCRYPT_HASH);
      return res.status(401).json({
        success: false,
        data: null,
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
      });
    }

    if (user.lock_until && user.lock_until > new Date()) {
      const remainingMinutes = Math.max(
        1,
        Math.ceil((user.lock_until.getTime() - Date.now()) / (60 * 1000))
      );
      return res.status(429).json({
        success: false,
        data: null,
        message: `บัญชีถูกล็อกชั่วคราวเนื่องจากใส่รหัสผ่านผิดหลายครั้ง กรุณาลองใหม่ในอีก ${remainingMinutes} นาที`,
      });
    }

    const isMatch = user.password
      ? await bcrypt.compare(rawPassword, user.password)
      : false;

    if (!isMatch) {
      const nextAttempts = (user.failed_login_attempts || 0) + 1;
      const updatePayload = { failed_login_attempts: nextAttempts };
      if (nextAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        updatePayload.lock_until = new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS);
      }
      await User.updateOne({ _id: user._id }, { $set: updatePayload });

      if (nextAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        return res.status(429).json({
          success: false,
          data: null,
          message: 'ใส่รหัสผ่านผิดเกินกำหนด บัญชีถูกล็อกชั่วคราว 15 นาที',
        });
      }

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

    if ((user.failed_login_attempts || 0) > 0 || user.lock_until) {
      await User.updateOne(
        { _id: user._id },
        { $set: { failed_login_attempts: 0, lock_until: null } }
      );
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
        tv: user.token_version || 0,
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
    const normalizedEmail = asTrimmedString(req.body?.email).toLowerCase();
    const resetToken = asTrimmedString(req.body?.reset_token);
    const newPassword = asString(req.body?.new_password);

    if (!normalizedEmail || !resetToken || !newPassword) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุอีเมล โทเค็นยืนยัน และรหัสผ่านใหม่',
      });
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        data: null,
        message: passwordError,
      });
    }

    const expectedTokenHash = hashScopedToken(`reset:${normalizedEmail}`, resetToken);
    const otpDoc = await OTP.findOne({
      email: normalizedEmail,
      is_used: true,
      reset_token_hash: expectedTokenHash,
      reset_token_expires_at: { $gt: new Date() },
    }).sort({ created_at: -1 });

    if (!otpDoc) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'โทเค็นยืนยันไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขอรหัส OTP ใหม่อีกครั้ง',
      });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+token_version');
    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'ไม่พบผู้ใช้งาน',
      });
    }

    user.password = newPassword;
    user.failed_login_attempts = 0;
    user.lock_until = null;
    await user.save();

    // Consume all OTP/reset records for this email so the token cannot be reused.
    await OTP.deleteMany({ email: normalizedEmail });

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
