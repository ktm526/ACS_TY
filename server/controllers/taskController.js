/* controllers/taskController.js */
const { Op } = require('sequelize');
const { Task, TaskStep } = require('../models');
const Robot = require('../models/Robot');
const {
  logTaskPaused,
  logTaskResumed,
  logTaskCanceled
} = require('../services/taskExecutionLogger');

/* POST /api/tasks  ─ Task + Steps 생성 */
exports.create = async (req, res) => {
  const { robot_id, steps = [] } = req.body;

  const task = await Task.create(
    {
      robot_id,
      steps: steps.map((s, i) => ({ ...s, seq: i })),
    },
    { include: [{ model: TaskStep, as: 'steps' }] },
  );

  res.status(201).json({ id: task.id });
};

/* PUT /api/tasks/:id/pause */
exports.pause = async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.sendStatus(404);
  await task.update({ status: 'PAUSED' });
  
  // TaskExecutionLog에 API를 통한 일시정지 기록
  try {
    const robot = await Robot.findByPk(task.robot_id);
    if (robot) {
      await logTaskPaused(task.id, robot.id, robot.name, 'API를 통한 수동 일시정지');
      
      // RIO 레지스터 17번을 1로 설정 (DI 입력과 동일한 동작)
      try {
        const { setRioRegister17 } = require('../services/dispatcherService');
        const allRioIPs = ['192.168.0.5', '192.168.0.6'];
        for (const rioIP of allRioIPs) {
          await setRioRegister17(rioIP, true);
          console.log(`[API_PAUSE] ${robot.name}: RIO 레지스터 17번을 1로 설정 완료 (${rioIP})`);
        }
      } catch (error) {
        console.error(`[API_PAUSE] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
      }
    }
  } catch (error) {
    console.error('[TASK_LOG] API 일시정지 로그 기록 오류:', error.message);
  }
  
  res.json({ success: true });
};

/* PUT /api/tasks/:id/resume */
exports.resume = async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.sendStatus(404);
  if (!['PAUSED', 'FAILED'].includes(task.status))
    return res.status(400).json({ msg: 'not resumable' });
  await task.update({ status: 'PENDING' });
  
  // TaskExecutionLog에 API를 통한 재개 기록
  try {
    const robot = await Robot.findByPk(task.robot_id);
    if (robot) {
      await logTaskResumed(task.id, robot.id, robot.name, 'API를 통한 수동 재개');
    }
  } catch (error) {
    console.error('[TASK_LOG] API 재개 로그 기록 오류:', error.message);
  }
  
  res.json({ success: true });
};

/* PUT /api/tasks/:id/restart - DI 입력과 동일한 재시작 동작 */
exports.restart = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [{
        model: TaskStep,
        as: 'steps',
        where: { status: 'RUNNING' },
        required: false
      }]
    });
    
    if (!task) return res.sendStatus(404);
    
    const robot = await Robot.findByPk(task.robot_id);
    if (!robot) return res.status(404).json({ msg: 'Robot not found' });
    
    if (!['PAUSED', 'RUNNING'].includes(task.status)) {
      return res.status(400).json({ msg: 'Task is not paused or running' });
    }
    
    // DI 입력의 handleRestartSignal과 동일한 로직
    if (task.status === 'PAUSED') {
      await task.update({ status: 'RUNNING' });
      console.log(`[API_RESTART] ${robot.name}: 태스크 상태를 PAUSED → RUNNING으로 변경`);
      
      // 태스크 재개 로그 기록
      try {
        await logTaskResumed(task.id, robot.id, robot.name, 'API를 통한 재시작');
      } catch (error) {
        console.error('[TASK_LOG] API 재시작 로그 기록 오류:', error.message);
      }
    }
    
    // RIO 레지스터 17번을 0으로 설정 (재개 신호)
    try {
      const { setRioRegister17 } = require('../services/dispatcherService');
      const allRioIPs = ['192.168.0.5', '192.168.0.6'];
      for (const rioIP of allRioIPs) {
        await setRioRegister17(rioIP, false);
        console.log(`[API_RESTART] ${robot.name}: RIO 레지스터 17번을 0으로 설정 완료 (${rioIP})`);
      }
    } catch (error) {
      console.error(`[API_RESTART] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
    }
    
    res.json({ success: true, message: 'Task restarted successfully' });
    
  } catch (error) {
    console.error('[API_RESTART] 오류:', error.message);
    res.status(500).json({ error: error.message });
  }
};

/* DELETE /api/tasks/:id  ─ 취소 */
exports.cancel = async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.sendStatus(404);

  await task.update({ status: 'CANCELED' });
  await TaskStep.update(
    { status: 'FAILED' },
    { where: { task_id: task.id, status: ['PENDING', 'RUNNING'] } },
  );
  
  // TaskExecutionLog에 API를 통한 취소 기록
  try {
    const robot = await Robot.findByPk(task.robot_id);
    if (robot) {
      await logTaskCanceled(task.id, robot.id, robot.name, 'API를 통한 수동 취소');
    }
  } catch (error) {
    console.error('[TASK_LOG] API 취소 로그 기록 오류:', error.message);
  }
  
  res.json({ success: true });
};

/* GET /api/tasks[/:id]  ─ 목록/단건 */
exports.list = async (req, res) => {
  if (req.params.id) {
    const task = await Task.findByPk(req.params.id, {
      include: [{ model: TaskStep, as: 'steps' }],
    });
    return task ? res.json(task) : res.sendStatus(404);
  }

  const rows = await Task.findAll({ order: [['id', 'DESC']] });
  res.json(rows);
};

/* GET /api/robots/:id/current-task */
exports.currentOfRobot = async (req, res) => {
  const { id: robot_id } = req.params;

  const task = await Task.findOne({
    where: { robot_id, status: ['PENDING', 'RUNNING', 'PAUSED'] },
    order: [['id', 'ASC']],
    include: [{
      model: TaskStep,
      as:   'steps',
      separate: true,
      order: [['seq', 'ASC']],
    }],
  });

  if (!task) return res.sendStatus(204);

  res.json({
    task_id    : task.id,
    current_seq: task.current_seq,
    steps      : task.steps.map(s => ({
      seq    : s.seq,
      type   : s.type,
      payload: s.payload,      // string 그대로 반환 (프론트에서 JSON.parse)
      status : s.status,
    })),
    paused   : task.status === 'PAUSED',
  });
};
