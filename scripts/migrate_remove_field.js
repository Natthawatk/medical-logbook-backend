require('dotenv').config();
const mongoose = require('mongoose');
const Course = require('../models/Course');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function removeProcedureCountField() {
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // ใช้ $unset เพื่อลบฟิลด์ออกจากทุก Document ใน collection
    const result = await Course.updateMany(
      {}, 
      { $unset: { procedure_count: "" } }
    );

    console.log(`Successfully removed "procedure_count" from ${result.nModified || result.modifiedCount} documents.`);
    console.log('Done!');

  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

removeProcedureCountField();
