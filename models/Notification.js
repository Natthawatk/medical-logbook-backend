const mongoose = require('mongoose');

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    recipient_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    sender_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    target_id: {
      type: Schema.Types.ObjectId,
      ref: 'LogbookCase',
    },
    type: {
      type: String,
      enum: [
        'case_submitted',
        'case_evaluated',
        'shift_checkin',
        'shift_requested',
        'shift_verified',
        'instructor_case_failed',
        'instructor_shift_alert',
        'instructor_course_completed',
        'student_course_completed',
        'course_membership_changed',
        'course_procedure_updated',
        'pending_backlog_alert',
        'instructor_attendance_threshold',
        'admin_account_alert',
        'admin_location_alert',
        'admin_course_alert',
        'admin_security_alert',
        'system',
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ['info', 'success', 'warning', 'danger'],
      default: 'info',
    },
    send_push: {
      type: Boolean,
      default: true,
    },
    action_url: {
      type: String,
      trim: true,
    },
    message: {
      type: String,
      required: true,
    },
    is_read: {
      type: Boolean,
      default: false,
    },
    created_at: {
      type: Date,
      default: Date.now,
      expires: 604800, // Auto-delete all notifications after 7 days (60*60*24*7)
    },
  },
  {
    timestamps: false,
  }
);

notificationSchema.index({ recipient_id: 1, created_at: -1 });
notificationSchema.index({ recipient_id: 1, is_read: 1, created_at: -1 });
notificationSchema.index({ type: 1, created_at: -1 });

module.exports = mongoose.model('Notification', notificationSchema);

