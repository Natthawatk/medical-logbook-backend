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
      enum: ['student', 'preceptor', 'admin'],
      required: true,
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
      enum: ['active', 'graduated', 'inactive'],
      default: 'active',
    },
    enrolled_courses: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Course',
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Hash password before save if modified
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
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

