/************************************************************************
 *  taskExecutorService.js  (JACK send‐once + status‐check)
 *  ────────────────────────────────────────────────────────────────────
 *  ▸ 로봇별 1 Task 동시 실행 보장 (skip-locked select)
 *  ▸ NAV_PRE: just send, no wait
 *  ▸ NAV: send + waitUntil location change
 *  ▸ JACK / JACK_UP / JACK_DOWN: send only once, then waitUntil Robot.status==='대기'
 *  ▸ WAIT_FREE_PATH: simple poll
 *  ▸ console.log for full tracing
 *  ▸ tick() 재진입 금지
 ************************************************************************/
require('dotenv').config();

const { Op, Sequelize } = require('sequelize');
const sequelize         = require('../config/db');
const { Task, TaskStep } = require('../models');
const Robot             = require('../models/Robot');
const MapDB             = require('../models/Map');

const { sendGotoNav }     = require('./navService');
const { sendJackCommand } = require('./robotJackService');
const JACK_CODES          = require('../controllers/jackController').CODES;
const {
  logTaskStarted,
  logStepStarted,
  logStepCompleted,
  logStepFailed,
  logTaskCompleted,
  logTaskFailed
} = require('./taskExecutionLogger');

// 순환 참조 문제 해결을 위해 직접 참조 대신 함수로 가져오기
let RIOS;
function getRIOS() {
  if (!RIOS) {
    try {
      const dispatcherService = require('./dispatcherService');
      RIOS = dispatcherService.RIOS;
    } catch (err) {
      console.error('[getRIOS] Error:', err.message);
      RIOS = {}; // 문제 발생 시 빈 객체로 초기화
    }
  }
  return RIOS || {};
}

/* ───────────────────────────── constants ───────────────────────────── */
const TICK_MS         = 500;          // 0.5s
const MAX_RETRY       = 100;            // step 실패 시 재시도 횟수
const STEP_TIMEOUT_MS = 1_800_000;    // 30분

/* ───────────────────── helper functions ───────────────────────────── */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ──────────────────── AMR Manual/Auto 모드 체크 함수 ─────────────────── */
function checkRobotAutoMode(robot) {
  try {
    // robot.additional_info에서 DI 센서 정보 추출
    let additionalInfo = {};
    if (robot.additional_info) {
      additionalInfo = typeof robot.additional_info === 'string'
        ? JSON.parse(robot.additional_info)
        : robot.additional_info;
    }
    
    // DI 센서 정보 가져오기
    const diSensors = additionalInfo.diSensors || [];
    
    // DI 11번 센서 찾기 (자동/수동 모드)
    const di11 = diSensors.find(s => s.id === 11);
    
    if (!di11) {
      // DI 11번 센서 정보가 없으면 기본적으로 자동 모드로 가정
      console.log(`[AUTO_MODE_CHECK] ${robot.name}: DI 11번 센서 정보 없음, 자동 모드로 가정`);
      return true;
    }
    
    // DI 11번이 false이면 자동, true이면 수동
    const isAutoMode = di11.status === false;
    const modeText = isAutoMode ? '자동' : '수동';
    
    // 로그는 모드가 변경될 때만 출력 (너무 많은 로그 방지)
    const lastMode = robot._lastMode || true; // 기본값은 자동
    if (lastMode !== isAutoMode) {
      console.log(`[AUTO_MODE_CHECK] ${robot.name}: 모드 변경 감지 - ${modeText} 모드`);
      robot._lastMode = isAutoMode; // 마지막 모드 저장
    }
    
    return isAutoMode;
    
  } catch (error) {
    console.error(`[AUTO_MODE_CHECK] ${robot.name}: DI 센서 정보 파싱 오류 - ${error.message}`);
    // 오류 발생 시 기본적으로 자동 모드로 가정
    return true;
  }
}

/* ───────────────────── waitUntil helper ──────────────────────────── */
const waitUntil = (cond, ms, taskId) => new Promise((resolve) => {
  const start = Date.now();
  let checkCount = 0;
  
  const i = setInterval(async () => {
    checkCount++;
    
    try {
      // 1) 취소·일시정지 검사
      if (taskId) {
        const t = await Task.findByPk(taskId);
        if (['PAUSED', 'CANCELED', 'FAILED'].includes(t?.status)) {
          console.log(`    ▶ [DEBUG] waitUntil 중단: 태스크 상태=${t?.status}, 체크횟수=${checkCount}`);
          clearInterval(i);
          return resolve('INTERRUPTED');
        }
      }
      
      // 2) 원래 조건 체크
      const result = await cond();
      if (result) {
        console.log(`    ▶ [DEBUG] waitUntil 성공: 체크횟수=${checkCount}, 소요시간=${Date.now() - start}ms`);
        clearInterval(i);
        return resolve(true);
      }
      
      // 3) 타임아웃 체크
      const elapsed = Date.now() - start;
      if (elapsed > ms) {
        console.log(`    ▶ [DEBUG] waitUntil 타임아웃: 체크횟수=${checkCount}, 소요시간=${elapsed}ms, 제한시간=${ms}ms`);
        clearInterval(i);
        return resolve(false);
      }
      
      // 주기적 진행 상황 로그 (30초마다)
      if (checkCount % 60 === 0) {
        console.log(`    ▶ [DEBUG] waitUntil 진행중: 체크횟수=${checkCount}, 소요시간=${elapsed}ms`);
      }
      
    } catch (error) {
      console.error(`    ▶ [DEBUG] waitUntil 오류: ${error.message}, 체크횟수=${checkCount}`);
      // 오류가 발생해도 계속 시도
    }
  }, 500);
});

// at the top of taskExecutorService.js
function getCls(s) {
    if (Array.isArray(s.class))       return s.class;
    if (Array.isArray(s.classList))   return s.classList;
    if (typeof s.class === 'string')  return [ s.class ];
    return [];
  }
  function hasClass(s, c) {
    return getCls(s).includes(c);
  }
  function regionOf(s) {
    return hasClass(s,'A') ? 'A'
         : hasClass(s,'B') ? 'B'
         : null;
  }
  
/* ───────────────────────── enqueue helper ───────────────────────── */
async function enqueueTask(robotId, steps) {
  return sequelize.transaction(async tx => {
    const task = await Task.create({ robot_id: robotId }, { transaction: tx });
    await TaskStep.bulkCreate(
      steps.map((s,i) => ({
        task_id: task.id,
        seq:     i,
        type:    s.type,
        payload: JSON.stringify(s.payload ?? {}),
        status:  'PENDING',
      })),
      { transaction: tx }
    );
    console.log(`[ENQUEUE] robot#${robotId} task#${task.id} (${steps.length} steps)`);
    return task;
  });
}
exports.enqueueTask = enqueueTask;

/* ───────────────── module‐level guard for JACK sends ────────────── */
const inFlightJack = new Set();

/* ───────────────────────── runStep ──────────────────────────────── */
async function runStep(task, robot, step) {
  // robot이 null인 경우 처리
  if (!robot) {
    throw new Error('로봇이 존재하지 않습니다');
  }
  
  const payload = typeof step.payload === 'string'
    ? JSON.parse(step.payload)
    : (step.payload ?? {});

  console.log(`  ↪ [RUN] task#${task.id} seq=${step.seq} (${step.type})`);

  // 스텝 시작 로그 기록 (PENDING에서 RUNNING으로 변경될 때만)
  const stepStartTime = new Date();
  const isFirstRun = step.status === 'PENDING';
  
  try {
    if (isFirstRun) {
      // NAV/NAV_PRE 스텝인 경우 출발지와 목적지 정보 추가
      if (step.type === 'NAV' || step.type === 'NAV_PRE') {
        // 맵 정보와 스테이션 정보 가져오기
        const mapRow = await MapDB.findOne({ where: { is_current: true } });
        const stations = JSON.parse(mapRow.stations || '{}').stations || [];
        
        // 현재 위치 스테이션 찾기
        const fromStation = stations.find(s => String(s.id) === String(robot.location));
        const toStation = stations.find(s => String(s.id) === String(payload.dest));
        
        const fromLocationName = fromStation ? fromStation.name : robot.location;
        const toLocationName = toStation ? toStation.name : payload.dest;
        
        await logStepStarted(task.id, robot.id, robot.name, step.seq, step.type, payload, fromLocationName, toLocationName);
      } else {
        await logStepStarted(task.id, robot.id, robot.name, step.seq, step.type, payload);
      }
    }
  } catch (error) {
    console.error('[TASK_LOG] 스텝 시작 로그 기록 오류:', error.message);
  }

  // ─ NAV_PRE: just send once, no wait
  if (step.type === 'NAV_PRE') {
    console.log(`    ▶ NAV PRE send → dest=${payload.dest}`);
    
    // 맵과 스테이션 정보 로드
    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations || '{}').stations || [];
    
    // 목적지 스테이션 찾기 및 destination 업데이트
    const destStation = stations.find(s => String(s.id) === String(payload.dest));
    if (destStation) {
      await Robot.update(
        { destination: destStation.name },
        { where: { id: robot.id } }
      );
      console.log(`    ▶ Robot destination 업데이트: ${destStation.name}`);
    } else {
      console.log(`    ▶ 목적지 스테이션을 찾을 수 없음: ${payload.dest}`);
    }
    
    // 같은 지역의 다른 AMR이 '이동' 중이면 대기 (교차 이동은 제외)
    const allRobots = await Robot.findAll();
    
    // 현재 로봇의 위치와 목적지의 지역 확인
    const currentStation = stations.find(s => String(s.id) === String(robot.location));
    
    const currentRegion = currentStation ? regionOf(currentStation) : null;
    const destRegion = destStation ? regionOf(destStation) : null;
    
    console.log(`    ▶ 현재 위치 지역: ${currentRegion}, 목적지 지역: ${destRegion}`);
    
    // 교차 이동 (지역간 이동)인지 확인
    const isCrossRegionMove = currentRegion !== destRegion && currentRegion !== null && destRegion !== null;
    
    if (isCrossRegionMove) {
      console.log(`    ▶ 교차 지역 이동이므로 다른 로봇 대기 없이 바로 실행합니다.`);
    } else if (currentRegion !== null) {
      // 같은 지역 내 이동일 때만 다른 로봇 상태 확인
      console.log(`    ▶ ${currentRegion} 지역 내 이동 - 다른 로봇 상태 확인 중...`);
      
      // 같은 지역의 다른 로봇들 중 '이동' 상태인 로봇이 있는지 확인
      const movingRobotsInSameRegion = allRobots.filter(r => {
        if (r.id === robot.id) return false; // 자기 자신 제외
        if (r.status !== '이동') return false; // '이동' 상태가 아닌 로봇 제외
        
        const robotStation = stations.find(s => String(s.id) === String(r.location));
        const robotRegion = robotStation ? regionOf(robotStation) : null;
        
        return robotRegion === currentRegion;
      });
      
      if (movingRobotsInSameRegion.length > 0) {
        console.log(`    ▶ 같은 지역에 이동 중인 로봇이 있습니다: ${movingRobotsInSameRegion.map(r => r.name).join(', ')}`);
        console.log(`    ▶ 다른 로봇의 이동이 완료될 때까지 대기합니다.`);
        return false; // 스텝을 완료하지 않고 다음 tick에서 다시 체크
      }
    }
    
    await sendGotoNav(robot.ip, payload.dest, 'SELF_POSITION', `${Date.now()}`);

    const ok = await waitUntil(async () => {
      const fresh = await Robot.findByPk(robot.id);
      // fresh가 null인 경우 처리
      if (!fresh) {
        console.log(`    ▶ [DEBUG] 로봇 정보를 찾을 수 없음: robot.id=${robot.id}`);
        return false;
      }
      
      // 위치 비교 로그 추가
      const currentLoc = fresh.location;
      const targetLoc = payload.dest;
      //console.log(`    ▶ [DEBUG] 위치 확인: 현재=${currentLoc}, 목표=${targetLoc}, 일치=${String(currentLoc) === String(targetLoc)}`);
      
      // null/undefined 처리 개선
      if (currentLoc == null || targetLoc == null) {
        console.log(`    ▶ [DEBUG] 위치 정보 누락: 현재=${currentLoc}, 목표=${targetLoc}`);
        return false;
      }
      
      return String(currentLoc) === String(targetLoc);
    }, STEP_TIMEOUT_MS, task.id);

    console.log(`    ◀ NAV ${ok === 'INTERRUPTED' ? 'INTERRUPTED' : ok ? 'DONE' : 'TIMEOUT'}`);
    
    // INTERRUPTED 상태 처리 추가
    if (ok === 'INTERRUPTED') {
      console.log(`    ▶ NAV 명령이 중단되었습니다 (태스크 상태 변경)`);
      return false; // 스텝을 완료하지 않고 대기
    }
    
    if (!ok) throw new Error('NAV timeout');
    
    // 위치 확인 완료 후 5초 지연 추가
    console.log(`    ▶ NAV 완료 후 5초 대기 중...`);
    await delay(5000);
    console.log(`    ▶ 대기 완료, 다음 단계로 진행합니다.`);
    
    return true;
  }

  // ─ NAV: send + wait for location change
  if (step.type === 'NAV') {
    console.log(`    ▶ NAV send → dest=${payload.dest}`);
    
    // 맵과 스테이션 정보 로드
    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations || '{}').stations || [];
    
    // 목적지 스테이션 찾기 및 destination 업데이트
    const destStation = stations.find(s => String(s.id) === String(payload.dest));
    if (destStation) {
      await Robot.update(
        { destination: destStation.name },
        { where: { id: robot.id } }
      );
      console.log(`    ▶ Robot destination 업데이트: ${destStation.name}`);
    } else {
      console.log(`    ▶ 목적지 스테이션을 찾을 수 없음: ${payload.dest}`);
    }
    
    // 같은 지역의 다른 AMR이 '이동' 중이면 대기 (교차 이동은 제외)
    const allRobots = await Robot.findAll();
    
    // 현재 로봇의 위치와 목적지의 지역 확인
    const currentStation = stations.find(s => String(s.id) === String(robot.location));
    
    const currentRegion = currentStation ? regionOf(currentStation) : null;
    const destRegion = destStation ? regionOf(destStation) : null;
    
    console.log(`    ▶ 현재 위치 지역: ${currentRegion}, 목적지 지역: ${destRegion}`);
    
    // 교차 이동 (지역간 이동)인지 확인
    const isCrossRegionMove = currentRegion !== destRegion && currentRegion !== null && destRegion !== null;
    
    if (isCrossRegionMove) {
      console.log(`    ▶ 교차 지역 이동이므로 다른 로봇 대기 없이 바로 실행합니다.`);
    } else if (currentRegion !== null) {
      // 같은 지역 내 이동일 때만 다른 로봇 상태 확인
      console.log(`    ▶ ${currentRegion} 지역 내 이동 - 다른 로봇 상태 확인 중...`);
      
      // 같은 지역의 다른 로봇들 중 '이동' 상태인 로봇이 있는지 확인
      const movingRobotsInSameRegion = allRobots.filter(r => {
        if (r.id === robot.id) return false; // 자기 자신 제외
        if (r.status !== '이동') return false; // '이동' 상태가 아닌 로봇 제외
        
        const robotStation = stations.find(s => String(s.id) === String(r.location));
        const robotRegion = robotStation ? regionOf(robotStation) : null;
        
        return robotRegion === currentRegion;
      });
      
      if (movingRobotsInSameRegion.length > 0) {
        console.log(`    ▶ 같은 지역에 이동 중인 로봇이 있습니다: ${movingRobotsInSameRegion.map(r => r.name).join(', ')}`);
        console.log(`    ▶ 다른 로봇의 이동이 완료될 때까지 대기합니다.`);
        return false; // 스텝을 완료하지 않고 다음 tick에서 다시 체크
      }
    }
    
    await sendGotoNav(robot.ip, payload.dest, 'SELF_POSITION', `${Date.now()}`);

    const ok = await waitUntil(async () => {
      const fresh = await Robot.findByPk(robot.id);
      // fresh가 null인 경우 처리
      if (!fresh) {
        console.log(`    ▶ [DEBUG] 로봇 정보를 찾을 수 없음: robot.id=${robot.id}`);
        return false;
      }
      
      // 위치 비교 로그 추가
      const currentLoc = fresh.location;
      const targetLoc = payload.dest;
      //console.log(`    ▶ [DEBUG] 위치 확인: 현재=${currentLoc}, 목표=${targetLoc}, 일치=${String(currentLoc) === String(targetLoc)}`);
      
      // null/undefined 처리 개선
      if (currentLoc == null || targetLoc == null) {
        console.log(`    ▶ [DEBUG] 위치 정보 누락: 현재=${currentLoc}, 목표=${targetLoc}`);
        return false;
      }
      
      return String(currentLoc) === String(targetLoc);
    }, STEP_TIMEOUT_MS, task.id);

    console.log(`    ◀ NAV ${ok === 'INTERRUPTED' ? 'INTERRUPTED' : ok ? 'DONE' : 'TIMEOUT'}`);
    
    // INTERRUPTED 상태 처리 추가
    if (ok === 'INTERRUPTED') {
      console.log(`    ▶ NAV 명령이 중단되었습니다 (태스크 상태 변경)`);
      return false; // 스텝을 완료하지 않고 대기
    }
    
    if (!ok) throw new Error('NAV timeout');
    
    // 위치 확인 완료 후 5초 지연 추가
    console.log(`    ▶ NAV 완료 후 5초 대기 중...`);
    await delay(5000);
    console.log(`    ▶ 대기 완료, 다음 단계로 진행합니다.`);
    
    return true;
  }

  // ─ JACK / JACK_UP / JACK_DOWN: send only once, then wait for status change
  if (['JACK','JACK_UP','JACK_DOWN'].includes(step.type)) {
    const height = step.type === 'JACK_UP'   ? 0.03
                 : step.type === 'JACK_DOWN' ? 0.0
                 : payload.height;

    // only send the first time we enter this step
    if (!inFlightJack.has(step.id)) {
      inFlightJack.add(step.id);
      console.log(`    ▶ JACK send → setHeight=${height}`);
      try {
        await sendJackCommand(robot.ip, JACK_CODES.setHeight, { height });
      } catch (e) {
        console.error(`[JACK_SEND_ERROR] ${e.message}`);
        // TCP timeout은 명령 실패가 아니므로 계속 진행
      }
    } else {
      console.log('    ▶ JACK already sent, skipping send');
    }

    // now wait for Robot.status === '대기'
    const ok = await waitUntil(async () => {
      const fresh = await Robot.findByPk(robot.id);
      // fresh가 null인 경우 처리
      if (!fresh) return false;
      return fresh.status === '대기';
    }, STEP_TIMEOUT_MS, task.id);

    console.log(`    ◀ JACK ${ok ? 'DONE' : 'TIMEOUT'}`);
    
    // JACK_UP인 경우 DI 센서 4번, 5번 확인
    if (step.type === 'JACK_UP' && ok) {
      console.log(`    ▶ JACK_UP 완료 후 DI 센서 확인 중...`);
      
      // 로봇의 최신 정보 가져오기
      const freshRobot = await Robot.findByPk(robot.id);
      let additionalInfo = {};
      
      try {
        additionalInfo = typeof freshRobot.additional_info === 'string' 
          ? JSON.parse(freshRobot.additional_info) 
          : freshRobot.additional_info || {};
      } catch (e) {
        console.error(`    ▶ additional_info 파싱 오류: ${e.message}`);
      }
      
      const diSensors = additionalInfo.diSensors || [];
      const sensor4 = diSensors.find(s => s.id === 4);
      const sensor5 = diSensors.find(s => s.id === 5);
      
      const sensor4Status = sensor4?.status === true;
      const sensor5Status = sensor5?.status === true;
      const hasCargo = sensor4Status || sensor5Status;
      
      console.log(`    ▶ DI 센서 상태: DI4=${sensor4Status}, DI5=${sensor5Status}, 화물=${hasCargo ? '감지됨' : '감지안됨'}`);
      
      if (!hasCargo) {
        // 화물이 감지되지 않은 경우
        const currentRetry = step.retry || 0;
        const maxJackRetry = 2; // JACK_UP 재시도 최대 횟수를 2회로 변경
        
        if (currentRetry < maxJackRetry) {
          console.log(`    ▶ 화물이 감지되지 않아 JACK_UP 재시도 (${currentRetry + 1}/${maxJackRetry})`);
          console.log(`    ▶ JACK_DOWN → PRE 버퍼 → 버퍼 → JACK_UP 순서로 재시도합니다.`);
          
          // 재시도 횟수 증가
          await step.update({ retry: currentRetry + 1 });
          
          // 현재 로봇 위치 확인
          const freshRobot = await Robot.findByPk(robot.id);
          const mapRow = await MapDB.findOne({ where: { is_current: true } });
          const stations = JSON.parse(mapRow.stations || '{}').stations || [];
          
          // 현재 위치가 버퍼인지 확인하고 PRE 스테이션 찾기
          const currentStation = stations.find(s => String(s.id) === String(freshRobot.location));
          if (!currentStation) {
            console.error(`    ▶ 현재 위치 스테이션을 찾을 수 없습니다: ${freshRobot.location}`);
            throw new Error('현재 위치 스테이션을 찾을 수 없습니다');
          }
          
          const preStation = stations.find(s => s.name === `${currentStation.name}_PRE`);
          if (!preStation) {
            console.error(`    ▶ ${currentStation.name}_PRE 스테이션을 찾을 수 없습니다.`);
            throw new Error(`${currentStation.name}_PRE 스테이션을 찾을 수 없습니다`);
          }
          
          try {
            // 1. JACK_DOWN (height = 0.0)
            console.log(`    ▶ 1단계: JACK_DOWN 명령 전송 (height=0.0)`);
            try {
              await sendJackCommand(robot.ip, JACK_CODES.setHeight, { height: 0.0 });
            } catch (jackError) {
              console.log(`    ▶ JACK_DOWN TCP 응답 오류 (무시): ${jackError.message}`);
              // TCP timeout은 명령 실패가 아니므로 계속 진행
            }
            
            // 2. JACK_DOWN 완료 대기
            console.log(`    ▶ 2단계: JACK_DOWN 완료 대기 중...`);
            const jackDownOk = await waitUntil(async () => {
              const fresh = await Robot.findByPk(robot.id);
              if (!fresh) return false;
              return fresh.status === '대기';
            }, STEP_TIMEOUT_MS, task.id);
            
            if (!jackDownOk) {
              console.error(`    ▶ JACK_DOWN 타임아웃 발생`);
              throw new Error('JACK_DOWN 타임아웃');
            } else {
              console.log(`    ▶ JACK_DOWN 완료`);
            }
            
            // 3. PRE 스테이션으로 이동
            console.log(`    ▶ 3단계: PRE 스테이션(${preStation.name}, ID: ${preStation.id})으로 이동`);
            await sendGotoNav(robot.ip, preStation.id, 'SELF_POSITION', `${Date.now()}`);
            
            // 4. PRE 스테이션 도착 대기
            console.log(`    ▶ 4단계: PRE 스테이션 도착 대기 중...`);
            const preNavOk = await waitUntil(async () => {
              const fresh = await Robot.findByPk(robot.id);
              if (!fresh) return false;
              console.log(`    ▶ 현재 로봇 위치: ${fresh.location}, 목표: ${preStation.id}`);
              return String(fresh.location) === String(preStation.id);
            }, STEP_TIMEOUT_MS, task.id);
            
            if (!preNavOk) {
              console.error(`    ▶ PRE 스테이션 이동 타임아웃 발생`);
              throw new Error('PRE 스테이션 이동 타임아웃');
            } else {
              console.log(`    ▶ PRE 스테이션 도착 완료`);
              // PRE 스테이션 도착 후 안정화 대기
              console.log(`    ▶ PRE 스테이션 도착 후 3초 안정화 대기`);
              await delay(3000);
            }
            
            // 5. 버퍼로 다시 이동
            console.log(`    ▶ 5단계: 버퍼(${currentStation.name}, ID: ${currentStation.id})로 다시 이동`);
            await sendGotoNav(robot.ip, currentStation.id, 'SELF_POSITION', `${Date.now()}`);
            
            // 6. 버퍼 도착 대기
            console.log(`    ▶ 6단계: 버퍼 도착 대기 중...`);
            const bufferNavOk = await waitUntil(async () => {
              const fresh = await Robot.findByPk(robot.id);
              if (!fresh) return false;
              console.log(`    ▶ 현재 로봇 위치: ${fresh.location}, 목표: ${currentStation.id}`);
              return String(fresh.location) === String(currentStation.id);
            }, STEP_TIMEOUT_MS, task.id);
            
            if (!bufferNavOk) {
              console.error(`    ▶ 버퍼 이동 타임아웃 발생`);
              throw new Error('버퍼 이동 타임아웃');
            } else {
              console.log(`    ▶ 버퍼 도착 완료`);
              // 버퍼 도착 후 안정화 대기
              console.log(`    ▶ 버퍼 도착 후 3초 안정화 대기`);
              await delay(3000);
            }
            
            // 7. 잠시 대기 (안정화)
            console.log(`    ▶ 7단계: 안정화를 위해 1초 대기`);
            await delay(1000);
            
            console.log(`    ▶ 재시도 준비 완료. 다음 tick에서 JACK_UP을 다시 시도합니다.`);
            
          } catch (e) {
            console.error(`    ▶ 재시도 과정 중 오류 발생: ${e.message}`);
            console.error(`    ▶ 재시도를 중단하고 다음 재시도 횟수로 넘어갑니다.`);
            // 오류가 발생하면 재시도 중단하고 바로 다음 JACK_UP 시도
          }
          
          // 8. inFlightJack에서 제거하여 다음 tick에서 다시 JACK_UP 명령 전송
          inFlightJack.delete(step.id);
          
          // 이 스텝을 완료하지 않고 다음 tick에서 다시 실행
          return false;
        } else {
          console.log(`    ▶ JACK_UP 최대 재시도 횟수(${maxJackRetry}) 초과. 태스크를 실패로 처리합니다.`);
          console.log(`    ▶ [오류] 화물이 제대로 잡히지 않아 작업을 중단합니다.`);
          // 최대 재시도 초과 시 태스크 실패 처리
          inFlightJack.delete(step.id); // 정리
          await task.update({ status: 'FAILED', error_message: 'JACK_UP 화물 감지 실패: 최대 재시도 횟수 초과' });
          await step.update({ status: 'FAILED', error_message: 'JACK_UP 화물 감지 실패: 최대 재시도 횟수 초과' });
          throw new Error('JACK_UP 화물 감지 실패: 최대 재시도 횟수 초과');
        }
      } else {
        console.log(`    ▶ 화물이 정상적으로 감지되었습니다. 다음 단계로 진행합니다.`);
        // 화물 감지 성공 시에는 계속 진행 (아래 return true로)
      }
    }
    
    // clear the sent‐flag so that if we retry later it will re-send
    inFlightJack.delete(step.id);

    if (!ok) throw new Error('JACK timeout');
    return true;
  }

// ── WAIT_FREE_PATH ────────────────────────────────────────────
if (step.type === 'WAIT_FREE_PATH') {
    const mapRow   = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations || '{}').stations || [];
  
    // 1) Gather path stations and other robots
    const pathSts    = stations.filter(s => hasClass(s, '경로'));
    const allRobots  = await Robot.findAll();
    const otherRobots = allRobots.filter(r => r.id !== robot.id);
    
    // 현재 로봇의 위치 확인
    const currentSt = stations.find(s => String(s.id) === String(robot.location));
    
    // 대기 스테이션에 있는지 확인
    const isAtWaitingStation = currentSt && hasClass(currentSt, '대기');
    
    // 클래스 기반 차단 체크 (대기 스테이션에 있든 없든 동일한 로직 적용)
    let blocked = false;
    const blockingRobots = [];
    const myClasses = currentSt ? getCls(currentSt) : [];
    
    if (isFirstRun) {
      console.log(`    ▶ [DEBUG] 현재 위치: ${currentSt ? currentSt.name : 'Unknown'}, 클래스=[${myClasses.join(', ')}], 대기스테이션=${isAtWaitingStation}`);
    }
    
    for (const ps of pathSts) {
      const robotOnPath = otherRobots.find(r => String(r.location) === String(ps.id));
      if (robotOnPath) {
        // 해당 로봇의 목적지 확인
        const robotDestination = robotOnPath.destination;
        
        if (isFirstRun) {
          console.log(`    ▶ [DEBUG] 경로 위 로봇 ${robotOnPath.name}: destination="${robotDestination}"`);
        }
        
        if (robotDestination) {
          // 목적지 스테이션 찾기 (이름으로 먼저 시도, 실패하면 ID로 시도)
          let destStation = stations.find(s => s.name === robotDestination);
          if (!destStation) {
            destStation = stations.find(s => String(s.id) === String(robotDestination));
            if (isFirstRun) {
              console.log(`    ▶ [DEBUG] 이름으로 찾기 실패, ID로 찾기 시도: ${destStation ? '성공' : '실패'}`);
            }
          }
          
          if (destStation) {
            const destClasses = getCls(destStation);
            
            if (isFirstRun) {
              console.log(`    ▶ [DEBUG] 목적지 스테이션 ${destStation.name}: 클래스=[${destClasses.join(', ')}]`);
              console.log(`    ▶ [DEBUG] 현재 로봇 클래스=[${myClasses.join(', ')}]`);
            }
            
            // 목적지 클래스가 현재 로봇의 클래스와 겹치는지 확인
            const hasCommonClass = myClasses.some(myClass => destClasses.includes(myClass));
            
            if (isFirstRun) {
              console.log(`    ▶ [DEBUG] 공통 클래스 있음: ${hasCommonClass}`);
            }
            
            if (hasCommonClass) {
              blocked = true;
              blockingRobots.push({
                robot: robotOnPath.name,
                location: ps.name,
                destination: destStation.name,
                commonClasses: myClasses.filter(c => destClasses.includes(c))
              });
              
              if (isFirstRun) {
                console.log(`    ▶ [DEBUG] 로봇 ${robotOnPath.name}으로 인해 차단됨`);
              }
            } else {
              if (isFirstRun) {
                console.log(`    ▶ 경로 위 로봇 ${robotOnPath.name} (${ps.name}): 목적지 ${destStation.name} 클래스가 다르므로 무시`);
              }
            }
          } else {
            if (isFirstRun) {
              console.log(`    ▶ 경로 위 로봇 ${robotOnPath.name}: 목적지 스테이션을 찾을 수 없음 (${robotDestination})`);
            }
          }
        } else {
          // 목적지가 없는 로봇은 기존처럼 차단으로 간주
          blocked = true;
          blockingRobots.push({
            robot: robotOnPath.name,
            location: ps.name,
            destination: '목적지 없음',
            commonClasses: ['목적지 미설정']
          });
          
          if (isFirstRun) {
            console.log(`    ▶ [DEBUG] 로봇 ${robotOnPath.name}: 목적지가 없어 차단됨`);
          }
        }
      }
    }
    
    // 처음 실행될 때만 상세 로그 출력
    if (isFirstRun) {
      console.log(`    ▶ WAIT_FREE_PATH 시작: 현재 로봇 클래스=[${myClasses.join(', ')}], 차단 상태=${blocked}${isAtWaitingStation ? ' (대기스테이션)' : ''}`);
      
      if (blocked && blockingRobots.length > 0) {
        console.log(`    ▶ 차단하는 로봇들:`);
        blockingRobots.forEach(info => {
          console.log(`      - ${info.robot} (${info.location}): 목적지 ${info.destination}, 공통 클래스=[${info.commonClasses.join(', ')}]`);
        });
      }
    } else {
      // 대기 중일 때는 간단한 로그만 출력
      console.log(`    ▶ WAIT_FREE_PATH 대기 중... blocked=${blocked} (차단 로봇: ${blockingRobots.length}개)${isAtWaitingStation ? ' (대기스테이션)' : ''}`);
    }
  
    if (blocked) {
      // 2) Check if we're at an IC station and need to move to waiting area
      if (currentSt && hasClass(currentSt, 'IC') && currentSt.name !== 'LM73' && String(currentSt.id) !== 'LM73') {
        const waitSt = stations.find(s =>
          hasClass(s, '대기') &&
          regionOf(s) === regionOf(currentSt)
        );
        
        if (waitSt) {
          // Check if robot is already at the waiting station
          if (String(robot.location) === String(waitSt.id)) {
            console.log(`    ▶ WAIT_FREE_PATH: 이미 대기 스테이션(${waitSt.name})에 있음, 경로 클리어 대기 중`);
            return false; // Continue waiting for path to clear
          }
          
          // Robot is at IC but not at waiting station - send to waiting station
          if (isFirstRun) {
            console.log(
              `    ▶ WAIT_FREE_PATH: path blocked and at IC(${currentSt.name}) → ` +
              `redirecting to 대기(${waitSt.name})`
            );
          }
          
          // Send navigation command to waiting station
          await sendGotoNav(robot.ip, waitSt.id, 'SELF_POSITION', `${Date.now()}`);
          
          // Wait for robot to reach the waiting station
          const reachedWaiting = await waitUntil(async () => {
            const fresh = await Robot.findByPk(robot.id);
            if (!fresh) {
              console.log(`    ▶ [DEBUG] 로봇 정보를 찾을 수 없음: robot.id=${robot.id}`);
              return false;
            }
            
            const currentLoc = fresh.location;
            const targetLoc = waitSt.id;
            
            if (currentLoc == null || targetLoc == null) {
              console.log(`    ▶ [DEBUG] 위치 정보 누락: 현재=${currentLoc}, 목표=${targetLoc}`);
              return false;
            }
            
            return String(currentLoc) === String(targetLoc);
          }, STEP_TIMEOUT_MS, task.id);
          
          if (reachedWaiting === 'INTERRUPTED') {
            console.log(`    ▶ 대기 스테이션 이동이 중단되었습니다 (태스크 상태 변경)`);
            return false;
          }
          
          if (!reachedWaiting) {
            console.log(`    ▶ 대기 스테이션 이동 타임아웃`);
            return false; // Continue trying next tick
          }
          
          console.log(`    ▶ 대기 스테이션(${waitSt.name}) 도착 완료`);
          // Now continue to wait for path to clear
          return false;
        }
      }
      // still busy, stay in this step
      return false;
    }
  
    // 3) path is clear → complete this step
    if (isFirstRun) {
      console.log(`    ▶ WAIT_FREE_PATH 완료: 경로가 클리어되었습니다.`);
    }
    return true;
  }
  
    

  // ─ NAV_OR_BUFFER (dynamic buffer steps)
  if (step.type === 'NAV_OR_BUFFER') {
    const { primary } = payload;
    // 배터리 임계값 설정 (기본값 40%)
    const batteryThreshold = 40;
    const mapRow      = await MapDB.findOne({ where: { is_current: true } });
    const stations    = JSON.parse(mapRow.stations||'{}').stations||[];
    const robots      = await Robot.findAll();

    const primarySt = stations.find(s=>s.name===primary);
    if (!primarySt) {
      throw new Error(`메인 스테이션을 찾을 수 없습니다: ${primary}`);
    }
    
    const region    = regionOf(primarySt);
    console.log(`    ▶ 목적지 확인: ${primary} (ID: ${primarySt.id}), 지역: ${region}`);
    
    // 로봇 위치 정보 로깅   
    console.log(`    ▶ 현재 로봇 위치 목록:`);
    robots.forEach(r => {
      console.log(`      - 로봇 ${r.name}: 위치 ID ${r.location}`);
    });
    
    // A4에서 B동으로 가는 특별 케이스 처리
    const currentLocation = stations.find(s => String(s.id) === String(robot.location));
    const isFromA4ToB = currentLocation && currentLocation.name === 'A4' && primary === 'B4';
    
    
    const robotsAtTarget = robots.filter(r=>String(r.location)===String(primarySt.id));
    const occupied = robotsAtTarget.length > 0;
    
    if (occupied) {
      console.log(`    ▶ 목적지(${primary})에 로봇이 있음: ${robotsAtTarget.map(r => r.name).join(', ')}`);
    } else {
      console.log(`    ▶ 목적지(${primary})가 비어 있음`);
    }

    let targetSt = primarySt;
    if (occupied) {
      // RIO 레지스터를 통해 버퍼 상태 확인
      // 해당 지역(A/B)에 맞는 RIO IP 찾기
      const rioIP = region === 'A' ? '192.168.0.6' : '192.168.0.5';
      const riosData = getRIOS(); // 함수를 통해 RIOS 가져오기
      const rioDevice = riosData[rioIP];
      
      // 버퍼 상태 확인 (레지스터 4,5,6 값으로 버퍼 상태 확인)
      const bufferStates = {};
      let rioConnected = false;
      
      try {
        if (rioDevice && rioDevice.connected && rioDevice.lastRegs) {
          // 레지스터 값 전체 로깅
          console.log(`    ▶ RIO 레지스터 값: ${JSON.stringify(rioDevice.lastRegs)}`);
          
          // 레지스터 인덱스 주의: A1/B1 => 4, A2/B2 => 5, A3/B3 => 6
          bufferStates[`${region}1`] = rioDevice.lastRegs[4] === 1;
          bufferStates[`${region}2`] = rioDevice.lastRegs[5] === 1;
          bufferStates[`${region}3`] = rioDevice.lastRegs[6] === 1;
          console.log(`    ▶ 버퍼 상태 확인: ${JSON.stringify(bufferStates)}`);
          console.log(`    ▶ ${region}1 버퍼: ${bufferStates[`${region}1`] ? '차있음' : '비어있음'} (레지스터 4: ${rioDevice.lastRegs[4]})`);
          console.log(`    ▶ ${region}2 버퍼: ${bufferStates[`${region}2`] ? '차있음' : '비어있음'} (레지스터 5: ${rioDevice.lastRegs[5]})`);
          console.log(`    ▶ ${region}3 버퍼: ${bufferStates[`${region}3`] ? '차있음' : '비어있음'} (레지스터 6: ${rioDevice.lastRegs[6]})`);
          rioConnected = true;
        } else {
          console.log(`    ▶ RIO 연결 안됨 또는 레지스터 값 없음: ${rioIP}`);
          if (rioDevice) {
            console.log(`    ▶ RIO 상세 정보: connected=${rioDevice.connected}, lastRegs=${rioDevice.lastRegs ? '있음' : '없음'}`);
          }
        }
      } catch (err) {
        console.error(`    ▶ RIO 상태 확인 오류: ${err.message}`);
      }

      // RIO 버퍼 상태 확인 후 비어있는 버퍼 찾기
      // 버퍼 검색: 
      // 1. 로봇이 없어야 함
      // 2. 버퍼 스테이션이어야 함
      // 3. 같은 지역이어야 함
      // 4. RIO 레지스터 값으로 비어있는지 확인 (A1~A3, B1~B3인 경우)
      targetSt = stations.find(s => {
        if (regionOf(s) !== region || !hasClass(s, '버퍼')) {
          return false;
        }

        // A1~A3, B1~B3 형식의 버퍼인 경우 RIO 레지스터로 확인
        if (rioConnected && s.name.match(/^[AB][1-3]$/)) {
          const bufferNum = s.name.charAt(1);  // 1, 2, 3
          const regIdx = 3 + parseInt(bufferNum); // 4, 5, 6
          const isFull = rioDevice.lastRegs[regIdx] === 1;
          console.log(`    ▶ 버퍼 ${s.name}: RIO 레지스터 ${regIdx}번 값 ${rioDevice.lastRegs[regIdx]}에 따라 ${isFull ? '차있음' : '비어있음'}`);
          
          if (isFull) {
            return false; // 차 있으면 제외
          }
        } 
        
        // RIO로 확인할 수 없는 경우 로봇 위치로 확인
        const robotPresent = robots.some(r => String(r.location) === String(s.id));
        if (robotPresent) {
          console.log(`    ▶ 버퍼 ${s.name}: 이미 로봇이 있어 제외`);
          return false;
        }
        
        console.log(`    ▶ 버퍼 ${s.name}: 적합한 빈 버퍼로 선택됨`);
        return true; // 모든 조건 통과
      });
      
      // 모든 버퍼가 차있는 경우 에러 처리
      if (!targetSt) {
        console.log(`    ▶ 모든 ${region} 버퍼가 차있습니다. 버퍼 체크 단계를 추가합니다.`);
        // 해당 영역의 첫 번째 버퍼를 대상으로 버퍼 체크 단계 추가
        await TaskStep.bulkCreate([
          { task_id:task.id, seq:step.seq+1, type:'CHECK_BUFFER_BEFORE_NAV',
            payload:JSON.stringify({ target:`${region}1`, fallback:primary }) },
        ]);
        await step.update({status:'DONE' });
        return true;
      }
    }

    if (targetSt.id === primarySt.id) {
      console.log(`    ▶ 목적지(${primary})가 이미 비어있음`);
      
      // 배터리 레벨 확인
      const batteryLevel = robot.battery || 0;
      console.log(`    ▶ 현재 배터리 레벨: ${batteryLevel}%`);
      
      // A4에서 B4로 이동하는 특별한 경우를 다시 체크 (이중 안전장치)
      if (currentLocation && currentLocation.name === 'A4' && primary === 'B4') {
        //console.log(`    ▶ [경고] A4에서 B4로 직접 이동하려는 시도가 감지되었습니다. 이 경로는 금지되어 있습니다.`);
        console.log(`    ▶ A4에서 대기합니다. 다른 경로를 사용하세요.`);
        await step.update({ status: 'DONE' });
        return true;
      }

      // 배터리가 40% 이하이고 B4로 이동하는 경우
     
        console.log(`    ▶ 목적지(${primary})로 바로 이동합니다.`);
        await sendGotoNav(robot.ip, targetSt.id, 'SELF_POSITION', `${Date.now()}`);
        
        // 위치 확인 추가
        const ok = await waitUntil(async () => {
          const fresh = await Robot.findByPk(robot.id);
          if (!fresh) {
            console.log(`    ▶ [DEBUG] 로봇 정보를 찾을 수 없음: robot.id=${robot.id}`);
            return false;
          }
          
          const currentLoc = fresh.location;
          const targetLoc = targetSt.id;
          //console.log(`    ▶ [DEBUG] 위치 확인: 현재=${currentLoc}, 목표=${targetLoc}, 일치=${String(currentLoc) === String(targetLoc)}`);
          
          if (currentLoc == null || targetLoc == null) {
            console.log(`    ▶ [DEBUG] 위치 정보 누락: 현재=${currentLoc}, 목표=${targetLoc}`);
            return false;
          }
          
          return String(currentLoc) === String(targetLoc);
        }, STEP_TIMEOUT_MS, task.id);
        
        console.log(`    ◀ NAV_OR_BUFFER ${ok === 'INTERRUPTED' ? 'INTERRUPTED' : ok ? 'DONE' : 'TIMEOUT'}`);
        
        if (ok === 'INTERRUPTED') {
          console.log(`    ▶ NAV_OR_BUFFER 명령이 중단되었습니다 (태스크 상태 변경)`);
          return false;
        }
        
        if (!ok) throw new Error('NAV_OR_BUFFER timeout');
        
        await step.update({ status: 'DONE' });
        return true;
      
    } else {
      const pre = stations.find(s=>s.name===`${targetSt.name}_PRE`);
      if (!pre) throw new Error('no PRE station for buffer');
      console.log(`    ▶ 목적지(${primary})가 차있어 대체 버퍼(${targetSt.name})의 PRE 스테이션으로 이동 후 상태 확인 단계를 추가합니다.`);
      await TaskStep.bulkCreate([
        { task_id:task.id, seq:step.seq+1, type:'NAV_PRE',
          payload:JSON.stringify({ dest:pre.id }) },
        { task_id:task.id, seq:step.seq+2, type:'CHECK_BUFFER_BEFORE_NAV',
          payload:JSON.stringify({ target:targetSt.name, fallback:primary }) },
      ]);
      await step.update({ status:'DONE' });
    }
    return true;
  }
  
  // ─ CHECK_BUFFER_BEFORE_NAV: 버퍼 상태 확인 (JACK_UP 전에 확인)
  if (step.type === 'CHECK_BUFFER_BEFORE_NAV') {
    const { target, fallback } = payload;
    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations||'{}').stations||[];
    const robots = await Robot.findAll();
    const batteryThreshold = 40;

    const targetSt = stations.find(s=>s.name===target);
    if (!targetSt) {
      throw new Error(`목적지 스테이션을 찾을 수 없습니다: ${target}`);
    }
    
    const region = regionOf(targetSt);
    
    // 버퍼 상태 확인 - 로봇의 위치와 버퍼 ID 비교
    console.log(`    ▶ 버퍼 확인 대상: ${target} (ID: ${targetSt.id})`);
    
    // 모든 로봇 위치 로깅
    console.log(`    ▶ 현재 로봇 위치 목록:`);
    robots.forEach(r => {
      console.log(`      - 로봇 ${r.name}: 위치 ID ${r.location}`);
    });
    
    // RIO 레지스터를 통해 버퍼 상태 확인
    const rioIP = region === 'A' ? '192.168.0.6' : '192.168.0.5';
    const riosData = getRIOS();
    const rioDevice = riosData[rioIP];
    
    console.log(`    ▶ RIO 확인 (IP: ${rioIP})`);
    console.log(`    ▶ RIO 연결 상태: ${rioDevice?.connected ? '연결됨' : '연결안됨'}`);
    
    const bufferStates = {};
    let rioConnected = false;
    
    try {
      if (rioDevice && rioDevice.connected && rioDevice.lastRegs) {
        // 레지스터 값 전체 로깅
        console.log(`    ▶ RIO 레지스터 값: ${JSON.stringify(rioDevice.lastRegs)}`);
        
        // 레지스터 인덱스 주의: A1/B1 => 4, A2/B2 => 5, A3/B3 => 6
        bufferStates[`${region}1`] = rioDevice.lastRegs[4] === 1;
        bufferStates[`${region}2`] = rioDevice.lastRegs[5] === 1;
        bufferStates[`${region}3`] = rioDevice.lastRegs[6] === 1;
        console.log(`    ▶ 버퍼 상태 확인: ${JSON.stringify(bufferStates)}`);
        console.log(`    ▶ ${region}1 버퍼: ${bufferStates[`${region}1`] ? '차있음' : '비어있음'} (레지스터 4: ${rioDevice.lastRegs[4]})`);
        console.log(`    ▶ ${region}2 버퍼: ${bufferStates[`${region}2`] ? '차있음' : '비어있음'} (레지스터 5: ${rioDevice.lastRegs[5]})`);
        console.log(`    ▶ ${region}3 버퍼: ${bufferStates[`${region}3`] ? '차있음' : '비어있음'} (레지스터 6: ${rioDevice.lastRegs[6]})`);
        rioConnected = true;
      } else {
        console.log(`    ▶ RIO 연결 안됨 또는 레지스터 값 없음: ${rioIP}`);
        if (rioDevice) {
          console.log(`    ▶ RIO 상세 정보: connected=${rioDevice.connected}, lastRegs=${rioDevice.lastRegs ? '있음' : '없음'}`);
        }
      }
    } catch (err) {
      console.error(`    ▶ RIO 상태 확인 오류: ${err.message}`);
    }
    
    // 버퍼 상태 확인 로직
    let isBufferOccupied;
    
    // RIO 레지스터 값이 있는 경우 이를 우선 사용
    if (rioConnected && target.match(/^[AB][1-3]$/)) {
      // A1, A2, A3, B1, B2, B3 형식의 버퍼
      const bufferNum = target.charAt(1);  // 1, 2, 3
      const regIdx = 3 + parseInt(bufferNum); // 4, 5, 6
      isBufferOccupied = rioDevice.lastRegs[regIdx] === 1;
      console.log(`    ▶ 버퍼 ${target} 상태: RIO 레지스터 ${regIdx}번 값 ${rioDevice.lastRegs[regIdx]}에 따라 ${isBufferOccupied ? '차있음' : '비어있음'}`);
    } else {
      // RIO 레지스터 값이 없는 경우나 A4, B4 등은 로봇 위치로 확인
      const robotsAtTarget = robots.filter(r => String(r.location) === String(targetSt.id));
      isBufferOccupied = robotsAtTarget.length > 0;
      console.log(`    ▶ 버퍼 ${target} 상태: 로봇 위치로 확인 - ${isBufferOccupied ? '차있음' : '비어있음'}`);
      if (isBufferOccupied) {
        console.log(`    ▶ 위치한 로봇: ${robotsAtTarget.map(r => r.name).join(', ')}`);
      }
    }
    
    // 목적지가 비어있으면 JACK_UP, NAV, JACK_DOWN 스텝 추가
    if (!isBufferOccupied) {
      console.log(`    ▶ 버퍼(${target})가 비어있어 이동 단계 추가`);
      
      // 배터리 레벨 확인
      const batteryLevel = robot.battery || 0;
      console.log(`    ▶ 현재 배터리 레벨: ${batteryLevel}%`);
      
      // 배터리가 40% 이하이고 B4로 이동하는 경우
      if (batteryLevel <= batteryThreshold && primary === 'B4') {
        console.log(`    ▶ 배터리 레벨이 낮아 충전 스테이션으로 이동합니다.`);
        
        // B 지역의 충전 스테이션 찾기
        const chargeStations = stations.filter(s => 
          regionOf(s) === 'B' && 
          hasClass(s, '충전')
        );
        
        console.log(`    ▶ B 지역 충전 스테이션 목록: ${chargeStations.map(s => s.name).join(', ')}`);
        
        if (chargeStations.length === 0) {
          console.log(`    ▶ [오류] B 지역에 충전 스테이션이 없습니다!`);
        } else {
          console.log(`    ▶ 충전 스테이션 점유 상태:`);
          chargeStations.forEach(s => {
            const occupied = robots.some(r => String(r.location) === String(s.id));
            console.log(`      - ${s.name}: ${occupied ? '사용 중' : '비어있음'}`);
          });
        }
        
        // 비어있는 충전 스테이션 찾기
        const availableChargeStation = chargeStations.find(s => 
          !robots.some(r => String(r.location) === String(s.id))
        );
        
        if (availableChargeStation) {
          console.log(`    ▶ 사용 가능한 충전 스테이션 찾음: ${availableChargeStation.name}`);
          
          // 충전 스테이션의 PRE 스테이션 찾기
          const chargePre = stations.find(s => s.name === `${availableChargeStation.name}_PRE`);
          
          // 충전 스테이션으로 이동하는 단계
          let currentSeq = step.seq+1;
          const chargeSteps = [];
          
          // 먼저 JACK_DOWN 수행 (버퍼에서 화물 내리기)
          chargeSteps.push({ task_id: task.id, seq: currentSeq++, type: 'JACK_DOWN',
            payload: JSON.stringify({ height: 0.0 }) });
          
          if (chargePre) {
            // PRE 스테이션이 있으면 PRE 스테이션으로 먼저 이동
            chargeSteps.push(
              { task_id: task.id, seq: currentSeq++, type: 'NAV',
                payload: JSON.stringify({ dest: chargePre.id }) }
            );
          }
          
          // 충전 스테이션으로 이동
          chargeSteps.push(
            { task_id: task.id, seq: currentSeq++, type: 'NAV',
              payload: JSON.stringify({ dest: availableChargeStation.id }) }
          );
          
          // 충전 단계 추가
          await TaskStep.bulkCreate(chargeSteps);
          await step.update({ status: 'DONE' });
          return true;
        } else {
          console.log(`    ▶ 사용 가능한 충전 스테이션이 없습니다. 현재 버퍼에서 대기합니다.`);
        }
      }
      
      // 충전 스테이션으로 이동하지 않는 경우 기존 단계 추가
      const pre = stations.find(s=>s.name===`${target}_PRE`);
      if (!pre) throw new Error('no PRE station for buffer');
      
      await TaskStep.bulkCreate([
        { task_id: task.id, seq: step.seq+1, type: 'NAV_PRE',
          payload: JSON.stringify({ dest: pre.id }) },
        { task_id: task.id, seq: step.seq+2, type: 'JACK_UP',
          payload: JSON.stringify({ height: 0.03 }) },
        { task_id: task.id, seq: step.seq+3, type: 'NAV',
          payload: JSON.stringify({ dest: targetSt.id }) },
        // { task_id: task.id, seq: step.seq+4, type: 'JACK_DOWN',
        //   payload: JSON.stringify({ height: 0.0 }) }
      ]);
      await step.update({ status: 'DONE' });
      return true;
    }
    
    console.log(`    ▶ 목적지 버퍼(${target})가 이미 차있음. 다른 버퍼 확인 중...`);
    

    
    if (mainOccupiedByRobots) {
      console.log(`    ▶ ${mainPoint}에 로봇이 있음: ${robotsAtMain.map(r => r.name).join(', ')}`);
    } else {
      console.log(`    ▶ ${mainPoint}에 로봇이 없음. 이동 가능`);
    }
    
    // A4/B4가 비어있으면 이동
    if (!mainOccupiedByRobots && mainSt) {
      console.log(`    ▶ ${mainPoint}가 비어있음. 이곳으로 이동합니다.`);
      const mainPre = stations.find(s=>s.name===`${mainPoint}_PRE`);
      if (mainPre) {
        // 메인 위치 PRE 스테이션으로 이동 후 다시 버퍼 확인
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'NAV',
            payload: JSON.stringify({ dest: mainPre.id }) },
          { task_id: task.id, seq: step.seq+2, type: 'CHECK_BUFFER_BEFORE_NAV',
            payload: JSON.stringify({ target: mainPoint, fallback }) },
        ]);
      } else {
        // PRE 스테이션이 없으면 직접 이동 후 JACK 작업
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }) },
          { task_id: task.id, seq: step.seq+2, type: 'NAV',
            payload: JSON.stringify({ dest: mainSt.id }) },
          // { task_id: task.id, seq: step.seq+3, type: 'JACK_DOWN',
          //   payload: JSON.stringify({ height: 0.0 }) },
        ]);
      }
      await step.update({ status: 'DONE' });
      return true;
    }
    
    // A4/B4가 차있으면, 다른 빈 버퍼 찾기 (이미 위에서 RIO 정보 가져옴)
    // 빈 버퍼 찾기
    console.log(`    ▶ 대체 버퍼 검색 중...`);
    const allBuffers = stations.filter(s => regionOf(s) === region && hasClass(s, '버퍼'));
    console.log(`    ▶ ${region} 지역 버퍼 목록: ${allBuffers.map(b => b.name).join(', ')}`);
    
    const altBufferSt = stations.find(s => {
      if (s.name === target) {
        console.log(`    ▶ 버퍼 ${s.name}: 원래 목적지이므로 제외`);
        return false;
      }
      // A4/B4인 경우 제외 (나중에 고려)
      if (s.name === `${region}4`) {
        console.log(`    ▶ 버퍼 ${s.name}: 메인 위치이므로 나중에 고려`);
        return false;
      }
      if (regionOf(s) !== region || !hasClass(s, '버퍼')) {
        return false;
      }
      
      // A1~A3, B1~B3 형식의 버퍼인 경우 RIO 레지스터로 확인
      if (rioConnected && s.name.match(/^[AB][1-3]$/)) {
        const bufferNum = s.name.charAt(1);  // 1, 2, 3
        const regIdx = 3 + parseInt(bufferNum); // 4, 5, 6
        const isFull = rioDevice.lastRegs[regIdx] === 1;
        console.log(`    ▶ 버퍼 ${s.name}: RIO 레지스터 ${regIdx}번 값 ${rioDevice.lastRegs[regIdx]}에 따라 ${isFull ? '차있음' : '비어있음'}`);
        return !isFull; // 비어있으면 true
      }
      
      // 그 외의 경우 로봇 위치로 확인
      const robotPresent = robots.some(r => String(r.location) === String(s.id));
      if (robotPresent) {
        console.log(`    ▶ 버퍼 ${s.name}: 이미 로봇이 있어 제외`);
        return false;
      }
      
      console.log(`    ▶ 버퍼 ${s.name}: 로봇 위치로만 판단 - 비어있음`);
      return true; // 로봇이 없으면 비어있다고 판단
    });
    
    if (altBufferSt) {
      console.log(`    ▶ 대체 버퍼(${altBufferSt.name})를 찾았습니다. 이곳으로 이동합니다.`);
      const altPre = stations.find(s=>s.name===`${altBufferSt.name}_PRE`);
      if (altPre) {
        // 대체 버퍼 PRE 스테이션으로 이동 후 다시 버퍼 확인
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'NAV',
            payload: JSON.stringify({ dest: altPre.id }) },
          { task_id: task.id, seq: step.seq+2, type: 'CHECK_BUFFER_WITHOUT_CHARGING',
            payload: JSON.stringify({ 
              target: altBufferSt.name, 
              fallback
            }) 
          },
        ]);
      } else {
        // PRE 스테이션이 없으면 직접 이동 후 JACK 작업
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }) },
          { task_id: task.id, seq: step.seq+2, type: 'NAV',
            payload: JSON.stringify({ dest: altBufferSt.id }) },
          // { task_id: task.id, seq: step.seq+3, type: 'JACK_DOWN',
          //   payload: JSON.stringify({ height: 0.0 }) },
        ]);
      }
      await step.update({ status: 'DONE' });
      return true;
    }
    
    // 2. A1/A2/A3 또는 B1/B2/B3 버퍼가 모두 차있을 경우 A4/B4 확인
    console.log(`    ▶ 일반 버퍼(${region}1, ${region}2, ${region}3)가 모두 차있습니다. ${region}4 확인 중...`);
    
    // A4/B4가 비어있는지 확인
    const mainPoint = `${region}4`;
    const mainSt = stations.find(s=>s.name===mainPoint);
    
    // 로봇 위치로 A4/B4 상태 확인
    const robotsAtMain = robots.filter(r => String(r.location) === String(mainSt?.id));
    const mainOccupiedByRobots = robotsAtMain.length > 0;
    
    if (mainOccupiedByRobots) {
      console.log(`    ▶ ${mainPoint}에 로봇이 있음: ${robotsAtMain.map(r => r.name).join(', ')}`);
    } else {
      console.log(`    ▶ ${mainPoint}에 로봇이 없음. 이동 가능`);
    }
    
    // A4/B4가 비어있으면 이동
    if (!mainOccupiedByRobots && mainSt) {
      console.log(`    ▶ ${mainPoint}가 비어있음. 이곳으로 이동합니다.`);
      const mainPre = stations.find(s=>s.name===`${mainPoint}_PRE`);
      if (mainPre) {
        // 메인 위치 PRE 스테이션으로 이동 후 다시 버퍼 확인
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'NAV',
            payload: JSON.stringify({ dest: mainPre.id }) },
          { task_id: task.id, seq: step.seq+2, type: 'CHECK_BUFFER_BEFORE_NAV',
            payload: JSON.stringify({ target: mainPoint, fallback }) },
        ]);
      } else {
        // PRE 스테이션이 없으면 직접 이동 후 JACK 작업
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }) },
          { task_id: task.id, seq: step.seq+2, type: 'NAV',
            payload: JSON.stringify({ dest: mainSt.id }) },
          // { task_id: task.id, seq: step.seq+3, type: 'JACK_DOWN',
          //   payload: JSON.stringify({ height: 0.0 }) },
          // 버퍼 이동 후 배터리 체크 단계 추가
          { task_id: task.id, seq: step.seq+4, type: 'CHECK_BATTERY_AFTER_BUFFER',
            payload: JSON.stringify({ 
              batteryThreshold: 40  // 40% 이하면 충전
            }) 
          }
        ]);
      }
      await step.update({ status: 'DONE' });
      return true;
    }
    
    // 모든 버퍼가 차있는 경우 계속 대기 (false 반환으로 대기 상태 유지)
    console.log(`    ▶ 모든 ${region} 버퍼(1~4)가 차있습니다. 빈 버퍼가 생길 때까지 대기합니다.`);
    // 대기 시간을 5초로 설정 (다음 tick에서 다시 체크)
    await delay(5000);
    return false; // 이 스텝을 완료하지 않고 다음 tick에서 다시 체크
  }

  // ─ FIND_EMPTY_B_BUFFER: A4에서 B동으로 이동할 때 B1, B2, B3 중 빈 버퍼 찾아 이동
  if (step.type === 'FIND_EMPTY_B_BUFFER') {
    console.log(`    ▶ A4에서 B동으로 이동: B 지역 빈 버퍼 찾기`);
    
    // 목적지를 B4로 설정 (A4에서 B4로 이동하는 특별한 케이스를 처리하는 함수임)
    const primary = 'B4';
    
    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations||'{}').stations||[];
    const robots = await Robot.findAll();
    
    // RIO로 B지역 버퍼 상태 확인
    const rioIP = '192.168.0.5';  // B지역 RIO
    const riosData = getRIOS();
    const rioDevice = riosData[rioIP];
    
    console.log(`    ▶ RIO 확인 (IP: ${rioIP})`);
    console.log(`    ▶ RIO 연결 상태: ${rioDevice?.connected ? '연결됨' : '연결안됨'}`);
    
    const bufferStates = {};
    let rioConnected = false;
    
    try {
      if (rioDevice && rioDevice.connected && rioDevice.lastRegs) {
        // 레지스터 값 전체 로깅
        console.log(`    ▶ RIO 레지스터 값: ${JSON.stringify(rioDevice.lastRegs)}`);
        
        // B1, B2, B3 버퍼 상태 확인
        bufferStates['B1'] = rioDevice.lastRegs[4] === 1;
        bufferStates['B2'] = rioDevice.lastRegs[5] === 1;
        bufferStates['B3'] = rioDevice.lastRegs[6] === 1;
        console.log(`    ▶ B 지역 버퍼 상태 확인: ${JSON.stringify(bufferStates)}`);
        console.log(`    ▶ B1 버퍼: ${bufferStates['B1'] ? '차있음' : '비어있음'}`);
        console.log(`    ▶ B2 버퍼: ${bufferStates['B2'] ? '차있음' : '비어있음'}`);
        console.log(`    ▶ B3 버퍼: ${bufferStates['B3'] ? '차있음' : '비어있음'}`);
        rioConnected = true;
      } else {
        console.log(`    ▶ RIO 연결 안됨 또는 레지스터 값 없음: ${rioIP}`);
      }
    } catch (err) {
      console.error(`    ▶ RIO 상태 확인 오류: ${err.message}`);
    }
    
    // 빈 버퍼 찾기 (B1, B2, B3 중)
    let emptyBuffer = null;
    
    if (rioConnected) {
      // RIO 정보로 빈 버퍼 찾기
      if (!bufferStates['B1']) emptyBuffer = 'B1';
      else if (!bufferStates['B2']) emptyBuffer = 'B2';
      else if (!bufferStates['B3']) emptyBuffer = 'B3';
    } else {
      // 로봇 위치 정보로 빈 버퍼 찾기
      const b1 = stations.find(s => s.name === 'B1');
      const b2 = stations.find(s => s.name === 'B2');
      const b3 = stations.find(s => s.name === 'B3');
      
      const robotAtB1 = b1 ? robots.some(r => String(r.location) === String(b1.id)) : true;
      const robotAtB2 = b2 ? robots.some(r => String(r.location) === String(b2.id)) : true;
      const robotAtB3 = b3 ? robots.some(r => String(r.location) === String(b3.id)) : true;
      
      if (!robotAtB1) emptyBuffer = 'B1';
      else if (!robotAtB2) emptyBuffer = 'B2';
      else if (!robotAtB3) emptyBuffer = 'B3';
    }
    
    // 빈 버퍼가 있으면 거기로 이동
    if (emptyBuffer) {
      console.log(`    ▶ 빈 B지역 버퍼 찾음: ${emptyBuffer}`);
      
      // 배터리 레벨 확인 - 단순 로깅 목적
      const batteryLevel = robot.battery || 0;
      console.log(`    ▶ 현재 배터리 레벨: ${batteryLevel}%`);
      
      // A 영역 이동과 동일하게 CHECK_BUFFER_BEFORE_NAV 단계 추가
      // 이 함수는 마지막으로 한번 더 버퍼 상태를 체크하고 이동
      const emptyBufferPre = stations.find(s => s.name === `${emptyBuffer}_PRE`);
      
      if (emptyBufferPre) {
        console.log(`    ▶ ${emptyBuffer} 버퍼로 이동 단계 추가 (PRE 스테이션으로 먼저 이동)`);
        
        // 1. 먼저 PRE 스테이션으로 이동
        // 2. 마지막으로 버퍼 상태 체크 (이동 후 배터리 체크 안함)
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'NAV_PRE',
            payload: JSON.stringify({ dest: emptyBufferPre.id }) },
          { task_id: task.id, seq: step.seq+2, type: 'CHECK_BUFFER_WITHOUT_CHARGING',
            payload: JSON.stringify({ 
              target: emptyBuffer, 
              fallback: primary
            }) 
          }
        ]);
        
        await step.update({ status: 'DONE' });
        return true;
      } else {
        console.log(`    ▶ ${emptyBuffer} 버퍼의 PRE 스테이션을 찾을 수 없습니다.`);
        await step.update({ status: 'DONE' });
        return true;
      }
    } else {
      // 빈 버퍼가 없으면 B4 상태 확인
      console.log(`    ▶ B 지역에 빈 버퍼가 없습니다. B4 상태 확인 중...`);
      
      // 1. B4에 있는 AMR 확인
      const b4Station = stations.find(s => s.name === 'B4');
      let robotAtB4 = null;
      if (b4Station) {
        robotAtB4 = robots.find(r => String(r.location) === String(b4Station.id));
        if (robotAtB4) {
          console.log(`    ▶ B4에 AMR이 있습니다: ${robotAtB4.name}`);
        } else {
          console.log(`    ▶ B4에 AMR이 없습니다.`);
        }
      }
      
      // 2. 목적지가 B4인 다른 AMR 확인 (현재 로봇 제외)
      const { checkDestinationConflict } = require('./dispatcherService');
      const hasB4Conflict = !(await checkDestinationConflict(b4Station?.id, robot.id));
      
      if (hasB4Conflict) {
        console.log(`    ▶ 목적지가 B4인 다른 AMR이 있습니다.`);
      } else {
        console.log(`    ▶ 목적지가 B4인 다른 AMR이 없습니다.`);
      }
      
      // 3. 결정 로직
      if (robotAtB4 || hasB4Conflict) {
        // B4에 AMR이 있거나 목적지가 B4인 다른 AMR이 있으면 B 지역 대기 스테이션으로 이동
        console.log(`    ▶ B4가 점유되어 있어 B 지역 대기 스테이션으로 이동합니다.`);
        
        // B 지역의 '대기' 스테이션 찾기
        const bWaitStation = stations.find(s => 
          regionOf(s) === 'B' && hasClass(s, '대기')
        );
        
        if (bWaitStation) {
          console.log(`    ▶ B 지역 대기 스테이션 ${bWaitStation.name}으로 이동합니다.`);
          
          // 현재 로봇이 이미 대기 스테이션에 있는지 확인
          const isAlreadyAtWaitStation = String(robot.location) === String(bWaitStation.id);
          
          if (isAlreadyAtWaitStation) {
            // 이미 대기 스테이션에 있으면 스텝을 완료하지 않고 다음 tick에서 재확인
            console.log(`    ▶ 이미 B 지역 대기 스테이션에 있습니다. 다음 tick에서 재확인합니다.`);
            return false;
          } else {
            // 대기 스테이션으로 이동
            await TaskStep.create({
              task_id: task.id,
              seq: step.seq + 1,
              type: 'NAV',
              payload: JSON.stringify({ dest: bWaitStation.id }),
              status: 'PENDING'
            });
            
            await step.update({ status: 'DONE' });
            return true;
          }
        } else {
          console.error(`    ▶ B 지역 대기 스테이션을 찾을 수 없습니다. 현재 위치에서 대기합니다.`);
          // 대기 스테이션을 찾을 수 없으면 다음 tick에서 다시 확인
          return false;
        }
      } else {
        // B4가 비어있고 목적지로 하는 AMR도 없으면 B4로 이동
        console.log(`    ▶ B4가 비어있어 B4로 이동합니다.`);
        
        if (b4Station) {
          await TaskStep.create({
            task_id: task.id,
            seq: step.seq + 1,
            type: 'NAV',
            payload: JSON.stringify({ dest: b4Station.id }),
            status: 'PENDING'
          });
          
          await step.update({ status: 'DONE' });
          return true;
        } else {
          console.error(`    ▶ B4 스테이션을 찾을 수 없습니다.`);
          await step.update({ status: 'DONE' });
          return true;
        }
      }
    }
    
    // 문제가 발생한 경우 (빈 버퍼 없음 + 다른 오류)
    return true;
  }
  
  // ─ CHECK_BUFFER_WITHOUT_CHARGING: 버퍼 상태 확인 후 이동 (배터리 체크는 나중에)
  if (step.type === 'CHECK_BUFFER_WITHOUT_CHARGING') {
    const { target, fallback } = payload;
    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations||'{}').stations||[];
    const robots = await Robot.findAll();

    const targetSt = stations.find(s=>s.name===target);
    if (!targetSt) {
      throw new Error(`목적지 스테이션을 찾을 수 없습니다: ${target}`);
    }
    
    const region = regionOf(targetSt);
    
    // 버퍼 상태 확인 - 로봇의 위치와 버퍼 ID 비교
    console.log(`    ▶ 버퍼 확인 대상: ${target} (ID: ${targetSt.id})`);
    
    // 모든 로봇 위치 로깅
    console.log(`    ▶ 현재 로봇 위치 목록:`);
    robots.forEach(r => {
      console.log(`      - 로봇 ${r.name}: 위치 ID ${r.location}`);
    });
    
    // RIO 레지스터를 통해 버퍼 상태 확인
    const rioIP = region === 'A' ? '192.168.0.6' : '192.168.0.5';
    const riosData = getRIOS();
    const rioDevice = riosData[rioIP];
    
    console.log(`    ▶ RIO 확인 (IP: ${rioIP})`);
    console.log(`    ▶ RIO 연결 상태: ${rioDevice?.connected ? '연결됨' : '연결안됨'}`);
    
    const bufferStates = {};
    let rioConnected = false;
    
    try {
      if (rioDevice && rioDevice.connected && rioDevice.lastRegs) {
        // 레지스터 값 전체 로깅
        console.log(`    ▶ RIO 레지스터 값: ${JSON.stringify(rioDevice.lastRegs)}`);
        
        // 레지스터 인덱스 주의: A1/B1 => 4, A2/B2 => 5, A3/B3 => 6
        bufferStates[`${region}1`] = rioDevice.lastRegs[4] === 1;
        bufferStates[`${region}2`] = rioDevice.lastRegs[5] === 1;
        bufferStates[`${region}3`] = rioDevice.lastRegs[6] === 1;
        console.log(`    ▶ 버퍼 상태 확인: ${JSON.stringify(bufferStates)}`);
        console.log(`    ▶ ${region}1 버퍼: ${bufferStates[`${region}1`] ? '차있음' : '비어있음'} (레지스터 4: ${rioDevice.lastRegs[4]})`);
        console.log(`    ▶ ${region}2 버퍼: ${bufferStates[`${region}2`] ? '차있음' : '비어있음'} (레지스터 5: ${rioDevice.lastRegs[5]})`);
        console.log(`    ▶ ${region}3 버퍼: ${bufferStates[`${region}3`] ? '차있음' : '비어있음'} (레지스터 6: ${rioDevice.lastRegs[6]})`);
        rioConnected = true;
      } else {
        console.log(`    ▶ RIO 연결 안됨 또는 레지스터 값 없음: ${rioIP}`);
        if (rioDevice) {
          console.log(`    ▶ RIO 상세 정보: connected=${rioDevice.connected}, lastRegs=${rioDevice.lastRegs ? '있음' : '없음'}`);
        }
      }
    } catch (err) {
      console.error(`    ▶ RIO 상태 확인 오류: ${err.message}`);
    }
    
    // 버퍼 상태 확인 로직
    let isBufferOccupied;
    
    // RIO 레지스터 값이 있는 경우 이를 우선 사용
    if (rioConnected && target.match(/^[AB][1-3]$/)) {
      // A1, A2, A3, B1, B2, B3 형식의 버퍼
      const bufferNum = target.charAt(1);  // 1, 2, 3
      const regIdx = 3 + parseInt(bufferNum); // 4, 5, 6
      isBufferOccupied = rioDevice.lastRegs[regIdx] === 1;
      console.log(`    ▶ 버퍼 ${target} 상태: RIO 레지스터 ${regIdx}번 값 ${rioDevice.lastRegs[regIdx]}에 따라 ${isBufferOccupied ? '차있음' : '비어있음'}`);
    } else {
      // RIO 레지스터 값이 없는 경우나 A4, B4 등은 로봇 위치로 확인
      const robotsAtTarget = robots.filter(r => String(r.location) === String(targetSt.id));
      isBufferOccupied = robotsAtTarget.length > 0;
      console.log(`    ▶ 버퍼 ${target} 상태: 로봇 위치로 확인 - ${isBufferOccupied ? '차있음' : '비어있음'}`);
      if (isBufferOccupied) {
        console.log(`    ▶ 위치한 로봇: ${robotsAtTarget.map(r => r.name).join(', ')}`);
      }
    }
    
    // 목적지가 비어있으면 JACK_UP, NAV, JACK_DOWN 스텝 추가 + 배터리 체크 스텝 추가
    if (!isBufferOccupied) {
      console.log(`    ▶ 버퍼(${target})가 비어있어 이동 단계 추가`);
      
      // 1. 먼저 버퍼로 이동하는 단계 추가
      let currentSeq = step.seq+1;
      await TaskStep.bulkCreate([
        { task_id: task.id, seq: currentSeq++, type: 'JACK_UP',
          payload: JSON.stringify({ height: 0.03 }) },
        { task_id: task.id, seq: currentSeq++, type: 'NAV',
          payload: JSON.stringify({ dest: targetSt.id }) },
        // { task_id: task.id, seq: currentSeq++, type: 'JACK_DOWN',
        //   payload: JSON.stringify({ height: 0.0 }) },
        // 버퍼 이동 후 배터리 체크 단계 추가
        { task_id: task.id, seq: currentSeq++, type: 'CHECK_BATTERY_AFTER_BUFFER',
          payload: JSON.stringify({ 
            batteryThreshold: 40  // 40% 이하면 충전
          }) 
        }
      ]);
      
      await step.update({ status: 'DONE' });
      return true;
    }
    
    console.log(`    ▶ 목적지 버퍼(${target})가 이미 차있음. 다른 버퍼 확인 중...`);
    
    // 대체 목적지 찾기
    // 1. 먼저 A4/B4가 비어있는지 확인
    const mainPoint = region === 'A' ? 'A4' : 'B4';
    const mainSt = stations.find(s=>s.name===mainPoint);
    
    // 로봇 위치로 A4/B4 상태 확인
    const robotsAtMain = robots.filter(r => String(r.location) === String(mainSt?.id));
    const mainOccupiedByRobots = robotsAtMain.length > 0;
    
    if (mainOccupiedByRobots) {
      console.log(`    ▶ ${mainPoint}에 로봇이 있음: ${robotsAtMain.map(r => r.name).join(', ')}`);
    } else {
      console.log(`    ▶ ${mainPoint}에 로봇이 없음. 이동 가능`);
    }
    
    // A4/B4가 비어있으면 이동
    if (!mainOccupiedByRobots && mainSt) {
      console.log(`    ▶ ${mainPoint}가 비어있음. 이곳으로 이동합니다.`);
      const mainPre = stations.find(s=>s.name===`${mainPoint}_PRE`);
      if (mainPre) {
        // 메인 위치 PRE 스테이션으로 이동 후 다시 버퍼 확인
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'NAV',
            payload: JSON.stringify({ dest: mainPre.id }) },
          { task_id: task.id, seq: step.seq+2, type: 'CHECK_BUFFER_WITHOUT_CHARGING',
            payload: JSON.stringify({ 
              target: mainPoint, 
              fallback
            }) 
          },
        ]);
      } else {
        // PRE 스테이션이 없으면 직접 이동 후 JACK 작업
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }) },
          { task_id: task.id, seq: step.seq+2, type: 'NAV',
            payload: JSON.stringify({ dest: mainSt.id }) },
          // { task_id: task.id, seq: step.seq+3, type: 'JACK_DOWN',
          //   payload: JSON.stringify({ height: 0.0 }) },
          // 버퍼 이동 후 배터리 체크 단계 추가
          { task_id: task.id, seq: step.seq+4, type: 'CHECK_BATTERY_AFTER_BUFFER',
            payload: JSON.stringify({ 
              batteryThreshold: 40  // 40% 이하면 충전
            }) 
          }
        ]);
      }
      await step.update({ status: 'DONE' });
      return true;
    }
    
    // A4/B4가 차있으면, 다른 빈 버퍼 찾기 (이미 위에서 RIO 정보 가져옴)
    // 빈 버퍼 찾기
    console.log(`    ▶ 대체 버퍼 검색 중...`);
    const allBuffers = stations.filter(s => regionOf(s) === region && hasClass(s, '버퍼'));
    console.log(`    ▶ ${region} 지역 버퍼 목록: ${allBuffers.map(b => b.name).join(', ')}`);
    
    const altBufferSt = stations.find(s => {
      if (s.name === target) {
        console.log(`    ▶ 버퍼 ${s.name}: 원래 목적지이므로 제외`);
        return false;
      }
      // A4/B4인 경우 제외 (나중에 고려)
      if (s.name === `${region}4`) {
        console.log(`    ▶ 버퍼 ${s.name}: 메인 위치이므로 나중에 고려`);
        return false;
      }
      if (regionOf(s) !== region || !hasClass(s, '버퍼')) {
        return false;
      }
      
      // A1~A3, B1~B3 형식의 버퍼인 경우 RIO 레지스터로 확인
      if (rioConnected && s.name.match(/^[AB][1-3]$/)) {
        const bufferNum = s.name.charAt(1);  // 1, 2, 3
        const regIdx = 3 + parseInt(bufferNum); // 4, 5, 6
        const isFull = rioDevice.lastRegs[regIdx] === 1;
        console.log(`    ▶ 버퍼 ${s.name}: RIO 레지스터 ${regIdx}번 값 ${rioDevice.lastRegs[regIdx]}에 따라 ${isFull ? '차있음' : '비어있음'}`);
        return !isFull; // 비어있으면 true
      }
      
      // 그 외의 경우 로봇 위치로 확인
      const robotPresent = robots.some(r => String(r.location) === String(s.id));
      if (robotPresent) {
        console.log(`    ▶ 버퍼 ${s.name}: 이미 로봇이 있어 제외`);
        return false;
      }
      
      console.log(`    ▶ 버퍼 ${s.name}: 로봇 위치로만 판단 - 비어있음`);
      return true; // 로봇이 없으면 비어있다고 판단
    });
    
    if (altBufferSt) {
      console.log(`    ▶ 대체 버퍼(${altBufferSt.name})를 찾았습니다. 이곳으로 이동합니다.`);
      const altPre = stations.find(s=>s.name===`${altBufferSt.name}_PRE`);
      if (altPre) {
        // 대체 버퍼 PRE 스테이션으로 이동 후 다시 버퍼 확인
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'NAV',
            payload: JSON.stringify({ dest: altPre.id }) },
          { task_id: task.id, seq: step.seq+2, type: 'CHECK_BUFFER_WITHOUT_CHARGING',
            payload: JSON.stringify({ 
              target: altBufferSt.name, 
              fallback
            }) 
          },
        ]);
      } else {
        // PRE 스테이션이 없으면 직접 이동 후 JACK 작업
        await TaskStep.bulkCreate([
          { task_id: task.id, seq: step.seq+1, type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }) },
          { task_id: task.id, seq: step.seq+2, type: 'NAV',
            payload: JSON.stringify({ dest: altBufferSt.id }) },
          // { task_id: task.id, seq: step.seq+3, type: 'JACK_DOWN',
          //   payload: JSON.stringify({ height: 0.0 }) },
        ]);
      }
      await step.update({ status: 'DONE' });
      return true;
    }
    
    // 모든 버퍼가 차있는 경우 계속 대기 (false 반환으로 대기 상태 유지)
    console.log(`    ▶ 모든 ${region} 버퍼(1~4)가 차있습니다. 빈 버퍼가 생길 때까지 대기합니다.`);
    // 대기 시간을 5초로 설정 (다음 tick에서 다시 체크)
    await delay(5000);
    return false; // 이 스텝을 완료하지 않고 다음 tick에서 다시 체크
  }
  
  
  // ─ CHECK_BATTERY_AFTER_BUFFER: 버퍼에 이동 완료 후 배터리 체크하여 충전 스테이션으로 이동 여부 결정
  if (step.type === 'CHECK_BATTERY_AFTER_BUFFER') {
    const { batteryThreshold } = payload;
    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations||'{}').stations||[];
    const robots = await Robot.findAll();
    
    // 배터리 레벨 확인
    const batteryLevel = robot.battery || 0;
    console.log(`    ▶ 버퍼 이동 완료 후 배터리 상태 확인: ${batteryLevel}%`);
    
    // B 지역의 충전 스테이션 찾기
    const chargeStations = stations.filter(s => 
      regionOf(s) === 'B' && 
      hasClass(s, '충전')
    );
    
    console.log(`    ▶ B 지역 충전 스테이션 목록: ${chargeStations.map(s => s.name).join(', ')}`);
    
    if (chargeStations.length === 0) {
      console.log(`    ▶ [오류] B 지역에 충전 스테이션이 없습니다!`);
      await step.update({ status: 'DONE' });
      return true;
    }
    
    // 충전 스테이션 점유 상태 확인
    console.log(`    ▶ 충전 스테이션 점유 상태:`);
    let hasOccupiedChargeStation = false;
    chargeStations.forEach(s => {
      const occupied = robots.some(r => String(r.location) === String(s.id));
      console.log(`      - ${s.name}: ${occupied ? '사용 중' : '비어있음'}`);
      if (occupied) hasOccupiedChargeStation = true;
    });
    
    // 배터리 레벨에 따른 충전 필요성 판단
    let needsCharging = false;
    let reason = '';
    
    if (batteryLevel <= 50) {
      if (hasOccupiedChargeStation) {
        // 충전 스테이션이 점유되어 있으면 40% 이하일 때만 충전
        if (batteryLevel <= 40) {
          needsCharging = true;
          reason = `배터리 ${batteryLevel}% (40% 이하, 충전 스테이션 점유됨)`;
        } else {
          reason = `배터리 ${batteryLevel}% (50% 이하이지만 충전 스테이션 점유됨, 40% 이하가 되면 충전)`;
        }
      } else {
        // 충전 스테이션이 비어있으면 50% 이하일 때 충전
        needsCharging = true;
        reason = `배터리 ${batteryLevel}% (50% 이하, 충전 스테이션 비어있음)`;
      }
    } else {
      reason = `배터리 ${batteryLevel}% (50% 초과, 충전 불필요)`;
    }
    
    console.log(`    ▶ 충전 필요성 판단: ${reason}`);
    
    if (needsCharging) {
      console.log(`    ▶ 충전 스테이션으로 이동합니다.`);
      
      // 비어있는 충전 스테이션 찾기
      const availableChargeStation = chargeStations.find(s => 
        !robots.some(r => String(r.location) === String(s.id))
      );
      
      if (availableChargeStation) {
        console.log(`    ▶ 사용 가능한 충전 스테이션 찾음: ${availableChargeStation.name}`);
        
        // 충전 스테이션의 PRE 스테이션 찾기
        const chargePre = stations.find(s => s.name === `${availableChargeStation.name}_PRE`);
        
        // 충전 스테이션으로 이동하는 단계
        let currentSeq = step.seq+1;
        const chargeSteps = [];
        
        // 먼저 JACK_DOWN 수행 (버퍼에서 화물 내리기)
        chargeSteps.push({ task_id: task.id, seq: currentSeq++, type: 'JACK_DOWN',
          payload: JSON.stringify({ height: 0.0 }) });
        
        if (chargePre) {
          // PRE 스테이션이 있으면 PRE 스테이션으로 먼저 이동
          chargeSteps.push(
            { task_id: task.id, seq: currentSeq++, type: 'NAV',
              payload: JSON.stringify({ dest: chargePre.id }) }
          );
        }
        
        // 충전 스테이션으로 이동
        chargeSteps.push(
          { task_id: task.id, seq: currentSeq++, type: 'NAV',
            payload: JSON.stringify({ dest: availableChargeStation.id }) }
        );
        
        // 충전 단계 추가
        await TaskStep.bulkCreate(chargeSteps);
      } else {
        console.log(`    ▶ 사용 가능한 충전 스테이션이 없습니다. 현재 버퍼에서 대기합니다.`);
      }
    } else {
      console.log(`    ▶ 충전이 필요하지 않습니다.`);
    }
    
    await step.update({ status: 'DONE' });
    return true;
  }

  // ─ FIND_EMPTY_B_CHARGE: IC-B에 도착한 후 빈 B지역 충전소를 동적으로 찾아 이동
  if (step.type === 'FIND_EMPTY_B_CHARGE') {
    console.log(`    ▶ IC-B에서 빈 B지역 충전소 동적 탐색 시작`);
    
    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations||'{}').stations||[];
    const robots = await Robot.findAll();
    
    // B지역 충전 스테이션들 찾기
    const bChargeStations = stations.filter(s => 
      regionOf(s) === 'B' && 
      hasClass(s, '충전')
    );
    
    if (bChargeStations.length === 0) {
      console.log(`    ▶ B지역에 충전 스테이션이 없습니다.`);
      await step.update({ status: 'FAILED', error_message: 'B지역 충전 스테이션을 찾을 수 없습니다' });
      return true;
    }
    
    console.log(`    ▶ B지역 충전 스테이션 목록: ${bChargeStations.map(s => s.name).join(', ')}`);
    
    // 빈 충전 스테이션 찾기
    let emptyChargeStation = null;
    
    for (const chargeSt of bChargeStations) {
      const robotAtCharge = robots.find(r => String(r.location) === String(chargeSt.id));
      
      if (!robotAtCharge) {
        emptyChargeStation = chargeSt;
        console.log(`    ▶ 빈 충전 스테이션 찾음: ${chargeSt.name}`);
        break;
      } else {
        console.log(`    ▶ 충전 스테이션 ${chargeSt.name}: 로봇 ${robotAtCharge.name}이 사용 중`);
      }
    }
    
    if (!emptyChargeStation) {
      console.log(`    ▶ 모든 B지역 충전 스테이션이 사용 중입니다. 5초 후 다시 시도합니다.`);
      await delay(5000);
      return false; // 스텝을 완료하지 않고 다음 tick에서 다시 시도
    }
    
    // 충전 스테이션의 PRE 스테이션 찾기
    const chargePreStation = stations.find(s => 
      s.name === `${emptyChargeStation.name}_PRE`
    );
    
    if (!chargePreStation) {
      console.log(`    ▶ ${emptyChargeStation.name}_PRE 스테이션을 찾을 수 없습니다. 직접 충전소로 이동합니다.`);
      
      // PRE 스테이션이 없으면 직접 충전소로 이동
      await TaskStep.create({
        task_id: task.id,
        seq: step.seq + 1,
        type: 'NAV',
        payload: JSON.stringify({ dest: emptyChargeStation.id }),
        status: 'PENDING'
      });
    } else {
      console.log(`    ▶ ${emptyChargeStation.name}으로 이동: PRE → 충전소 순서로 스텝 추가`);
      
      // PRE 스테이션 → 충전 스테이션 순서로 이동
      await TaskStep.bulkCreate([
        {
          task_id: task.id,
          seq: step.seq + 1,
          type: 'NAV',
          payload: JSON.stringify({ dest: chargePreStation.id }),
          status: 'PENDING'
        },
        {
          task_id: task.id,
          seq: step.seq + 2,
          type: 'NAV',
          payload: JSON.stringify({ dest: emptyChargeStation.id }),
          status: 'PENDING'
        }
      ]);
    }
    
    console.log(`    ▶ 빈 충전소(${emptyChargeStation.name}) 이동 스텝 추가 완료`);
    await step.update({ status: 'DONE' });
    return true;
  }

  throw new Error(`unknown step type: ${step.type}`);
}

// /* ───────────────────────────── worker tick ──────────────────────── */
// Instead of one global _tickRunning, keep per-robot busy flags:
const busyRobots = new Set();

async function tick() {
  // 1) find robots with pending/running tasks
  const robotRows = await Task.findAll({
    where      : { status: { [Op.in]: ['PENDING','RUNNING'] } },
    attributes : ['robot_id'],
    group      : ['robot_id'],
    raw        : true,
  });

  // 2) kick off each robot in parallel
  await Promise.all(robotRows.map(({robot_id}) => handleRobot(robot_id)));
}

async function handleRobot(robot_id) {
  // if already running this robot, skip
  if (busyRobots.has(robot_id)) return;
  busyRobots.add(robot_id);

  let lockedTask = null;
  let task = null;
  let step = null;

  try {
    // Lock & fetch one task for this robot
    await sequelize.transaction({ isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async tx => {
      const t = await Task.findOne({
        where      : { robot_id, status:{[Op.in]:['PENDING','RUNNING']} },
        order      : [['id','ASC']],
        lock       : tx.LOCK.UPDATE,
        skipLocked : true,
        transaction: tx,
      });
      if (!t) return;
      lockedTask = t;
      if (t.status === 'PENDING') {
        await t.update({ status: 'RUNNING' }, { transaction: tx });
        
        // 태스크 시작 로그 기록 (트랜잭션 외부에서 실행)
        setImmediate(async () => {
          try {
            const robot = await Robot.findByPk(robot_id);
            if (robot) {
              await logTaskStarted(t.id, robot.id, robot.name);
            }
          } catch (error) {
            console.error('[TASK_LOG] 태스크 시작 로그 기록 오류:', error.message);
          }
        });
      }
    });
    if (!lockedTask) return;

    // fetch the next step
    task = await Task.findByPk(lockedTask.id);
    step = await TaskStep.findOne({ where:{ task_id:task.id, seq:task.current_seq } });

    // handle DONE/FAILED/no-step cases...
    if (!step)              { 
      await task.update({ status:'DONE' }); 
      
      // 태스크 완료 로그 기록
      try {
        const robot = await Robot.findByPk(robot_id);
        if (robot) {
          await logTaskCompleted(task.id, robot.id, robot.name, task.createdAt, new Date());
        }
      } catch (error) {
        console.error('[TASK_LOG] 태스크 완료 로그 기록 오류:', error.message);
      }
      
      return; 
    }
    if (step.status==='FAILED'){ 
      await task.update({ status:'FAILED' }); 
      
      // 태스크 실패 로그 기록
      try {
        const robot = await Robot.findByPk(robot_id);
        if (robot) {
          await logTaskFailed(task.id, robot.id, robot.name, step.error_message || '스텝 실패', task.createdAt, new Date());
        }
      } catch (error) {
        console.error('[TASK_LOG] 태스크 실패 로그 기록 오류:', error.message);
      }
      
      return; 
    }
    if (step.status==='DONE')  { await task.update({ current_seq: task.current_seq+1 }); return; }
    if (step.status==='PENDING'){ await step.update({ status:'RUNNING' }); }

    // actually run it
    const robot = await Robot.findByPk(robot_id);
    
    // Manual/Auto 모드 체크 - 스텝 상태 변경 전에 확인
    const isAutoMode = checkRobotAutoMode(robot);
    if (!isAutoMode) {
      console.log(`[MANUAL_MODE] ${robot.name}: 수동 모드 상태입니다. 자동 모드로 전환될 때까지 태스크 스텝(PENDING 상태)에서 대기합니다.`);
      return; // 스텝을 PENDING 상태로 유지하며 다음 tick에서 다시 체크
    }
    
    // 자동 모드일 때만 스텝을 RUNNING으로 변경
    if (step.status==='PENDING'){ await step.update({ status:'RUNNING' }); }
    
    // 첫 번째 스텝인 경우 같은 지역 태스크 홀드 체크
    if (task.current_seq === 0) {
      console.log(`[TASK_HOLD_CHECK] ${robot.name}: 첫 번째 스텝 실행 전 같은 지역 태스크 확인`);
      
      // 현재 로봇의 지역 확인
      const mapRow = await MapDB.findOne({ where: { is_current: true } });
      const stations = JSON.parse(mapRow.stations || '{}').stations || [];
      const currentStation = stations.find(s => String(s.id) === String(robot.location));
      const currentRegion = currentStation ? regionOf(currentStation) : null;
      
      if (currentRegion) {
        console.log(`[TASK_HOLD_CHECK] ${robot.name}: 현재 지역 = ${currentRegion}`);
        
        // 같은 지역의 다른 로봇들 중 태스크 수행 중인 로봇 확인
        const allRobots = await Robot.findAll();
        const otherRobotsInSameRegion = allRobots.filter(r => {
          if (r.id === robot.id) return false; // 자기 자신 제외
          
          const robotStation = stations.find(s => String(s.id) === String(r.location));
          const robotRegion = robotStation ? regionOf(robotStation) : null;
          
          return robotRegion === currentRegion;
        });
        
        // 같은 지역의 다른 로봇들 중 실행 중인 태스크가 있는지 확인
        const runningTasksInSameRegion = await Promise.all(
          otherRobotsInSameRegion.map(async (r) => {
            const runningTask = await Task.findOne({
              where: {
                robot_id: r.id,
                status: { [Op.in]: ['RUNNING', 'PAUSED'] }
              }
            });
            return { robot: r, hasRunningTask: !!runningTask };
          })
        );
        
        const robotsWithRunningTasks = runningTasksInSameRegion.filter(item => item.hasRunningTask);
        
        if (robotsWithRunningTasks.length > 0) {
          console.log(`[TASK_HOLD_CHECK] ${robot.name}: 같은 지역(${currentRegion})에 태스크 수행 중인 로봇이 있습니다: ${robotsWithRunningTasks.map(item => item.robot.name).join(', ')}`);
          console.log(`[TASK_HOLD_CHECK] ${robot.name}: 해당 태스크들이 완료될 때까지 대기합니다.`);
          return; // 태스크를 시작하지 않고 다음 tick에서 다시 체크
        } else {
          console.log(`[TASK_HOLD_CHECK] ${robot.name}: 같은 지역에 태스크 수행 중인 로봇이 없습니다. 태스크를 시작합니다.`);
        }
      } else {
        console.log(`[TASK_HOLD_CHECK] ${robot.name}: 지역을 확인할 수 없습니다. 태스크를 시작합니다.`);
      }
    }
    
    const finished = await runStep(task, robot, step);

    if (finished) {
      await sequelize.transaction(async tx => {
        await step.update({ status:'DONE' }, { transaction: tx });
        
        // 스텝 완료 로그 기록
        try {
          await logStepCompleted(task.id, robot.id, robot.name, step.seq, step.type, stepStartTime, new Date());
        } catch (error) {
          console.error('[TASK_LOG] 스텝 완료 로그 기록 오류:', error.message);
        }
        
        await task.update(
          { current_seq: task.current_seq + 1 },
          { transaction: tx }
        );
      });
    }
    // else if runStep returned false (WAIT_FREE_PATH) we leave it RUNNING
  } catch (err) {
    // retry logic...
    console.error(`[runStep] Error for task#${task?.id || 'unknown'}, step#${step?.id || 'unknown'}: ${err.message}`);
    
    // 이제 버퍼 부족 에러는 발생하지 않으므로 일반 에러로 처리
    if (step?.retry >= MAX_RETRY) {
      // 최대 재시도 횟수 초과시 실패 처리
      console.log(`[Task#${task?.id || 'unknown'}] 최대 재시도 횟수(${MAX_RETRY}) 초과. 태스크를 실패로 처리합니다.`);
      await sequelize.transaction(async tx => {
        if (step) await step.update({ status: 'FAILED', error_message: err.message }, { transaction: tx });
        if (task) await task.update({ status: 'FAILED', error_message: err.message }, { transaction: tx });
      });
    } else {
      // 재시도 횟수 증가
      if (step) {
        const retry = (step.retry || 0) + 1;
        await step.update({ retry });
        console.log(`[Task#${task?.id || 'unknown'}] 재시도 ${retry}/${MAX_RETRY}`);
      }
    }
  } finally {
    busyRobots.delete(robot_id);
  }
}


/* ─────────────────── lifecycle ──────────────────────────────── */
let _timer = null;
function start() {
  if (!_timer) {
    _timer = setInterval(tick, TICK_MS);
    console.log('▶ taskExecutorService started');
  }
}
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop, tick, enqueueTask };
