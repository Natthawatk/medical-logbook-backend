const mongoose = require('mongoose');
const Location = require('../models/Location');
const Course = require('../models/Course');
const CourseLocation = require('../models/CourseLocation');
const { getAccessibleCourseIds } = require('../services/courseAccessService');
const { asTrimmedString } = require('../middlewares/securityMiddleware');

exports.createLocation = async (req, res) => {
  try {
    const { Location_name, semester, Location_image, latitude, longitude, radius } =
      req.body || {};

    if (!Location_name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Location_name, latitude, and longitude are required.',
      });
    }

    const duplicate = await Location.findOne({ Location_name: Location_name.trim() });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'Location with this name already exists.',
      });
    }

    const created = await Location.create({
      created_by: req.user.id,
      Location_name,
      semester,
      Location_image,
      latitude,
      longitude,
      radius,
    });

    return res.status(201).json({
      success: true,
      data: created,
      message: 'Location created successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Create location error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while creating the location.',
    });
  }
};

exports.getLocations = async (req, res) => {
  try {
    const semester = asTrimmedString(req.query.semester);
    const scope = asTrimmedString(req.query.scope);
    const filter = {};
    if (semester) filter.semester = semester;

    const allowEnrollable = req.user.role === 'course_instructor' && scope === 'enrollable';
    if (req.user.role !== 'admin' && !allowEnrollable) {
      const courseIds = await getAccessibleCourseIds(req.user);
      const [linkedIds, courses] = await Promise.all([
        CourseLocation.find({ course_id: { $in: courseIds }, status: 'active' }).distinct('location_id'),
        Course.find({ _id: { $in: courseIds } }).select('enrolled_locations').lean(),
      ]);
      const uniqueLocationIds = [...new Set([
        ...linkedIds.map((id) => String(id)),
        ...courses.flatMap((course) => (course.enrolled_locations || []).map((id) => String(id))),
      ])];
      filter._id = { $in: uniqueLocationIds };
    }

    const locations = await Location.find(filter).sort({ createdAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      data: locations,
      message: 'Locations fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get locations error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching locations.',
    });
  }
};

exports.getLocationById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid location id.',
      });
    }

    const location = await Location.findById(id).lean();
    if (!location) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Location not found.',
      });
    }

    if (req.user.role !== 'admin') {
      const courseIds = await getAccessibleCourseIds(req.user);
      const linked = await CourseLocation.exists({ course_id: { $in: courseIds }, location_id: id, status: 'active' });
      const ownsLocation = req.user.role === 'course_instructor' && String(location.created_by || '') === String(req.user.id);
      if (!linked && !ownsLocation) {
        return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์เข้าถึงสถานที่นี้' });
      }
    }

    return res.status(200).json({
      success: true,
      data: location,
      message: 'Location fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get location by id error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching the location.',
    });
  }
};

exports.updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid location id.',
      });
    }

    const location = await Location.findById(id);
    if (!location) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Location not found.',
      });
    }

    const { Location_name, semester, Location_image, latitude, longitude, radius } =
      req.body || {};

    if (Location_name !== undefined) {
      const duplicate = await Location.findOne({
        Location_name: Location_name.trim(),
        _id: { $ne: id },
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          data: null,
          message: 'Location with this name already exists.',
        });
      }
      location.Location_name = Location_name;
    }

    if (semester !== undefined && semester !== location.semester) {
      const Shift = mongoose.model('Shift');
      const hasShifts = await Shift.exists({ location_id: id });

      if (hasShifts) {
        return res.status(400).json({
          success: false,
          message: 'ไม่สามารถแก้ไขเทอมของสถานที่ได้ เนื่องจากมีประวัติการลงเวลาแล้ว'
        });
      }
      location.semester = semester;
    }
    if (Location_image !== undefined) location.Location_image = Location_image;
    if (latitude !== undefined) location.latitude = latitude;
    if (longitude !== undefined) location.longitude = longitude;
    if (radius !== undefined) location.radius = radius;

    await location.save();

    return res.status(200).json({
      success: true,
      data: location,
      message: 'Location updated successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Update location error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while updating the location.',
    });
  }
};

exports.deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid location id.',
      });
    }

    // Dependency Check: Prevent deleting location if linked to data
    const Shift = mongoose.model('Shift');
    const hasShifts = await Shift.exists({ location_id: id });

    if (hasShifts) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลบสถานที่นี้ได้ เนื่องจากมีประวัติการลงเวลาของนักศึกษา กรุณาย้ายข้อมูลที่เกี่ยวข้องก่อนทำการลบ'
      });
    }

    const deleted = await Location.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Location not found.',
      });
    }

    return res.status(200).json({
      success: true,
      data: null,
      message: 'Location deleted successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Delete location error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while deleting the location.',
    });
  }
};
