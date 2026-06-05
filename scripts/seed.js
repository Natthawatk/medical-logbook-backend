require('dotenv').config();

const mongoose = require('mongoose');

const User = require('../models/User');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

async function seed() {
  try {
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    // eslint-disable-next-line no-console
    console.log('Connected to MongoDB for seeding');

    await User.deleteMany({});
    // eslint-disable-next-line no-console
    console.log('Cleared users collection');

    // Admin user following Database-context.md: users collection
    const adminUser = await User.create({
      email: 'admin@example.com',
      password: 'password123', // will be hashed by User schema (bcryptjs) pre-save hook
      role: 'admin',
      firstname_lastname: 'Super Admin',
      phone_number: '',
      profile_image: '',
      year: null,
      semester: '',
    });

    // eslint-disable-next-line no-console
    console.log('Created default admin user:', {
      id: adminUser._id,
      email: adminUser.email,
      role: adminUser.role,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Seeding error:', err);
  } finally {
    await mongoose.disconnect();
    // eslint-disable-next-line no-console
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

seed();

