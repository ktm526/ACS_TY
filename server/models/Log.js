// models/Log.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

module.exports = sequelize.define('Log', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    type: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false,
    },

    // 추가된 메타데이터 필드
    robot_name: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    from: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    to: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    status: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    detail: {
        type: DataTypes.TEXT,
        allowNull: true,
    },

    // 기존 ts 컬럼을 timestamp라는 JS 속성으로 매핑
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        field: 'ts',
    },
}, {
    tableName: 'Logs',
    timestamps: false,
});
