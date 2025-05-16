require('dotenv').config();
const { Sequelize } = require('sequelize');



const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.DB_PATH || './database.sqlite',
    logging: false, // 콘솔 SQL 끄기
});

module.exports = sequelize;
