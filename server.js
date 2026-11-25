require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const multer = require('multer');
const { validateEnvironment, resolveMongoConfig } = require('./config/environment');
const { securityHeaders, sanitizeRequestInputs } = require('./middlewares/securityMiddleware');
const { startNotificationMonitor } = require('./services/notificationMonitorService');
const { dashboardCacheAutoInvalidateMiddleware } = require('./services/dashboardCacheService');

validateEnvironment();

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

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
const rawCorsOrigins = process.env.CORS_ORIGINS || (
  process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173,http://localhost:5174,http://localhost'
);
const allowedOrigins = rawCorsOrigins
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(securityHeaders);
app.use(cors({
  origin(origin, callback) {
    // Requests without Origin include server-to-server calls and health checks.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    const error = new Error('Origin is not allowed by CORS.');
    error.code = 'CORS_NOT_ALLOWED';
    return callback(error);
  },
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(sanitizeRequestInputs);
app.use(dashboardCacheAutoInvalidateMiddleware);

// MongoDB Connection
const { mongoUri, dbName, mode: dbMode } = resolveMongoConfig();

mongoose
  .connect(mongoUri, {
    dbName,
    maxPoolSize: 100,
  })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`Connected to MongoDB [mode=${dbMode}, db=${mongoose.connection.name}]`);
    startNotificationMonitor();
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
    data: {
      status: 'ok',
      dbMode,
      dbName: mongoose.connection.name || dbName,
    },
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

// Keep CORS, Multer, and malformed-JSON failures consistent with the API response contract.
app.use((err, req, res, next) => {
  if (err && err.code === 'CORS_NOT_ALLOWED') {
    return res.status(403).json({
      success: false,
      data: null,
      message: err.message,
    });
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'ขนาดไฟล์เกินกำหนด (สูงสุด 2MB)'
      : 'รูปแบบการอัปโหลดไฟล์ไม่ถูกต้อง';
    return res.status(400).json({
      success: false,
      data: null,
      message,
    });
  }

  if (err && err.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      data: null,
      message: err.message,
    });
  }

  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400 && 'body' in err))) {
    return res.status(400).json({
      success: false,
      data: null,
      message: 'รูปแบบข้อมูล JSON ไม่ถูกต้อง',
    });
  }

  if (err) {
    return res.status(err.status || 500).json({
      success: false,
      data: null,
      message: err.status && err.status < 500 ? err.message : 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์',
    });
  }

  return next();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${PORT}`);
});
