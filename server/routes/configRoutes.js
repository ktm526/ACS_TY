const express = require('express');
const router = express.Router();
const configController = require('../controllers/configController');

// 관리자 패스워드 확인
router.post('/verify-password', configController.verifyAdminPassword);

// 관리자 패스워드 변경
router.put('/admin-password', configController.updateAdminPassword);

// 특정 설정 조회
router.get('/:key', configController.getConfig);

// 모든 설정 조회 (패스워드 제외)
router.get('/', configController.getAllConfigs);

// 시스템 정보 조회
router.get('/system/info', configController.getSystemInfo);

module.exports = router; 