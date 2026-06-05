require('dotenv').config();
const mongoose = require('mongoose');
const LogbookCase = require('../models/LogbookCase');
require('../models/Procedure');
require('../models/User');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function checkCases() {
  try {
    await mongoose.connect(mongoUri);
    console.log('--- Checking Recent Logbook Cases ---');

    const cases = await LogbookCase.find({})
      .populate('student_id', 'firstname_lastname')
      .populate('procedure_id', 'procedure_name')
      .sort({ createdAt: -1 })
      .limit(5);

    cases.forEach((c, i) => {
      console.log(`\nCase ${i + 1}:`);
      console.log(`- ID: ${c._id}`);
      console.log(`- Student: ${c.student_id?.firstname_lastname}`);
      console.log(`- Procedure: ${c.procedure_id?.procedure_name}`);
      console.log(`- Status: ${c.evaluation_status}`);
      console.log(`- Created At: ${c.createdAt}`);
    });

  } catch (err) {
    console.error('Check error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

checkCases();
