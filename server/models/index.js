// server/models/index.js
const sequelize = require('../config/db');

const Task     = require('./Task');
const TaskStep = require('./TaskStep');
const TaskExecutionLog = require('./TaskExecutionLog');
const Config = require('./Config');


Task.hasMany(TaskStep, {
  as: 'steps',
  foreignKey: 'task_id',
  onDelete: 'CASCADE',       // ★
});

TaskStep.belongsTo(Task, {
  as: 'task',
  foreignKey: 'task_id',
  onDelete: 'CASCADE',       // ★
});

module.exports = {
  sequelize,
  Task,
  TaskStep,
  TaskExecutionLog,
  Config,
  // Robot, Map, …
};
