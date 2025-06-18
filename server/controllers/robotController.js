// server/controllers/robotController.js
const Robot = require('../models/Robot');
const Map = require('../models/Map');
const { sendGotoNav } = require('../services/dispatcherService');
const { logButtonPressed } = require('../services/taskExecutionLogger');





exports.getAll = async (req, res) => {
    try {
        const rows = await Robot.findAll();
        res.json(rows);
    } catch (e) {
        console.error('[Robot GetAll] error', e);
        res.status(500).json({ message: e.message });
    }
};

exports.getById = async (req, res) => {
    try {
        const r = await Robot.findByPk(req.params.id);
        if (r) return res.json(r);
        res.sendStatus(404);
    } catch (e) {
        console.error('[Robot GetById] error', e);
        res.status(500).json({ message: e.message });
    }
};

exports.create = async (req, res) => {
    try {
        const r = await Robot.create(req.body);
        res.status(201).json(r);
    } catch (e) {
        console.error('[Robot Create] error', e);
        res.status(400).json({ message: e.message });
    }
};

exports.update = async (req, res) => {
    try {
        const [count] = await Robot.update(req.body, {
            where: { id: req.params.id },
        });
        if (count) return res.sendStatus(204);
        res.sendStatus(404);
    } catch (e) {
        console.error('[Robot Update] error', e);
        res.status(400).json({ message: e.message });
    }
};

exports.remove = async (req, res) => {
    const id = req.params.id;
    console.log(`[Robot Remove] DELETE /api/robots/${id}`);
    try {
        const count = await Robot.destroy({ where: { id } });
        console.log(`[Robot Remove] destroyed ${count} rows for id=${id}`);
        if (count) {
            return res.sendStatus(204);
        } else {
            return res.status(404).json({ message: `Robot ${id} not found` });
        }
    } catch (e) {
        console.error('[Robot Remove] error', e);
        return res.status(500).json({ message: e.message });
    }
};

exports.removeAll = async (req, res) => {
    //const id = req.params.id;
    //console.log(`[Robot Remove] DELETE /api/robots/${id}`);
    try {
        const count = await Robot.destroy({ where: {} });
        //console.log(`[Robot Remove] destroyed ${count} rows for id=${id}`);
        if (count) {
            return res.sendStatus(204);
        } else {
            r//eturn res.status(404).json({ message: `Robot ${id} not found` });
        }
    } catch (e) {
        console.error('[Robot Remove] error', e);
        return res.status(500).json({ message: e.message });
    }
};

exports.moveToStation = async (req, res) => {
    console.log('move2station')
    try {
        const robotId = req.params.id;
        const { station: stationName } = req.body;
        if (!stationName) {
            return res.status(400).json({ message: 'station name required' });
        }

        // 1) Robot 조회
        const robot = await Robot.findByPk(robotId);
        if (!robot) return res.status(404).json({ message: 'Robot not found' });

        // 2) 현재 맵에서 station 목록 가져오기
        const map = await Map.findOne({ where: { is_current: true } });
        if (!map) return res.status(400).json({ message: 'no current map' });
        const stations = JSON.parse(map.stations || '{}').stations || [];

        // 3) station name → station id 찾기
        const st = stations.find(s => (s.name ?? String(s.id)) === stationName);
        if (!st) return res.status(404).json({ message: 'station not found' });

        // 4) TCP 네비게이션 API 호출
        const taskId = String(Date.now());
        await sendGotoNav(robot.ip, st.id, 'SELF_POSITION', taskId);

        // 5) DB 업데이트
        await Robot.update(
            { destination: st.name, status: '이동', timestamp: new Date() },
            { where: { id: robot.id } }
        );

        // 6) TaskExecutionLog에 직접 네비게이션 명령 기록
        try {
            await logButtonPressed(robot.name, `직접 네비게이션 명령`, robot.location || '현재위치', st.name);
        } catch (error) {
            console.error('[TASK_LOG] 직접 네비게이션 로그 기록 오류:', error.message);
        }

        return res.json({
            success: true,
            robot: robot.name,
            dest: st.name,
            taskId
        });
    } catch (err) {
        console.error('[Robot.moveToStation] error', err);
        return res.status(500).json({ message: err.message });
    }
};