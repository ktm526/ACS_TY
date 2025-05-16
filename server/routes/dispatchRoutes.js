// routes/dispatchRoutes.js
const router = require('express').Router();

// ⬇︎ 구조 분해(import 중 필요한 함수만)
const { manualDispatch } = require('../services/dispatcherService');

// 실제 엔드포인트               핸들러(함수)
router.post('/', manualDispatch);

module.exports = router;
