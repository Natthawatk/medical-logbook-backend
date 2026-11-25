const express = require('express');
const path = require('path');
const multer = require('multer');

const {
  protect,
  authorize,
} = require('../middlewares/authMiddleware');
const { importRateLimiter } = require('../middlewares/securityMiddleware');

const userController = require('../controllers/userController');
const courseAccountController = require('../controllers/courseAccountController');

const ALLOWED_IMPORT_EXTENSIONS = new Set(['.xlsx', '.csv']);
const ALLOWED_IMPORT_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
]);

const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB max
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED_IMPORT_EXTENSIONS.has(ext) || (mime && !ALLOWED_IMPORT_MIMETYPES.has(mime))) {
      const error = new Error('รองรับเฉพาะไฟล์ .xlsx หรือ .csv เท่านั้น');
      error.code = 'INVALID_FILE_TYPE';
      return cb(error);
    }
    return cb(null, true);
  },
});

const router = express.Router();

router.get('/me', protect, userController.getMyProfile);
router.put('/profile', protect, userController.updateMyProfile);
router.get('/preceptors', protect, authorize('admin'), userController.getPreceptors);
router.post('/', protect, authorize('admin', 'course_instructor'), courseAccountController.createAccount);
router.post('/bulk', protect, authorize('admin'), importRateLimiter, userController.createUsersBulk);
router.get('/import-template', protect, authorize('admin', 'course_instructor'), userController.downloadImportTemplate);
router.post('/import-csv', protect, authorize('admin', 'course_instructor'), importRateLimiter, upload.single('file'), userController.importUsersCSV);
router.get('/', protect, authorize('admin', 'course_instructor'), courseAccountController.getAccounts);
router.patch('/bulk-update', protect, authorize('admin', 'course_instructor'), userController.bulkUpdateUsers);
router.get('/:id', protect, authorize('admin', 'course_instructor'), userController.getUserById);
router.put('/:id', protect, authorize('admin', 'course_instructor'), userController.updateUser);
router.delete(
  '/:id',
  protect,
  authorize('admin', 'course_instructor'),
  userController.deleteUser
);

module.exports = router;
