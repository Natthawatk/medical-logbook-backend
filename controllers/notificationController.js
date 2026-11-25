const Notification = require('../models/Notification');
const CourseAssignment = require('../models/CourseAssignment');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const { getVapidPublicKey, sendPushToUser } = require('../services/webPushService');

const resolveNotificationPresentation = (type, targetId, actionUrl) => {
  const idStr = targetId ? String(targetId) : '';
  switch (type) {
    case 'case_evaluated':
      return {
        title: 'ผลการประเมินหัตถการ',
        url: actionUrl || (idStr ? `/logbook-cases/${idStr}` : '/logbook-cases'),
      };
    case 'case_submitted':
      return {
        title: 'มีเคสใหม่รอประเมิน',
        url: actionUrl || (idStr ? `/logbook-cases/${idStr}` : '/evaluate-procedures'),
      };
    case 'shift_checkin':
    case 'shift_requested':
      return {
        title: 'มีรายการลงเวลาเข้าเวร',
        url: actionUrl || '/verify-shifts',
      };
    case 'shift_verified':
      return {
        title: 'ผลการยืนยันการเข้าเวร',
        url: actionUrl || '/check-in',
      };
    case 'instructor_case_failed':
      return {
        title: 'นักศึกษาไม่ผ่านการประเมิน',
        url: actionUrl || (idStr ? `/logbook-cases/${idStr}` : '/admin/progress'),
      };
    case 'instructor_shift_alert':
      return {
        title: 'แจ้งเตือนการเข้าเวรนักศึกษา',
        url: actionUrl || '/admin/progress',
      };
    case 'instructor_course_completed':
      return {
        title: 'นักศึกษาทำเคสครบทุกหัตถการ',
        url: actionUrl || '/admin/progress',
      };
    case 'student_course_completed':
      return {
        title: 'ยินดีด้วย! ทำเคสครบทุกหัตถการ',
        url: actionUrl || '/logbook-cases',
      };
    case 'admin_account_alert':
      return {
        title: 'จัดการรายชื่อบัญชีผู้ใช้',
        url: actionUrl || '/admin/accounts',
      };
    case 'admin_location_alert':
      return {
        title: 'จัดการสถานที่ปฏิบัติงาน',
        url: actionUrl || '/admin/locations',
      };
    case 'admin_course_alert':
      return {
        title: 'จัดการรายวิชาและหัตถการ',
        url: actionUrl || '/admin/courses',
      };
    case 'course_membership_changed':
      return {
        title: 'อัปเดตรายชื่อในรายวิชา',
        url: actionUrl || '/notifications',
      };
    case 'course_procedure_updated':
      return {
        title: 'อัปเดตหัตถการในรายวิชา',
        url: actionUrl || '/logbook-cases',
      };
    case 'pending_backlog_alert':
      return {
        title: 'แจ้งเตือนรายการค้างตรวจสอบ',
        url: actionUrl || '/evaluate-procedures',
      };
    case 'instructor_attendance_threshold':
      return {
        title: 'แจ้งเตือนการเข้าเวรสะสมเกินเกณฑ์',
        url: actionUrl || '/admin/progress',
      };
    case 'admin_security_alert':
      return {
        title: 'แจ้งเตือนความปลอดภัยบัญชี',
        url: actionUrl || '/admin/accounts',
      };
    default:
      return {
        title: 'Medical Logbook',
        url: actionUrl || '/notifications',
      };
  }
};

const DEFAULT_PUSH_CATEGORIES = {
  cases: true,
  shifts: true,
  course_updates: true,
  admin_ops: true,
  security: true,
};

const getPreferenceCategoryForType = (type) => {
  if (
    type === 'case_submitted' ||
    type === 'case_evaluated' ||
    type === 'instructor_case_failed' ||
    type === 'instructor_course_completed' ||
    type === 'student_course_completed'
  ) {
    return 'cases';
  }
  if (
    type === 'shift_checkin' ||
    type === 'shift_requested' ||
    type === 'shift_verified' ||
    type === 'instructor_shift_alert' ||
    type === 'instructor_attendance_threshold'
  ) {
    return 'shifts';
  }
  if (
    type === 'course_membership_changed' ||
    type === 'course_procedure_updated' ||
    type === 'pending_backlog_alert'
  ) {
    return 'course_updates';
  }
  if (type === 'admin_security_alert') {
    return 'security';
  }
  return 'admin_ops';
};

exports.getActorLabel = async (userId) => {
  try {
    if (!userId) return 'ผู้ดูแลระบบ';
    const actor = await User.findById(userId).select('firstname_lastname role').lean();
    if (!actor) return 'ผู้ดูแลระบบ';
    return actor.firstname_lastname || (actor.role === 'admin' ? 'แอดมิน' : 'อาจารย์');
  } catch {
    return 'ผู้ดูแลระบบ';
  }
};

exports.createNotification = async ({
  recipient_id,
  sender_id,
  type,
  message,
  target_id,
  action_url,
  severity = 'info',
  sendPush = true,
  allowSelfPush = false,
}) => {
  try {
    let pushCategoryEnabled = true;
    if (sendPush !== false && recipient_id) {
      const recipient = await User.findById(recipient_id)
        .select('notification_preferences')
        .lean();
      const cat = getPreferenceCategoryForType(type);
      if (recipient?.notification_preferences?.push_categories?.[cat] === false) {
        pushCategoryEnabled = false;
      }
    }
    const effectiveSendPush = sendPush !== false && pushCategoryEnabled;

    // 1. Create the new notification
    const newNoti = await Notification.create({
      recipient_id,
      sender_id,
      target_id,
      type,
      message,
      severity,
      send_push: effectiveSendPush,
      ...(action_url ? { action_url } : {}),
    });

    // 2. AGGRESSIVE CLEANUP for 512MB DB limit
    // A. Delete read notifications older than 3 days
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    await Notification.deleteMany({
      recipient_id,
      is_read: true,
      created_at: { $lt: threeDaysAgo }
    });

    // B. Cap total notifications per user to 30
    const MAX_NOTIFICATIONS = 30;
    const userNotis = await Notification.find({ recipient_id })
      .sort({ created_at: -1 })
      .skip(MAX_NOTIFICATIONS)
      .select('_id');

    if (userNotis.length > 0) {
      const idsToDelete = userNotis.map(n => n._id);
      await Notification.deleteMany({ _id: { $in: idsToDelete } });
    }

    const isSelfNotification = !allowSelfPush && sender_id && String(recipient_id) === String(sender_id);
    if (!isSelfNotification && effectiveSendPush) {
      const presentation = resolveNotificationPresentation(type, target_id, action_url);
      void sendPushToUser({
        recipientId: recipient_id,
        title: presentation.title,
        body: message,
        url: presentation.url,
        tag: `noti-${newNoti._id}`,
        notificationId: newNoti._id,
      });
    }

    return newNoti;
  } catch (err) {
    console.error('Create notification with cleanup error:', err);
    // Return null or rethrow based on how you want to handle failures in background tasks
    return null;
  }
};

exports.notifyCourseInstructors = async ({
  courseId,
  senderId,
  targetId,
  type,
  message,
  actionUrl,
  severity = 'info',
  sendPush = true,
}) => {
  try {
    if (!courseId) return [];
    const instructorIds = await CourseAssignment.find({
      course_id: courseId,
      assignment_role: 'course_instructor',
      status: 'active',
    }).distinct('user_id');

    const uniqueRecipientIds = [...new Set(instructorIds.map(String))].filter(
      (uid) => !senderId || uid !== String(senderId)
    );
    if (uniqueRecipientIds.length === 0) return [];

    return await Promise.all(
      uniqueRecipientIds.map((recipientId) =>
        exports.createNotification({
          recipient_id: recipientId,
          sender_id: senderId || recipientId,
          target_id: targetId,
          type,
          message,
          action_url: actionUrl,
          severity,
          sendPush,
        })
      )
    );
  } catch (err) {
    console.error('Notify course instructors error:', err);
    return [];
  }
};

exports.notifyAdmins = async ({
  senderId,
  targetId,
  type,
  message,
  actionUrl,
  severity = 'info',
  sendPush = true,
}) => {
  try {
    const admins = await User.find({ role: 'admin', academic_status: 'active' })
      .select('_id')
      .lean();

    const recipientIds = admins
      .map((admin) => String(admin._id))
      .filter((uid) => !senderId || uid !== String(senderId));

    if (recipientIds.length === 0) return [];

    return await Promise.all(
      recipientIds.map((recipientId) =>
        exports.createNotification({
          recipient_id: recipientId,
          sender_id: senderId || recipientId,
          target_id: targetId,
          type,
          message,
          action_url: actionUrl,
          severity,
          sendPush,
        })
      )
    );
  } catch (err) {
    console.error('Notify admins error:', err);
    return [];
  }
};

exports.getMyNotifications = async (req, res) => {
  try {
    const isSummary = req.query.summary === '1' || req.query.summary === 'true';
    const unreadOnly = req.query.unreadOnly === '1' || req.query.unreadOnly === 'true';
    const requestedLimit = Number.parseInt(String(req.query.limit || ''), 10);
    const defaultLimit = isSummary ? 20 : 200;
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 200)
      : defaultLimit;

    const filter = {
      recipient_id: req.user.id,
      ...(unreadOnly ? { is_read: false } : {}),
    };

    if (isSummary) {
      const notifications = await Notification.find(filter)
        .select('_id type message is_read severity send_push sender_id target_id action_url created_at')
        .sort({ created_at: -1 })
        .limit(limit)
        .lean();

      return res.status(200).json({
        success: true,
        data: notifications,
        message: 'Notifications fetched successfully.',
      });
    }

    const notifications = await Notification.find(filter)
      .populate('sender_id', 'firstname_lastname email role')
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: notifications,
      message: 'Notifications fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get my notifications error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching notifications.',
    });
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const recipientId = req.user._id || req.user.id;
    const count = await Notification.countDocuments({
      recipient_id: recipientId,
      is_read: false,
    });

    return res.status(200).json({
      success: true,
      count,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get unread notification count error:', err);
    return res.status(500).json({
      success: false,
      count: 0,
    });
  }
};

exports.markNotificationAsRead = async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Notification not found.',
      });
    }

    if (String(notification.recipient_id) !== String(req.user.id)) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'You do not have permission to update this notification.',
      });
    }

    notification.is_read = true;
    await notification.save();

    return res.status(200).json({
      success: true,
      data: notification,
      message: 'Notification marked as read.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Mark notification as read error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while updating notification.',
    });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { recipient_id: req.user.id, is_read: false },
      { $set: { is_read: true } }
    );

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} notifications marked as read.`,
    });
  } catch (err) {
    console.error('Mark all notifications as read error:', err);
    return res.status(500).json({
      success: false,
      message: 'An unexpected error occurred while updating notifications.',
    });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Notification.findOneAndDelete({
      _id: id,
      recipient_id: req.user.id,
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบการแจ้งเตือนนี้',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'ปิดการแจ้งเตือนเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Delete notification error:', err);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถลบการแจ้งเตือนได้',
    });
  }
};

exports.clearReadNotifications = async (req, res) => {
  try {
    const result = await Notification.deleteMany({
      recipient_id: req.user.id,
      is_read: true,
    });

    return res.status(200).json({
      success: true,
      deletedCount: result.deletedCount || 0,
      message: 'ล้างการแจ้งเตือนที่อ่านแล้วเรียบร้อย',
    });
  } catch (err) {
    console.error('Clear read notifications error:', err);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถล้างการแจ้งเตือนได้',
    });
  }
};

exports.getPushPublicKey = async (_req, res) => {
  try {
    const publicKey = await getVapidPublicKey();
    return res.status(200).json({
      success: true,
      publicKey,
    });
  } catch (err) {
    console.error('Get push public key error:', err);
    return res.status(500).json({
      success: false,
      publicKey: null,
      message: 'ไม่สามารถดึงกุญแจการแจ้งเตือนได้',
    });
  }
};

exports.subscribePush = async (req, res) => {
  try {
    const subscription = req.body?.subscription || req.body;
    const endpoint = String(subscription?.endpoint || '').trim();
    const p256dh = String(subscription?.keys?.p256dh || '').trim();
    const auth = String(subscription?.keys?.auth || '').trim();

    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({
        success: false,
        message: 'ข้อมูลการสมัครรับแจ้งเตือนนอกแอพไม่ครบถ้วน',
      });
    }
    let parsedEndpoint;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      parsedEndpoint = null;
    }
    if (!parsedEndpoint || !['https:', 'http:'].includes(parsedEndpoint.protocol)) {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบ Endpoint ของการแจ้งเตือนไม่ถูกต้อง',
      });
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        $set: {
          user_id: req.user.id,
          endpoint,
          keys: { p256dh, auth },
          user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
          updated_at: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      success: true,
      message: 'เปิดใช้งานการแจ้งเตือนนอกแอพเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Subscribe push error:', err);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถบันทึกการแจ้งเตือนนอกแอพได้',
    });
  }
};

exports.unsubscribePush = async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || '').trim();
    const query = endpoint
      ? { user_id: req.user.id, endpoint }
      : { user_id: req.user.id };

    await PushSubscription.deleteMany(query);

    return res.status(200).json({
      success: true,
      message: 'ปิดการแจ้งเตือนนอกแอพเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Unsubscribe push error:', err);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถปิดการแจ้งเตือนนอกแอพได้',
    });
  }
};

exports.testPush = async (req, res) => {
  try {
    const summary = await sendPushToUser({
      recipientId: req.user.id,
      title: 'ทดสอบการแจ้งเตือน Medical Logbook',
      body: 'ระบบการแจ้งเตือนนอกแอพ (Web Push) พร้อมใช้งานแล้ว',
      url: '/notifications',
      tag: `test-push-${Date.now()}`,
    });

    if (summary.attempted === 0) {
      return res.status(400).json({
        success: false,
        data: summary,
        message: 'ไม่พบอุปกรณ์ที่ลงทะเบียนรับ Push กรุณากดเปิดแจ้งเตือนใหม่อีกครั้ง',
      });
    }

    if (summary.delivered === 0) {
      return res.status(502).json({
        success: false,
        data: summary,
        message: 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ กรุณารีเซ็ตสิทธิ์การแจ้งเตือนของเบราว์เซอร์',
      });
    }

    return res.status(200).json({
      success: true,
      data: summary,
      message: `ส่งแจ้งเตือนทดสอบไปยัง ${summary.delivered} อุปกรณ์เรียบร้อยแล้ว`,
    });
  } catch (err) {
    console.error('Test push error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'ไม่สามารถส่งแจ้งเตือนทดสอบได้',
    });
  }
};

exports.notifyCourseStudents = async ({
  courseId,
  senderId,
  targetId,
  type,
  message,
  actionUrl,
  severity = 'info',
  sendPush = false,
}) => {
  try {
    if (!courseId) return [];
    const studentIds = await CourseAssignment.find({
      course_id: courseId,
      assignment_role: 'student',
      status: 'active',
    }).distinct('user_id');

    const uniqueIds = [...new Set(studentIds.map(String))].filter(
      (uid) => !senderId || uid !== String(senderId)
    );
    if (uniqueIds.length === 0) return [];

    return await Promise.all(
      uniqueIds.map((recipientId) =>
        exports.createNotification({
          recipient_id: recipientId,
          sender_id: senderId || recipientId,
          target_id: targetId,
          type,
          message,
          action_url: actionUrl,
          severity,
          sendPush,
        })
      )
    );
  } catch (err) {
    console.error('Notify course students error:', err);
    return [];
  }
};

exports.getNotificationPreferences = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('notification_preferences').lean();
    const prefs = {
      ...DEFAULT_PUSH_CATEGORIES,
      ...(user?.notification_preferences?.push_categories || {}),
    };
    return res.status(200).json({
      success: true,
      data: { push_categories: prefs },
    });
  } catch (err) {
    console.error('Get notification preferences error:', err);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถดึงการตั้งค่าการแจ้งเตือนได้',
    });
  }
};

exports.updateNotificationPreferences = async (req, res) => {
  try {
    const incoming = req.body?.push_categories || {};
    const updateSet = {};
    for (const key of Object.keys(DEFAULT_PUSH_CATEGORIES)) {
      if (typeof incoming[key] === 'boolean') {
        updateSet[`notification_preferences.push_categories.${key}`] = incoming[key];
      }
    }

    const updated = Object.keys(updateSet).length > 0
      ? await User.findByIdAndUpdate(
          req.user.id,
          { $set: updateSet },
          { new: true, select: 'notification_preferences' }
        ).lean()
      : await User.findById(req.user.id).select('notification_preferences').lean();

    const prefs = {
      ...DEFAULT_PUSH_CATEGORIES,
      ...(updated?.notification_preferences?.push_categories || {}),
    };

    return res.status(200).json({
      success: true,
      data: { push_categories: prefs },
      message: 'บันทึกการตั้งค่าการแจ้งเตือนเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('Update notification preferences error:', err);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถบันทึกการตั้งค่าการแจ้งเตือนได้',
    });
  }
};
