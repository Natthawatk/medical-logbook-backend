const mongoose = require('mongoose');

const { Schema } = mongoose;

const courseAssignmentSchema = new Schema(
  {
    course_id: { type: Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignment_role: {
      type: String,
      enum: ['student', 'preceptor', 'course_instructor'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    assigned_by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assigned_at: { type: Date, default: Date.now },
    revoked_at: { type: Date, default: null },
  },
  { timestamps: true }
);

courseAssignmentSchema.index(
  { course_id: 1, user_id: 1, assignment_role: 1 },
  { unique: true }
);

courseAssignmentSchema.pre('validate', async function validateRole() {
  if (!this.user_id || !this.assignment_role) return;

  const User = mongoose.model('User');
  const user = await User.findById(this.user_id).select('role').lean();
  if (!user) throw new Error('ไม่พบบัญชีผู้ใช้สำหรับ assignment นี้');
  if (user.role !== this.assignment_role) {
    throw new Error('บทบาทของ assignment ต้องตรงกับบทบาทถาวรของบัญชี');
  }
});

// Query upserts do not run document validation middleware. Validate the
// immutable account role here as well so every assignment creation path has
// the same invariant, including findOneAndUpdate(..., { upsert: true }).
courseAssignmentSchema.pre('findOneAndUpdate', async function validateRoleOnUpsert() {
  const filter = this.getFilter() || {};
  const update = this.getUpdate() || {};
  const values = { ...filter, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
  const userId = values.user_id;
  const assignmentRole = values.assignment_role;

  if (!userId || !assignmentRole || typeof userId === 'object' && !userId._bsontype) return;

  const User = mongoose.model('User');
  const user = await User.findById(userId).select('role').lean();
  if (!user) throw new Error('ไม่พบบัญชีผู้ใช้สำหรับ assignment นี้');
  if (user.role !== assignmentRole) {
    throw new Error('บทบาทของ assignment ต้องตรงกับบทบาทถาวรของบัญชี');
  }
});

module.exports = mongoose.model('CourseAssignment', courseAssignmentSchema);
