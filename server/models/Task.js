//models/Task.js

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Task = sequelize.define('Task', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    robot_id: { type: DataTypes.INTEGER, allowNull: false },
    status: {
        type: DataTypes.ENUM(
            'PENDING', 'RUNNING', 'PAUSED', 'CANCELED', 'DONE', 'FAILED'),
        defaultValue: 'PENDING'
    },
    current_seq: { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
    tableName: 'Tasks',
    timestamps: true,
});


module.exports = Task;
