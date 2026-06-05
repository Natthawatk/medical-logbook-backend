const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const logbookCaseController = require('../controllers/logbookCaseController');

const router = express.Router();

router.use(protect);

// --- C R E A T E ---
// Student action: Create a new case
router.post('/', authorize('student'), logbookCaseController.createCase);


// --- R E A D ---
// NOTE: Specific routes must come BEFORE general/parameterized routes.

// Student action: Get their own cases
router.get('/my', authorize('student'), logbookCaseController.getMyCases);

// Preceptor actions
router.get('/pending', authorize('preceptor'), logbookCaseController.getPendingCases);
router.get('/my-preceptorship', authorize('preceptor'), logbookCaseController.getCasesForPreceptor);

// Admin action: Get all cases in the system
router.get('/all', authorize('admin'), logbookCaseController.getAllCases);

// General action: Get a specific case by its ID (must be last among GET routes)
router.get('/:id', logbookCaseController.getCaseById);


// --- U P D A T E ---
// Preceptor action: Evaluate a specific case
router.put('/:id/evaluate', authorize('preceptor'), logbookCaseController.evaluateCase);


module.exports = router;
