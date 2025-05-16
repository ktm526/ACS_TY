// controllers/jackController.js
const Robot = require('../models/Robot');
const { sendJackCommand } = require('../services/robotJackService');

// API request codes
const CODES = {
  setHeight: 0x17B9,  // 6073
  load:      0x17B6,  // 6070
  unload:    0x17B7,  // 6071
  stop:      0x17B8,  // 6072
};

/**
 * POST /api/robots/:id/jack/height
 * body: { height: number | string }
 */
async function setHeight(req, res) {
  try {
    console.log('Jack.setHeight', req.body);

    const robot = await Robot.findByPk(req.params.id);
    if (!robot) {
      return res.status(404).json({ message: 'Robot not found' });
    }

    let { height } = req.body;
    if (typeof height === 'string') {
      height = parseFloat(height);
    }
    if (typeof height !== 'number' || Number.isNaN(height)) {
      return res.status(400).json({ message: 'height must be a valid number' });
    }

    const result = await sendJackCommand(robot.ip, CODES.setHeight, { height });
    return res.json(result);
  } catch (err) {
    console.error('[Jack.setHeight]', err);
    return res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/robots/:id/jack/load
 */
async function load(req, res) {
  try {
    const robot = await Robot.findByPk(req.params.id);
    if (!robot) {
      return res.status(404).json({ message: 'Robot not found' });
    }

    const result = await sendJackCommand(robot.ip, CODES.load, null);
    return res.json(result);
  } catch (err) {
    console.error('[Jack.load]', err);
    return res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/robots/:id/jack/unload
 */
async function unload(req, res) {
  try {
    const robot = await Robot.findByPk(req.params.id);
    if (!robot) {
      return res.status(404).json({ message: 'Robot not found' });
    }

    const result = await sendJackCommand(robot.ip, CODES.unload, null);
    return res.json(result);
  } catch (err) {
    console.error('[Jack.unload]', err);
    return res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/robots/:id/jack/stop
 */
async function stop(req, res) {
  try {
    const robot = await Robot.findByPk(req.params.id);
    if (!robot) {
      return res.status(404).json({ message: 'Robot not found' });
    }

    const result = await sendJackCommand(robot.ip, CODES.stop, null);
    return res.json(result);
  } catch (err) {
    console.error('[Jack.stop]', err);
    return res.status(500).json({ message: err.message });
  }
}

module.exports = {
  setHeight,
  load,
  unload,
  stop,
  CODES,
};