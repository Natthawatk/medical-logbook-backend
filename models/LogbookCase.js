const mongoose = require('mongoose');

const { Schema } = mongoose;

const logbookCaseSchema = new Schema(
  {
    student_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    procedure_id: {
      type: Schema.Types.ObjectId,
      ref: 'Procedure',
      required: true,
    },
    preceptor_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    location_id: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
    },
    case_date: {
      type: Date,
      default: Date.now,
    },
    case_data: {
      type: Schema.Types.Mixed, // dynamic data matching form_structure
      required: true,
    },
    evaluation_status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    evaluation_result: {
      type: Number, // score
    },
    feedback: {
      type: String,
    },
    evaluated_at: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('LogbookCase', logbookCaseSchema);

