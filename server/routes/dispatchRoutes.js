// routes/dispatchRoutes.js
const express = require('express');
const router = express.Router();

// ⬇︎ 구조 분해(import 중 필요한 함수만)
const { manualDispatch, setRioRegister17, RIOS } = require('../services/dispatcherService');

// 기존 호환성을 위한 엔드포인트 (POST /api/dispatch/)
router.post('/', manualDispatch);

// 명시적인 수동 디스패치 엔드포인트 (POST /api/dispatch/manual)
router.post('/manual', manualDispatch);

// 모든 RIO의 17번 레지스터에 값 설정 (POST /api/dispatch/rio-register17)
router.post('/rio-register17', async (req, res) => {
  console.log('[RIO_REG17_API] 요청 받음:', req.body);
  
  try {
    const { value } = req.body;
    
    if (value === undefined || value === null) {
      console.log('[RIO_REG17_API] 잘못된 요청: value 파라미터 누락');
      return res.status(400).json({ 
        success: false, 
        message: 'value 파라미터가 필요합니다 (0 또는 1)' 
      });
    }
    
    console.log('[RIO_REG17_API] 설정할 값:', value);
    
    // 모든 RIO IP 목록
    const rioIPs = ['192.168.0.5', '192.168.0.6'];
    const results = [];
    
    for (const ip of rioIPs) {
      try {
        console.log(`[RIO_REG17_API] ${ip} 설정 시도...`);
        await setRioRegister17(ip, value);
        results.push({ ip, success: true, message: '설정 완료' });
        console.log(`[RIO_REG17_API] ${ip} 설정 성공`);
      } catch (error) {
        console.error(`[RIO_REG17_API] ${ip} 설정 실패:`, error.message);
        results.push({ ip, success: false, message: error.message });
      }
    }
    
    const allSuccess = results.every(r => r.success);
    
    const response = {
      success: allSuccess,
      message: allSuccess ? '모든 RIO 설정 완료' : '일부 RIO 설정 실패',
      results,
      value: value ? 1 : 0
    };
    
    console.log('[RIO_REG17_API] 응답:', response);
    res.json(response);
    
  } catch (error) {
    console.error('[RIO_REG17_API] 예외 발생:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// RIO 연결 상태 확인 (GET /api/dispatch/rio-status)
router.get('/rio-status', (req, res) => {
  try {
    const rioStatus = {};
    
    for (const [ip, dev] of Object.entries(RIOS)) {
      rioStatus[ip] = {
        connected: dev.connected,
        lastAttempt: dev.lastAttempt,
        retry: dev.retry,
        lastRegs: dev.lastRegs ? `${dev.lastRegs.length}개 레지스터` : '없음'
      };
    }
    
    res.json({
      success: true,
      message: 'RIO 상태 조회 완료',
      status: rioStatus
    });
    
  } catch (error) {
    console.error('[RIO_STATUS_API] 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;
