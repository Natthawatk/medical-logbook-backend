const bcrypt = require('bcryptjs');

const User = require('../models/User');
const OTP = require('../models/OTP');
const { invalidateAuthUserCache } = require('../middlewares/authMiddleware');
const { notifyAdmins } = require('./notificationController');
const { signAuthToken, buildSafeAuthUser } = require('../utils/authToken');
const {
  asString,
  asTrimmedString,
  validatePassword,
  hashScopedToken,
} = require('../middlewares/securityMiddleware');

const DUMMY_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const SILENT_ALERT_THRESHOLD = 5;
const FAILED_TRACKER_TTL_MS = 15 * 60 * 1000;
const failedAttemptTracker = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const recordFailedAttempt = (email) => {
  const now = Date.now();
  const entry = failedAttemptTracker.get(email);
  if (!entry || entry.expiresAt <= now) {
    const fresh = { count: 1, alerted: false, expiresAt: now + FAILED_TRACKER_TTL_MS };
    failedAttemptTracker.set(email, fresh);
    return fresh;
  }
  entry.count += 1;
  entry.expiresAt = now + FAILED_TRACKER_TTL_MS;
  return entry;
};

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
      // Constant-ish timing mitigation + progressive delay against user enumeration
      const attemptInfo = recordFailedAttempt(rawEmail);
      const delayMs = Math.min(1500, attemptInfo.count * 350);
      await Promise.all([
        bcrypt.compare(rawPassword, DUMMY_BCRYPT_HASH),
        sleep(delayMs),
      ]);
      return res.status(401).json({
        success: false,
        data: null,
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
      });
    }

    const isMatch = user.password
      ? await bcrypt.compare(rawPassword, user.password)
      : false;

    if (!isMatch) {
      const attemptInfo = recordFailedAttempt(rawEmail);
      const delayMs = Math.min(1500, attemptInfo.count * 350);

      if (attemptInfo.count >= SILENT_ALERT_THRESHOLD && !attemptInfo.alerted) {
        attemptInfo.alerted = true;
        notifyAdmins({
          senderId: user._id,
          type: 'admin_security_alert',
          severity: 'warning',
          sendPush: false,
          actionUrl: '/admin/accounts',
          message: `พบการใส่รหัสผ่านผิดติดต่อกัน ${attemptInfo.count} ครั้ง สำหรับบัญชี ${user.firstname_lastname || user.email} (${user.email}) ระบบไม่ได้ล็อกบัญชีเพื่อให้ผู้ใช้จริงยังเข้าใช้งานได้`,
        }).catch(() => {});
      }

      await sleep(delayMs);
      return res.status(401).json({
        success: false,
        data: null,
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
      });
    }

    failedAttemptTracker.delete(rawEmail);

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

    const rememberMe = req.body?.rememberMe !== false;
    const token = signAuthToken(user, { rememberMe });
    const safeUser = buildSafeAuthUser(user);

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

    const passwordPreError = validatePassword(newPassword, { email: normalizedEmail });
    if (passwordPreError) {
      return res.status(400).json({
        success: false,
        data: null,
        message: passwordPreError,
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
    if (user.is_shared_account) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'บัญชีกลางประจำสถานที่ต้องให้ผู้ดูแลระบบหรืออาจารย์ประจำรายวิชาเป็นผู้รีเซ็ตรหัสผ่าน',
      });
    }

    const passwordError = validatePassword(newPassword, {
      email: user.email,
      studentId: user.student_id,
    });
    if (passwordError) {
      return res.status(400).json({
        success: false,
        data: null,
        message: passwordError,
      });
    }

    user.password = newPassword;
    user.must_change_password = false;
    user.failed_login_attempts = 0;
    user.lock_until = null;
    await user.save();
    invalidateAuthUserCache(user._id);

    // Consume all OTP/reset records for this email so the token cannot be reused.
    await OTP.deleteMany({ email: normalizedEmail });

    if (user.role === 'admin' || user.role === 'course_instructor') {
      const roleLabel = user.role === 'admin' ? 'แอดมิน' : 'อาจารย์ผู้รับผิดชอบวิชา';
      await notifyAdmins({
        senderId: user._id,
        type: 'admin_security_alert',
        severity: 'warning',
        sendPush: true,
        actionUrl: '/admin/accounts',
        message: `บัญชี${roleLabel} ${user.firstname_lastname || user.email} (${user.email}) ทำการรีเซ็ตรหัสผ่านสำเร็จ`,
      });
    }

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

exports.refreshSession = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('email role firstname_lastname student_id profile_image is_shared_account must_change_password academic_status token_version')
      .lean();

    if (!user || user.academic_status === 'inactive') {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'เซสชันไม่สามารถต่ออายุได้',
      });
    }

    if (user.is_shared_account || req.authRemember === false) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'บัญชีนี้ต้องเข้าสู่ระบบใหม่เมื่อหมดอายุ',
      });
    }

    const token = signAuthToken(user, { rememberMe: true });
    return res.status(200).json({
      success: true,
      data: {
        token,
        user: buildSafeAuthUser(user),
      },
      message: 'ต่ออายุเซสชันสำเร็จ',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Refresh session error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'เกิดข้อผิดพลาดขณะต่ออายุเซสชัน',
    });
  }
};
