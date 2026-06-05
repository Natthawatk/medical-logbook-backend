const mongoose = require('mongoose');

const { Schema } = mongoose;

const courseSchema = new Schema(
  {
    course_code: {
      type: String,
      required: true,
      trim: true,
    },
    course_name: {
      type: String,
      required: true,
      trim: true,
    },
    semester: {
      type: String,
      trim: true,
    },
    year: {
      type: Number,
    },
    evaluation_type: {
      type: String,
      enum: ['Pass/Fail', '0-4'],
      required: true,
    },
    enrolled_students: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    enrolled_student_count: {
      type: Number,
      default: 0,
    },
    enrolled_locations: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Location',
      },
    ],
    is_archived: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Course', courseSchema);

