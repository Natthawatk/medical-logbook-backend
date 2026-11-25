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
      type: String, // HMAC-SHA256 hash
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
    attempts: {
      type: Number,
      default: 0,
    },
    reset_token_hash: {
      type: String,
      default: null,
    },
    reset_token_expires_at: {
      type: Date,
      default: null,
    },
    created_at: {
      type: Date,
      default: Date.now,
      expires: 900, // Auto-delete OTP docs 15 minutes after creation
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

otpSchema.index({ email: 1, created_at: -1 });

module.exports = mongoose.model('OTP', otpSchema);

