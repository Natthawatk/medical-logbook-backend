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
      enum: ['case_submitted', 'case_evaluated', 'shift_checkin', 'shift_requested', 'shift_verified', 'system'],
      required: true,
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

module.exports = mongoose.model('Notification', notificationSchema);

