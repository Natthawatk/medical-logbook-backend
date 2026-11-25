const mongoose = require('mongoose');

const { Schema } = mongoose;

const courseLocationSchema = new Schema(
  {
    course_id: { type: Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    location_id: { type: Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
    added_by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: true }
);

courseLocationSchema.index({ course_id: 1, location_id: 1 }, { unique: true });
courseLocationSchema.index({ course_id: 1, status: 1, location_id: 1 });

module.exports = mongoose.model('CourseLocation', courseLocationSchema);
