const express = require('express');
const c = require('../controllers/taskExecutionLogController');
const router = express.Router();

// 기본 CRUD
router.get('/', c.getAll);                          // GET /api/task-execution-logs
router.post('/', c.create);                         // POST /api/task-execution-logs

// 특정 태스크/로봇별 조회
router.get('/task/:task_id', c.getByTaskId);        // GET /api/task-execution-logs/task/123
router.get('/robot/:robot_name', c.getByRobotName); // GET /api/task-execution-logs/robot/AMR001

// 통계 조회
router.get('/stats/tasks', c.getTaskStats);         // GET /api/task-execution-logs/stats/tasks
router.get('/stats/steps', c.getStepStats);         // GET /api/task-execution-logs/stats/steps

// 일시정지 관련 로그
router.get('/pause-resume', c.getPauseResumeLogs);  // GET /api/task-execution-logs/pause-resume

module.exports = router; 