require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const LogbookCase = require('../models/LogbookCase');
const Procedure = require('../models/Procedure');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function fixSomchaiData() {
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // 1. ค้นหา User "สมชาย" (หรือ User ที่เราต้องการแก้)
    // ผมจะค้นหาจากชื่อที่มีคำว่า "สมชาย"
    const somchai = await User.findOne({ firstname_lastname: /สมชาย/ });

    if (!somchai) {
      console.log('User "สมชาย" not found. Please check the name in database.');
      return;
    }

    console.log(`Found User: ${somchai.firstname_lastname} (${somchai._id})`);

    // 2. ค้นหาเคสทั้งหมดที่สมชายเคยบันทึก
    const cases = await LogbookCase.find({ student_id: somchai._id }).populate('procedure_id');
    
    if (cases.length === 0) {
      console.log('No cases found for Somchai.');
      return;
    }

    // 3. รวบรวม Course ID จากหัตถการในเคสเหล่านั้น
    const courseIdsToEnroll = new Set();
    cases.forEach(c => {
      if (c.procedure_id && c.procedure_id.course_id) {
        courseIdsToEnroll.add(c.procedure_id.course_id.toString());
      }
    });

    console.log(`Found ${courseIdsToEnroll.size} unique courses from existing cases.`);

    // 4. อัปเดต enrolled_courses ของสมชาย
    const currentEnrolled = somchai.enrolled_courses.map(id => id.toString());
    const finalEnrolled = Array.from(new Set([...currentEnrolled, ...Array.from(courseIdsToEnroll)]));

    somchai.enrolled_courses = finalEnrolled;
    await somchai.save();

    console.log(`Successfully enrolled Somchai in ${finalEnrolled.length} courses total.`);
    console.log('Done!');

  } catch (err) {
    console.error('Error fixing data:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

fixSomchaiData();
