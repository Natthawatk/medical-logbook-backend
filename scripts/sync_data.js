require('dotenv').config();
const mongoose = require('mongoose');
const Course = require('../models/Course');
const Procedure = require('../models/Procedure');
const User = require('../models/User');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function syncData() {
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // 1. หาข้อมูลนักศึกษา
    const somchai = await User.findOne({ firstname_lastname: /สมชาย/ });
    if (!somchai) return console.log('Somchai not found');

    // 2. ค้นหา Procedures ทั้งหมดใน DB และจัดกลุ่มตาม Course ID
    const allProcedures = await Procedure.find({});
    const courseProcedureMap = {};
    
    allProcedures.forEach(p => {
      const cid = p.course_id.toString();
      if (!courseProcedureMap[cid]) courseProcedureMap[cid] = [];
      courseProcedureMap[cid].push(p._id);
    });

    // 3. อัปเดตข้อมูล enrolled_procedures ในทุกวิชาที่เกี่ยวข้อง
    for (const [courseId, procIds] of Object.entries(courseProcedureMap)) {
      await Course.findByIdAndUpdate(courseId, {
        $set: { enrolled_procedures: procIds }
      });
      console.log(`Updated course ${courseId} with ${procIds.length} procedures.`);
    }

    // 4. ตรวจสอบว่าสมชาย enroll วิชานี้หรือยัง (ทำเผื่อไว้)
    const relevantCourseIds = Object.keys(courseProcedureMap);
    const currentEnrolled = somchai.enrolled_courses.map(id => id.toString());
    const finalEnrolled = Array.from(new Set([...currentEnrolled, ...relevantCourseIds]));
    
    somchai.enrolled_courses = finalEnrolled;
    await somchai.save();

    console.log('Successfully synced all data.');

  } catch (err) {
    console.error('Sync error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

syncData();
