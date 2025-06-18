const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

module.exports = sequelize.define('TaskExecutionLog', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    task_id: {
        type: DataTypes.INTEGER,
        allowNull: true, // 버튼 눌림 같은 경우는 태스크가 아직 없을 수 있음
    },
    robot_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    robot_name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    event_type: {
        type: DataTypes.ENUM(
            'BUTTON_PRESSED',    // 버튼 눌림
            'TASK_ASSIGNED',     // 태스크 할당
            'TASK_STARTED',      // 태스크 시작
            'STEP_STARTED',      // 스텝 시작
            'STEP_COMPLETED',    // 스텝 완료
            'STEP_FAILED',       // 스텝 실패
            'TASK_PAUSED',       // 태스크 일시정지
            'TASK_RESUMED',      // 태스크 재개
            'TASK_CANCELED',     // 태스크 취소
            'TASK_COMPLETED',    // 태스크 완료
            'TASK_FAILED'        // 태스크 실패
        ),
        allowNull: false,
    },
    step_seq: {
        type: DataTypes.INTEGER,
        allowNull: true, // 스텝 관련 이벤트가 아닌 경우 null
    },
    step_type: {
        type: DataTypes.STRING,
        allowNull: true, // 스텝 관련 이벤트가 아닌 경우 null
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
    },
    duration_ms: {
        type: DataTypes.INTEGER,
        allowNull: true, // 완료 이벤트에서 수행 시간 기록
    },
    from_location: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    to_location: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    details: {
        type: DataTypes.TEXT,
        allowNull: true, // JSON 형태로 추가 정보 저장
    },
    error_message: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
}, {
    tableName: 'TaskExecutionLogs',
    timestamps: false,
    indexes: [
        {
            fields: ['task_id']
        },
        {
            fields: ['robot_name']
        },
        {
            fields: ['event_type']
        },
        {
            fields: ['timestamp']
        }
    ]
}); 