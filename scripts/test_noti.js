require('dotenv').config();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
require('../models/User');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function testCreate() {
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to DB');

    // Find a student and a preceptor
    const User = require('../models/User');
    const student = await User.findOne({ role: 'student' });
    const preceptor = await User.findOne({ role: 'preceptor' });

    if (!student || !preceptor) {
      console.log('Student or Preceptor not found in DB');
      return;
    }

    console.log(`Using Student: ${student._id}, Preceptor: ${preceptor._id}`);

    const noti = await Notification.create({
      recipient_id: student._id,
      sender_id: preceptor._id,
      type: 'case_submitted',
      message: 'Test notification ' + new Date().toISOString()
    });

    console.log('Notification created successfully:', noti._id);

  } catch (err) {
    console.error('Error creating notification:', err);
  } finally {
    await mongoose.disconnect();
  }
}

testCreate();
