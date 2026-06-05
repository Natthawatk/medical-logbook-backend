const mongoose = require('mongoose');
const Location = require('../models/Location');
const User = require('../models/User');

exports.createLocation = async (req, res) => {
  try {
    const { Location_name, semester, Location_image, latitude, longitude, radius, assigned_preceptors } =
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
      Location_name,
      semester,
      Location_image,
      latitude,
      longitude,
      radius,
    });

    // Handle Preceptor Assignments (Added)
    if (Array.isArray(assigned_preceptors) && assigned_preceptors.length > 0) {
      await User.updateMany(
        { _id: { $in: assigned_preceptors } },
        { $set: { workplace: created._id } }
      );
    }

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
    const { semester } = req.query;
    const filter = {};
    if (semester) filter.semester = semester;

    const locations = await Location.find(filter).sort({ createdAt: -1 }).lean();
    
    // Calculate preceptor counts
    const preceptorStats = await User.aggregate([
      { $match: { role: 'preceptor', workplace: { $ne: null } } },
      { $group: { _id: '$workplace', count: { $sum: 1 } } }
    ]);

    const statsMap = preceptorStats.reduce((acc, curr) => {
      acc[curr._id.toString()] = curr.count;
      return acc;
    }, {});

    const results = locations.map(loc => ({
      ...loc,
      preceptor_count: statsMap[loc._id.toString()] || 0
    }));

    return res.status(200).json({
      success: true,
      data: results,
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

    // Find assigned preceptors (Added)
    const preceptors = await User.find({
      role: 'preceptor',
      workplace: id
    }).select('firstname_lastname email profile_image _id').lean();

    location.assigned_preceptors = preceptors;

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

    const { Location_name, semester, Location_image, latitude, longitude, radius, assigned_preceptors } =
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
      const [hasPreceptors, hasShifts] = await Promise.all([
        User.exists({ workplace: id }),
        Shift.exists({ location_id: id })
      ]);

      if (hasPreceptors || hasShifts) {
        return res.status(400).json({
          success: false,
          message: 'ไม่สามารถแก้ไขเทอมของสถานที่ได้ เนื่องจากมีการมอบหมายอาจารย์หรือมีประวัติการลงเวลาแล้ว'
        });
      }
      location.semester = semester;
    }
    if (Location_image !== undefined) location.Location_image = Location_image;
    if (latitude !== undefined) location.latitude = latitude;
    if (longitude !== undefined) location.longitude = longitude;
    if (radius !== undefined) location.radius = radius;

    await location.save();

    // Handle Preceptor Assignments Sync (Added)
    if (Array.isArray(assigned_preceptors)) {
      // 1. Remove this workplace from preceptors who were previously assigned but now removed
      await User.updateMany(
        { workplace: id, _id: { $nin: assigned_preceptors } },
        { $unset: { workplace: 1 } }
      );

      // 2. Assign this workplace to preceptors in the new list
      await User.updateMany(
        { _id: { $in: assigned_preceptors }, role: 'preceptor' },
        { $set: { workplace: id } }
      );
    }

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
    const [hasPreceptors, hasShifts] = await Promise.all([
      User.exists({ workplace: id }),
      Shift.exists({ location_id: id })
    ]);

    if (hasPreceptors || hasShifts) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลบสถานที่นี้ได้ เนื่องจากมีอาจารย์พี่เลี้ยงสังกัดอยู่ หรือมีบันทึกประวัติการลงเวลาของนักศึกษา กรุณาย้ายข้อมูลที่เกี่ยวข้องก่อนทำการลบ'
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
