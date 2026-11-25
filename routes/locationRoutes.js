const express = require('express');

const { protect, authorize } = require('../middlewares/authMiddleware');
const locationController = require('../controllers/locationController');

const router = express.Router();

router.get('/', protect, locationController.getLocations);
router.get('/:id', protect, locationController.getLocationById);
router.post('/', protect, authorize('admin', 'course_instructor'), locationController.createLocation);
router.put('/:id', protect, authorize('admin', 'course_instructor'), locationController.updateLocation);
router.delete('/:id', protect, authorize('admin'), locationController.deleteLocation);

module.exports = router;
