// controllers/logController.js
const Log = require('../models/Log');

exports.getAll = async (req, res) => {
    try {
        // 최신순으로 정렬
        const logs = await Log.findAll({
            order: [['timestamp', 'DESC']],
        });
        // 배열 그대로 응답
        res.json(logs);
    } catch (err) {
        console.error('[LogController.getAll]', err);
        res.status(500).json({ message: err.message });
    }
};

exports.getById = async (req, res) => {
    try {
        const id = req.params.id;
        const log = await Log.findByPk(id);
        if (!log) {
            return res.status(404).json({ message: 'Log not found' });
        }
        res.json(log);
    } catch (err) {
        console.error('[LogController.getById]', err);
        res.status(500).json({ message: err.message });
    }
};

exports.create = async (req, res) => {
    try {
        const { type, message, robot_name, from, to, status, detail } = req.body;
        const newLog = await Log.create({
            type,
            message,
            robot_name,
            from,
            to,
            status,
            detail,
        });
        // 생성된 레코드를 그대로 응답
        res.json(newLog);
    } catch (err) {
        console.error('[LogController.create]', err);
        res.status(500).json({ message: err.message });
    }
};

exports.update = async (req, res) => {
    try {
        const id = req.params.id;
        const [count] = await Log.update(req.body, { where: { id } });
        if (count === 0) {
            return res.status(404).json({ message: 'Log not found or no change' });
        }
        const updated = await Log.findByPk(id);
        res.json(updated);
    } catch (err) {
        console.error('[LogController.update]', err);
        res.status(500).json({ message: err.message });
    }
};

exports.remove = async (req, res) => {
    try {
        const id = req.params.id;
        const count = await Log.destroy({ where: { id } });
        if (count === 0) {
            return res.status(404).json({ message: 'Log not found' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[LogController.remove]', err);
        res.status(500).json({ message: err.message });
    }
};
