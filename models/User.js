const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      // Password is optional for Google Auth users
      required: false,
      select: false,
    },
    google_id: {
      type: String,
      unique: true,
      sparse: true, // Only for users who have linked Google account
    },
    role: {
      type: String,
      enum: ['student', 'preceptor', 'course_instructor', 'admin'],
      required: true,
      immutable: true,
    },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    firstname_lastname: {
      type: String,
      required: true,
      trim: true,
    },
    phone_number: {
      type: String,
    },
    profile_image: {
      // Store only URL/path strings. Do NOT store Base64/binary image data here.
      type: String,
    },
    student_id: {
      type: String,
      required: function () {
        return this.role === 'student';
      },
    },
    workplace: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      required: false,
      // Legacy only: access is now based on CourseAssignment.
    },
    year: {
      type: Number, // Academic year
    },
    semester: {
      type: String,
      trim: true, // Shared field: can be stored for both student and preceptor
    },
    academic_status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    is_shared_account: {
      type: Boolean,
      default: false,
      index: true,
    },
    shared_location_id: {
      type: Schema.Types.ObjectId,
      ref: 'Location',
      default: null,
    },
    enrolled_courses: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Course',
      },
    ],
    failed_login_attempts: {
      type: Number,
      default: 0,
      select: false,
    },
    lock_until: {
      type: Date,
      default: null,
      select: false,
    },
    token_version: {
      type: Number,
      default: 0,
      select: false,
    },
    must_change_password: {
      type: Boolean,
      default: false,
    },
    notification_preferences: {
      push_categories: {
        cases: { type: Boolean, default: true },
        shifts: { type: Boolean, default: true },
        course_updates: { type: Boolean, default: true },
        admin_ops: { type: Boolean, default: true },
        security: { type: Boolean, default: true },
      },
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ role: 1, academic_status: 1 });
userSchema.index({ role: 1, enrolled_courses: 1 });

// Hash password before save if modified
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    if (!this.isNew) {
      this.token_version = (this.token_version || 0) + 1;
    }

    // Avoid double-hashing if controller already hashed the password.
    // bcrypt hashes typically start with $2a$, $2b$, $2y$ ...
    const isBcryptHashed =
      typeof this.password === 'string' && /^\$2[abyxy]\$/.test(this.password);

    if (!isBcryptHashed) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Helper method for verifying password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
