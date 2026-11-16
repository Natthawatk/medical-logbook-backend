const mongoose = require('mongoose');

const { Schema } = mongoose;

const shiftSchema = new Schema(
  {
    course_id: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: function requireCourseForNewShift() {
        return !this.is_legacy;
      },
      index: true,
    },
    is_legacy: {
      type: Boolean,
      default: false,
      index: true,
    },
    student_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    location_id: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
    },
    preceptor_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    shift_date: {
      type: Date,
      required: true,
    },
    Check_in_lat: {
      type: Number,
      required: true,
    },
    Check_in_lng: {
      type: Number,
      required: true,
    },
    shift_status: {
      type: String,
      enum: ['normal', 'late', 'absent', 'leave'], // Currently using normal and late
      required: true,
    },
    verify_status: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending',
    },
    verified_at: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Shift', shiftSchema);

