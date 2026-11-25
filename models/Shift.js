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
    on_site_verifier_name: {
      type: String,
      trim: true,
      default: '',
    },
    on_site_verifier_position: {
      type: String,
      trim: true,
      default: '',
    },
    on_site_verifier_phone: {
      type: String,
      trim: true,
      default: '',
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

shiftSchema.index({ preceptor_id: 1, shift_date: -1, createdAt: -1 });
shiftSchema.index({ preceptor_id: 1, verify_status: 1, createdAt: -1 });
shiftSchema.index({ preceptor_id: 1, course_id: 1, verify_status: 1 });
shiftSchema.index({ student_id: 1, shift_date: -1, createdAt: -1 });
shiftSchema.index({ student_id: 1, verify_status: 1, shift_status: 1 });
shiftSchema.index({ student_id: 1, course_id: 1, verify_status: 1 });
shiftSchema.index({ course_id: 1, student_id: 1, verify_status: 1 });
shiftSchema.index({ location_id: 1, verify_status: 1 });

module.exports = mongoose.model('Shift', shiftSchema);
