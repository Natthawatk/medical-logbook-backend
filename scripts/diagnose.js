require('dotenv').config();
const mongoose = require('mongoose');
const Course = require('../models/Course');
const Procedure = require('../models/Procedure');
const LogbookCase = require('../models/LogbookCase');
const User = require('../models/User');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function diagnose() {
  try {
    await mongoose.connect(mongoUri);
    console.log('--- Diagnosis Report ---');

    // 1. Find Somchai
    const somchai = await User.findOne({ firstname_lastname: /สมชาย/ });
    if (!somchai) return console.log('Somchai not found');
    console.log(`Student: ${somchai.firstname_lastname} (${somchai._id})`);
    console.log(`Enrolled Courses: ${somchai.enrolled_courses}`);

    // 2. Find his cases
    const cases = await LogbookCase.find({ student_id: somchai._id }).populate('procedure_id');
    console.log(`Found ${cases.length} cases for Somchai.`);
    
    for (const c of cases) {
      console.log(`- Case ID: ${c._id}, Status: ${c.evaluation_status}, Procedure: ${c.procedure_id?.procedure_name} (${c.procedure_id?._id})`);
      if (c.procedure_id) {
        const courseId = c.procedure_id.course_id;
        const course = await Course.findById(courseId);
        console.log(`  Linked to Course: ${course?.course_name} (${courseId})`);
        console.log(`  Course enrolled_procedures: ${course?.enrolled_procedures}`);
        
        // Check procedures belonging to this course
        const proceduresInDB = await Procedure.find({ course_id: courseId });
        console.log(`  Procedures in DB for this course: ${proceduresInDB.length}`);
      }
    }

  } catch (err) {
    console.error('Diagnosis error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

diagnose();
