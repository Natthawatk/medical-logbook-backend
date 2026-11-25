const mongoose = require('mongoose');

const { Schema } = mongoose;

const pushConfigSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'vapid',
    },
    publicKey: {
      type: String,
      required: true,
    },
    privateKey: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushConfig', pushConfigSchema);
