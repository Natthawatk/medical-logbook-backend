require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const LogbookCase = require('../models/LogbookCase');
const Procedure = require('../models/Procedure');
require('../models/Course');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function debugDashboard() {
  try {
    await mongoose.connect(mongoUri);
    const student = await User.findOne({ role: 'student' });
    if (!student) {
      console.log('No student found');
      return;
    }

    const studentId = student._id;
    console.log(`DEBUG: Student ID = ${studentId} (${student.firstname_lastname})`);

    // Step 1: Populate
    const userWithCourses = await User.findById(studentId).populate('enrolled_courses');

    console.log(`DEBUG: enrolled_courses length = ${userWithCourses.enrolled_courses?.length || 0}`);
    
    let activeCourses = (userWithCourses.enrolled_courses || []).filter(c => !c.is_archived);
    console.log(`DEBUG: activeCourses (non-archived) length = ${activeCourses.length}`);
    activeCourses.forEach(c => {
      console.log(`  - Course: ${c.course_name}, Year: ${c.year} (${typeof c.year}), Sem: ${c.semester}`);
    });

    if (activeCourses.length > 0) {
      const sortedByYearAndSemester = [...activeCourses].sort((a, b) => {
        const yearA = Number(a.year || 0);
        const yearB = Number(b.year || 0);
        if (yearA !== yearB) return yearB - yearA;
        
        const semA = String(a.semester || '');
        const semB = String(b.semester || '');
        return semB.localeCompare(semA);
      });
      
      const latestYear = sortedByYearAndSemester[0].year;
      const latestSemester = sortedByYearAndSemester[0].semester;
      console.log(`DEBUG: Latest Year = ${latestYear}, Latest Semester = ${latestSemester}`);

      activeCourses = activeCourses.filter(c => c.year === latestYear && c.semester === latestSemester);
      console.log(`DEBUG: activeCourses after filter = ${activeCourses.length}`);
    }

    const enrolledCourseIds = activeCourses.map(c => c._id);
    console.log(`DEBUG: enrolledCourseIds = ${enrolledCourseIds}`);

    // Step 2: Aggregations
    const approvedCasesPerCourse = await LogbookCase.aggregate([
      { 
        $match: { 
          student_id: studentId, 
          evaluation_status: 'approved' 
        } 
      },
      {
        $lookup: {
          from: 'procedures',
          localField: 'procedure_id',
          foreignField: '_id',
          as: 'procedure',
        },
      },
      { $unwind: '$procedure' },
      {
        $group: {
          _id: '$procedure.course_id',
          count: { $sum: 1 }
        }
      }
    ]);
    console.log(`DEBUG: approvedCasesPerCourse = ${JSON.stringify(approvedCasesPerCourse)}`);

    // Step 3: Procedures
    const allProceduresInActiveCourses = await Procedure.find({ course_id: { $in: enrolledCourseIds } });
    console.log(`DEBUG: allProceduresInActiveCourses count = ${allProceduresInActiveCourses.length}`);

  } catch (err) {
    console.error('DEBUG ERROR:', err);
  } finally {
    await mongoose.disconnect();
  }
}

debugDashboard();
