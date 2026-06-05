require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
require('../models/Course');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function checkUserCourses() {
  try {
    await mongoose.connect(mongoUri);
    const student = await User.findOne({ role: 'student' }).populate('enrolled_courses');
    
    if (!student) {
      console.log('No student found');
      return;
    }

    console.log(`Student: ${student.firstname_lastname}`);
    console.log(`Enrolled Courses Count: ${student.enrolled_courses?.length || 0}`);
    
    student.enrolled_courses.forEach(c => {
      console.log(`- [${c.course_code}] ${c.course_name} (Year: ${c.year}, Sem: ${c.semester}, Archived: ${c.is_archived})`);
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

checkUserCourses();
