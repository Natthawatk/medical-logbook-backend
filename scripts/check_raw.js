require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Course = require('../models/Course');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function checkRaw() {
  try {
    await mongoose.connect(mongoUri);
    const student = await User.findOne({ role: 'student' });
    console.log('Raw enrolled_courses IDs:', student.enrolled_courses);
    
    if (student.enrolled_courses && student.enrolled_courses.length > 0) {
      const course = await Course.findById(student.enrolled_courses[0]);
      console.log('Course found by ID:', course ? course.course_name : 'NOT FOUND');
      if (course) {
        console.log('Course is_archived:', course.is_archived);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

checkRaw();
