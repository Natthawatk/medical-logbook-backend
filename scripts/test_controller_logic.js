require('dotenv').config();
const mongoose = require('mongoose');
const LogbookCase = require('../models/LogbookCase');
const Procedure = require('../models/Procedure');
const User = require('../models/User');
const { createNotification } = require('../controllers/notificationController');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function testControllerLogic() {
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to DB');

    const student = await User.findOne({ role: 'student' });
    const preceptor = await User.findOne({ role: 'preceptor' });
    const procedure = await Procedure.findOne();

    if (!student || !preceptor || !procedure) {
      console.log('Missing data for test');
      return;
    }

    console.log('Testing notification creation for student and preceptor...');

    const createdCase = await LogbookCase.create({
      student_id: student._id,
      procedure_id: procedure._id,
      preceptor_id: preceptor._id,
      case_data: { test: true },
      evaluation_status: 'pending',
    });

    console.log('Case created:', createdCase._id);

    // Simulate the logic in createCase
    await createNotification({
      recipient_id: preceptor._id,
      sender_id: student._id,
      target_id: createdCase._id,
      type: 'case_submitted',
      message: 'A new logbook case has been submitted for your evaluation.',
    });

    await createNotification({
      recipient_id: student._id,
      sender_id: student._id,
      target_id: createdCase._id,
      type: 'case_submitted',
      message: `บันทึกเคส ${procedure.procedure_name} เรียบร้อยแล้ว รอดำเนินการประเมิน`,
    });

    console.log('Notifications should be created now.');

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

testControllerLogic();
