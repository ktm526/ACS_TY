// controllers/motionController.js
const Robot = require('../models/Robot');
const { sendOpenLoopMotion } = require('../services/robotMotionService');

/**
 * POST /api/robots/:id/motion
 * body: { vx, vy, w, duration }
 */
exports.openLoop = async (req, res) => {
    try {
        const robotId = req.params.id;
        const { vx = 0, vy = 0, w = 0, duration = 500 } = req.body;

        const robot = await Robot.findByPk(robotId);
        if (!robot) return res.status(404).json({ message: 'Robot not found' });

        const result = await sendOpenLoopMotion(robot.ip, { vx, vy, w, duration });
        // 예: { ret_code: 0, create_on: "...", err_msg?: "..." }
        res.json(result);
    } catch (err) {
        console.error('[Motion.openLoop]', err);
        res.status(500).json({ message: err.message });
    }
};
