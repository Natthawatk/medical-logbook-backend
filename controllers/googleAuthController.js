const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET } = require('../config/environment');
const { asTrimmedString } = require('../middlewares/securityMiddleware');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

exports.googleLogin = async (req, res) => {
  try {
    const idToken = asTrimmedString(req.body?.idToken);

    if (!idToken) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'กรุณาระบุ Google ID Token',
      });
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email || payload.email_verified !== true) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'อีเมลจาก Google ยังไม่ผ่านการยืนยันตัวตน',
      });
    }

    const { sub: google_id, email, picture } = payload;
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+token_version');

    if (!user) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'ไม่พบบัญชีผู้ใช้ในระบบ หรือไม่ได้รับอนุญาตให้เข้าใช้งาน',
      });
    }

    if (user.academic_status === 'inactive') {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
      });
    }

    let isModified = false;
    if (!user.google_id) {
      user.google_id = google_id;
      isModified = true;
    }

    if (!user.profile_image && picture) {
      user.profile_image = picture;
      isModified = true;
    }

    if (isModified) {
      await user.save();
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
      profile_image: user.profile_image,
    };

    return res.status(200).json({
      success: true,
      data: {
        token,
        user: safeUser,
      },
      message: 'เข้าสู่ระบบด้วย Google สำเร็จ',
    });
  } catch (error) {
    console.error('Google Login Error:', error);
    return res.status(401).json({
      success: false,
      data: null,
      message: 'การยืนยันตัวตนกับ Google ล้มเหลว',
    });
  }
};
