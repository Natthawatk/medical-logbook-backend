const mongoose = require('mongoose');

const { Schema } = mongoose;

const pushSubscriptionSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    user_agent: {
      type: String,
      default: '',
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
