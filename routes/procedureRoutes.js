const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const procedureController = require('../controllers/procedureController');

const router = express.Router();

router.use(protect, authorize('admin'));

router.post('/', procedureController.createProcedure);
router.get('/', procedureController.getProcedures);
router.get('/course/:course_id', procedureController.getProceduresByCourse);
router.get('/:id', procedureController.getProcedureById);
router.put('/:id', procedureController.updateProcedure);
router.delete('/:id', procedureController.deleteProcedure);

module.exports = router;
