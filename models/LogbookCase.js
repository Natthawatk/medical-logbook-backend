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

logbookCaseSchema.index({ preceptor_id: 1, evaluation_status: 1, createdAt: -1 });
logbookCaseSchema.index({ preceptor_id: 1, createdAt: -1 });
logbookCaseSchema.index({ preceptor_id: 1, evaluation_status: 1, evaluated_at: -1 });
logbookCaseSchema.index({ preceptor_id: 1, procedure_id: 1, evaluation_status: 1 });
logbookCaseSchema.index({ student_id: 1, createdAt: -1 });
logbookCaseSchema.index({ student_id: 1, case_date: -1, createdAt: -1 });
logbookCaseSchema.index({ student_id: 1, procedure_id: 1, evaluation_status: 1 });
logbookCaseSchema.index({ student_id: 1, evaluation_status: 1, evaluated_at: -1 });
logbookCaseSchema.index({ procedure_id: 1, evaluation_status: 1 });
logbookCaseSchema.index({ evaluation_status: 1, evaluated_at: -1 });
logbookCaseSchema.index({ location_id: 1, evaluation_status: 1 });

module.exports = mongoose.model('LogbookCase', logbookCaseSchema);

