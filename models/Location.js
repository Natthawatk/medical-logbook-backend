const mongoose = require('mongoose');

const { Schema } = mongoose;

const savedVerifierSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    position: {
      type: String,
      trim: true,
      default: '',
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const locationSchema = new Schema(
  {
    created_by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    Location_name: {
      type: String,
      required: true,
      trim: true,
    },
    semester: {
      type: String,
      trim: true,
    },
    Location_image: {
      // Store only URL/path strings. Do NOT store Base64/binary image data here.
      type: String,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    radius: {
      type: Number, // meters
    },
    central_preceptor_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    saved_verifiers: {
      type: [savedVerifierSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

locationSchema.index({ central_preceptor_id: 1 });
locationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Location', locationSchema);
