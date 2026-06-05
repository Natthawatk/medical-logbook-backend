const mongoose = require('mongoose');

const { Schema } = mongoose;

const locationSchema = new Schema(
  {
    Location_name: {
      type: String,
      required: true,
      trim: true,
    },
    semester: {
      type: String,
      trim: true,
    },
    Location_image: {
      // Store only URL/path strings. Do NOT store Base64/binary image data here.
      type: String,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    radius: {
      type: Number, // meters
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Location', locationSchema);

