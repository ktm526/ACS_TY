// server/controllers/healthController.js
const { lastRecTime, sockets } = require('../services/amrMonitorService');
const {
    RIOS,
    lastRioSignal,
    reconnectRio,
    doorState,
    ALARM_STATE,
    DOOR_IPS = {},
} = require('../services/dispatcherService');
const { reconnectAmr } = require('../services/amrMonitorService');
const Robot = require('../models/Robot');

const THRESHOLD = 2_000; // 5초

/**
 * GET /api/health/signals
 * Returns per-device signal status for RIO, AMR, Door (open/closed/disconnected), and global Alarm
 */
exports.getSignals = async (req, res) => {
    try {
        const now = Date.now();

        // 1) RIO signals
        const rio = {};
        Object.keys(RIOS).forEach(ip => {
            const last = lastRioSignal.get(ip) || 0;
            rio[ip] = (now - last) < THRESHOLD;
        });

        // 2) AMR signals
        const robots = await Robot.findAll({ attributes: ['name'], raw: true });
        const amr = {};
        robots.forEach(({ name }) => {
            const last = lastRecTime.get(name) || 0;
            amr[name] = (now - last) < THRESHOLD;
        });

        // 3) Door signals (open/closed/disconnected)
        const door = {};
        Object.values(DOOR_IPS).flat().forEach(ip => {
            const info = doorState.get(ip);
            if (!info || (now - info.timestamp) > THRESHOLD) {
                door[ip] = 'disconnected';
            } else {
                door[ip] = info.open ? 'open' : 'closed';
            }
        });

        // 4) Alarm signal
        const alarm = (now - (ALARM_STATE.timestamp || 0)) < THRESHOLD;

        return res.json({ rio, amr, door, alarm });
    } catch (err) {
        console.error('[Health.getSignals]', err);
        return res.status(500).json({ message: '시그널 조회 중 오류가 발생했습니다.' });
    }
};

/**
 * GET /api/health/signals/:type/:key
 * Returns detailed status for a specific signal type and key
 */
exports.getSignalDetail = async (req, res) => {
    const { type, key } = req.params;
    const now = Date.now();

    try {
        switch (type) {
            case 'rio': {
                const dev = RIOS[key];
                if (!dev) return res.status(404).json({ message: 'RIO not found' });
                return res.json({
                    ip: key,
                    connected: dev.connected,
                    lastRegs: dev.lastRegs || [],
                    lastSignal: lastRioSignal.get(key) || null,
                });
            }

            case 'amr': {
                const ts = lastRecTime.get(key) || null;
                const robot = await Robot.findOne({ where: { name: key } });
                if (!robot) return res.status(404).json({ message: 'AMR not found' });
                return res.json({
                    name: key,
                    status: robot.status,
                    battery: robot.battery,
                    lastSignal: ts,
                });
            }

            case 'door': {
                const info = doorState.get(key);
                let state;
                if (!info || (now - info.timestamp) > THRESHOLD) {
                    state = 'disconnected';
                } else {
                    state = info.open ? 'open' : 'closed';
                }
                return res.json({
                    id: key,
                    state,
                    open: info ? info.open : false,
                    lastSignal: info ? info.timestamp : null,
                });
            }

            case 'alarm': {
                return res.json({
                    active: ALARM_STATE.open,
                    lastSignal: ALARM_STATE.timestamp,
                });
            }

            default:
                return res.status(400).json({ message: 'Invalid type' });
        }
    } catch (e) {
        console.error('[Health.getSignalDetail]', e);
        return res.status(500).json({ message: '서버 오류' });
    }
};

exports.reconnectSignal = async (req, res) => {
    const { type, key } = req.params;
    try {
        if (type === 'rio') {
            await reconnectRio(key);
        } else if (type === 'amr') {
            await reconnectAmr(key);
        } else {
            return res.status(400).json({ message: '재연결 불가 항목' });
        }
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: '재연결 실패' });
    }
};