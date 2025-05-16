//models/TaskStep.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Task = require('./Task');           // 순환참조 아님


const TaskStep = sequelize.define('TaskStep', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    task_id: { type: DataTypes.INTEGER, allowNull: false },
    seq: { type: DataTypes.INTEGER, allowNull: false },
    type: {
        type: DataTypes.ENUM(
            'NAV', 'JACK', 'NAV_OR_BUFFER', 'WAIT_FREE_PATH',
            'NAV_PRE', 'JACK_UP', 'JACK_DOWN'),
        allowNull: false
    },
    payload: { type: DataTypes.TEXT, allowNull: false },         // JSON string
    status: {
        type: DataTypes.ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED'),
        defaultValue: 'PENDING'
    },
    retry: { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
    tableName: 'TaskSteps',
    timestamps: false,
});

module.exports = TaskStep;
