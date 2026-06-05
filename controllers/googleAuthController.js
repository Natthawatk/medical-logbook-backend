const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

exports.googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุ Google ID Token',
      });
    }

    // Verify Google ID Token
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: google_id, email, name, picture } = payload;

    // Check if user exists in our system by email
    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // User not found in system - for this medical logbook, usually users are pre-registered by admin
      return res.status(404).json({
        success: false,
        message: 'ไม่พบอีเมลนี้ในระบบ กรุณาติดต่อผู้ดูแลระบบเพื่อลงทะเบียนเข้าใช้งาน',
      });
    }

    // If user exists, check academic status
    if (user.academic_status === 'inactive') {
      return res.status(403).json({
        success: false,
        message: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
      });
    }

    // Update user info if it's the first time linking Google or if info changed
    let isModified = false;
    if (!user.google_id) {
      user.google_id = google_id;
      isModified = true;
    }
    
    // Optional: update profile image if not set
    if (!user.profile_image && picture) {
      user.profile_image = picture;
      isModified = true;
    }

    if (isModified) {
      await user.save();
    }

    // Generate JWT
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
      profile_image: user.profile_image
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
      message: 'การยืนยันตัวตนกับ Google ล้มเหลว',
    });
  }
};
