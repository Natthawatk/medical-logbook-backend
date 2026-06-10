require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');

const app = express();

// Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const locationRoutes = require('./routes/locationRoutes');
const courseRoutes = require('./routes/courseRoutes');
const procedureRoutes = require('./routes/procedureRoutes');
const logbookCaseRoutes = require('./routes/logbookCaseRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const shiftRoutes = require('./routes/shiftRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const otpRoutes = require('./routes/otpRoutes');

// Middleware
app.use(cors());
app.use(compression());
app.use(express.json());

// MongoDB Connection
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook';

mongoose
  .connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    maxPoolSize: 10,
  })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log('Connected to MongoDB');
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

// Basic health check route (no business logic yet)
app.get('/health', (req, res) => {
  return res.status(200).json({
    success: true,
    data: { status: 'ok' },
    message: 'Server is running',
  });
});

// Auth routes
app.use('/api/auth', authRoutes);

// User management routes (Admin only)
app.use('/api/users', userRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/procedures', procedureRoutes);
app.use('/api/logbook-cases', logbookCaseRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/otp', otpRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${PORT}`);
});

