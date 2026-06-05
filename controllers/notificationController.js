const Notification = require('../models/Notification');

exports.createNotification = async ({
  recipient_id,
  sender_id,
  type,
  message,
  target_id,
}) => {
  try {
    // 1. Create the new notification
    const newNoti = await Notification.create({
      recipient_id,
      sender_id,
      target_id,
      type,
      message,
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

    return newNoti;
  } catch (err) {
    console.error('Create notification with cleanup error:', err);
    // Return null or rethrow based on how you want to handle failures in background tasks
    return null;
  }
};

exports.getMyNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient_id: req.user.id })
      .populate('sender_id', 'firstname_lastname email role')
      .populate({
        path: 'target_id',
        model: 'LogbookCase',
        populate: {
          path: 'procedure_id',
          model: 'Procedure',
          select: 'procedure_name course_id',
          populate: {
            path: 'course_id',
            model: 'Course',
            select: 'course_name course_code'
          }
        }
      })
      .sort({ created_at: -1 });

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
