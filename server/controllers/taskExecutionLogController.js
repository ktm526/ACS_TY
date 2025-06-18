const { Op } = require('sequelize');
const TaskExecutionLog = require('../models/TaskExecutionLog');

// 모든 실행 로그 조회 (페이징 지원)
exports.getAll = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 2000,
            robot_name,
            event_type,
            task_id,
            start_date,
            end_date
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        // 필터 조건 구성
        const where = {};
        
        if (robot_name) {
            where.robot_name = robot_name;
        }
        
        if (event_type) {
            where.event_type = event_type;
        }
        
        if (task_id) {
            where.task_id = parseInt(task_id);
        }
        
        if (start_date || end_date) {
            where.timestamp = {};
            if (start_date) {
                where.timestamp[Op.gte] = new Date(start_date);
            }
            if (end_date) {
                where.timestamp[Op.lte] = new Date(end_date);
            }
        }

        const { count, rows } = await TaskExecutionLog.findAndCountAll({
            where,
            order: [['timestamp', 'DESC']],
            limit: parseInt(limit),
            offset: offset
        });

        res.json({
            logs: rows,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(count / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('[TaskExecutionLogController.getAll]', err);
        res.status(500).json({ message: err.message });
    }
};

// 특정 태스크의 실행 로그 조회
exports.getByTaskId = async (req, res) => {
    try {
        const { task_id } = req.params;
        
        const logs = await TaskExecutionLog.findAll({
            where: { task_id: parseInt(task_id) },
            order: [['timestamp', 'ASC']]
        });

        res.json(logs);
    } catch (err) {
        console.error('[TaskExecutionLogController.getByTaskId]', err);
        res.status(500).json({ message: err.message });
    }
};

// 특정 로봇의 실행 로그 조회
exports.getByRobotName = async (req, res) => {
    try {
        const { robot_name } = req.params;
        const { 
            limit = 50,
            start_date,
            end_date
        } = req.query;

        const where = { robot_name };
        
        if (start_date || end_date) {
            where.timestamp = {};
            if (start_date) {
                where.timestamp[Op.gte] = new Date(start_date);
            }
            if (end_date) {
                where.timestamp[Op.lte] = new Date(end_date);
            }
        }

        const logs = await TaskExecutionLog.findAll({
            where,
            order: [['timestamp', 'DESC']],
            limit: parseInt(limit)
        });

        res.json(logs);
    } catch (err) {
        console.error('[TaskExecutionLogController.getByRobotName]', err);
        res.status(500).json({ message: err.message });
    }
};

// 태스크 성능 통계 조회
exports.getTaskStats = async (req, res) => {
    try {
        const { 
            robot_name,
            start_date,
            end_date
        } = req.query;

        const where = {
            event_type: ['TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELED']
        };
        
        if (robot_name) {
            where.robot_name = robot_name;
        }
        
        if (start_date || end_date) {
            where.timestamp = {};
            if (start_date) {
                where.timestamp[Op.gte] = new Date(start_date);
            }
            if (end_date) {
                where.timestamp[Op.lte] = new Date(end_date);
            }
        }

        const stats = await TaskExecutionLog.findAll({
            attributes: [
                'event_type',
                [TaskExecutionLog.sequelize.fn('COUNT', '*'), 'count'],
                [TaskExecutionLog.sequelize.fn('AVG', TaskExecutionLog.sequelize.col('duration_ms')), 'avg_duration']
            ],
            where,
            group: ['event_type'],
            raw: true
        });

        res.json(stats);
    } catch (err) {
        console.error('[TaskExecutionLogController.getTaskStats]', err);
        res.status(500).json({ message: err.message });
    }
};

// 스텝별 성능 통계 조회
exports.getStepStats = async (req, res) => {
    try {
        const { 
            robot_name,
            step_type,
            start_date,
            end_date
        } = req.query;

        const where = {
            event_type: 'STEP_COMPLETED',
            step_type: { [Op.not]: null }
        };
        
        if (robot_name) {
            where.robot_name = robot_name;
        }
        
        if (step_type) {
            where.step_type = step_type;
        }
        
        if (start_date || end_date) {
            where.timestamp = {};
            if (start_date) {
                where.timestamp[Op.gte] = new Date(start_date);
            }
            if (end_date) {
                where.timestamp[Op.lte] = new Date(end_date);
            }
        }

        const stats = await TaskExecutionLog.findAll({
            attributes: [
                'step_type',
                [TaskExecutionLog.sequelize.fn('COUNT', '*'), 'count'],
                [TaskExecutionLog.sequelize.fn('AVG', TaskExecutionLog.sequelize.col('duration_ms')), 'avg_duration'],
                [TaskExecutionLog.sequelize.fn('MIN', TaskExecutionLog.sequelize.col('duration_ms')), 'min_duration'],
                [TaskExecutionLog.sequelize.fn('MAX', TaskExecutionLog.sequelize.col('duration_ms')), 'max_duration']
            ],
            where,
            group: ['step_type'],
            raw: true
        });

        res.json(stats);
    } catch (err) {
        console.error('[TaskExecutionLogController.getStepStats]', err);
        res.status(500).json({ message: err.message });
    }
};

// 일시정지 관련 로그만 조회
exports.getPauseResumeLogs = async (req, res) => {
    try {
        const { 
            robot_name,
            start_date,
            end_date,
            limit = 50
        } = req.query;

        const where = {
            event_type: ['TASK_PAUSED', 'TASK_RESUMED', 'TASK_CANCELED']
        };
        
        if (robot_name) {
            where.robot_name = robot_name;
        }
        
        if (start_date || end_date) {
            where.timestamp = {};
            if (start_date) {
                where.timestamp[Op.gte] = new Date(start_date);
            }
            if (end_date) {
                where.timestamp[Op.lte] = new Date(end_date);
            }
        }

        const logs = await TaskExecutionLog.findAll({
            where,
            order: [['timestamp', 'DESC']],
            limit: parseInt(limit)
        });

        res.json(logs);
    } catch (err) {
        console.error('[TaskExecutionLogController.getPauseResumeLogs]', err);
        res.status(500).json({ message: err.message });
    }
};

// 로그 생성 (내부 API용)
exports.create = async (req, res) => {
    try {
        const log = await TaskExecutionLog.create(req.body);
        res.status(201).json(log);
    } catch (err) {
        console.error('[TaskExecutionLogController.create]', err);
        res.status(500).json({ message: err.message });
    }
}; 