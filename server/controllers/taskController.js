/* controllers/taskController.js */
const { Op } = require('sequelize');
const { Task, TaskStep } = require('../models');

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
  res.json({ success: true });
};

/* PUT /api/tasks/:id/resume */
exports.resume = async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.sendStatus(404);
  if (!['PAUSED', 'FAILED'].includes(task.status))
    return res.status(400).json({ msg: 'not resumable' });
  await task.update({ status: 'PENDING' });
  res.json({ success: true });
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
