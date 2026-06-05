const mongoose = require('mongoose');

const { Schema } = mongoose;

const otpSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    otp_code: {
      type: String, // hashed
      required: true,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    is_used: {
      type: Boolean,
      default: false,
    },
    created_at: {
      type: Date,
      default: Date.now,
      expires: 300, // Auto-delete OTP docs 5 minutes after creation
    },
  },
  {
    timestamps: false,
  }
);

module.exports = mongoose.model('OTP', otpSchema);

