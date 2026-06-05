require('dotenv').config();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
require('../models/LogbookCase');
require('../models/Procedure');
require('../models/Course');
require('../models/User');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function checkNotifications() {
  try {
    await mongoose.connect(mongoUri);
    console.log('--- Checking Notifications Data ---');

    const notifications = await Notification.find({})
      .populate('sender_id', 'firstname_lastname')
      .populate('recipient_id', 'firstname_lastname')
      .populate({
        path: 'target_id',
        populate: {
          path: 'procedure_id',
          populate: {
            path: 'course_id'
          }
        }
      })
      .sort({ created_at: -1 });

    notifications.forEach((n, i) => {
      console.log(`\nNotification ${i + 1}:`);
      console.log(`- ID: ${n._id}`);
      console.log(`- Type: ${n.type}`);
      console.log(`- Message: ${n.message}`);
      console.log(`- Sender: ${n.sender_id?.firstname_lastname}`);
      console.log(`- Recipient: ${n.recipient_id?.firstname_lastname}`);
      
      if (n.target_id) {
        console.log(`- Target (LogbookCase) Found`);
        const proc = n.target_id.procedure_id;
        if (proc) {
          console.log(`  - Procedure Found: ${proc.procedure_name}`);
          const course = proc.course_id;
          if (course) {
            console.log(`    - Course Found: ${course.course_name} (${course.course_code})`);
          } else {
            console.log(`    - Course NOT Found (course_id: ${proc.course_id})`);
          }
        } else {
          console.log(`  - Procedure NOT Found (procedure_id: ${n.target_id.procedure_id})`);
        }
      } else {
        console.log(`- Target NOT Found (target_id: ${n.target_id})`);
      }
    });

  } catch (err) {
    console.error('Check error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

checkNotifications();
