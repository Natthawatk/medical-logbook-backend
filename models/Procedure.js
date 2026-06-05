const mongoose = require('mongoose');

const { Schema } = mongoose;

const formFieldSchema = new Schema(
  {
    field_name: {
      type: String,
      required: true,
    },
    field_type: {
      type: String,
      required: true,
    },
    is_required: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const procedureSchema = new Schema(
  {
    course_id: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    procedure_name: {
      type: String,
      required: true,
      trim: true,
    },
    target_score: {
      type: Number,
      required: true,
    },
    required_cases: {
      type: Number,
      required: true,
    },
    form_structure: {
      type: [formFieldSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Procedure', procedureSchema);

