const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

/*  ▒▒  Maps 테이블  ▒▒
 *  - stations / paths / additional_info   :  JSON 문자열
 *  - is_current                           :  현재 사용 중인 맵 여부
 *  - last_updated                         :  마지막 변경 시각(INSERT 시 자동)
 */
module.exports = sequelize.define(
    'Map',
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        /* JSON string 필드들 */
        stations: { type: DataTypes.TEXT }, // { stations:[…] }
        paths: { type: DataTypes.TEXT }, // { paths:[…] }
        additional_info: { type: DataTypes.TEXT }, // { header:{…}, … }

        /* 현재 사용 중인 맵 플래그 */
        is_current: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
        },

        /* 갱신 시각 */
        last_updated: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
    },
    {
        tableName: 'Maps',
        timestamps: false, // createdAt / updatedAt 자동 칼럼 사용 안 함
    }
);
