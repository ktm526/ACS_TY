const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Config = sequelize.define('Config', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  key: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    comment: '설정 키 (예: adminPassword, version 등)'
  },
  value: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '설정 값'
  },
  description: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '설정 설명'
  },
  type: {
    type: DataTypes.ENUM('string', 'number', 'boolean', 'json'),
    defaultValue: 'string',
    comment: '값의 타입'
  },
  isSystem: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: '시스템 설정 여부 (사용자가 직접 수정 불가)'
  }
}, {
  tableName: 'configs',
  timestamps: true,
  paranoid: false,
  indexes: [
    {
      unique: true,
      fields: ['key']
    }
  ]
});

module.exports = Config; 