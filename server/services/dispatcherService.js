/************************************************************************
 *  dispatcherService.js  (2025-05-09)
 *  ────────────────────────────────────────────────────────────────────
 *  ▸ RIO edge → Task/TaskStep 레코드 생성
 *  ▸ Door 자동 개폐
 *  ▸ 수동 Nav 디스패치 → Task 생성
 *  ▸ low-level NAV helper(sendGotoNav) export → taskExecutor 에서 사용
 ************************************************************************/
const net = require('net');
const axios = require('axios');
const ModbusRTU = require('modbus-serial');
const { Op, DataTypes } = require('sequelize');
const cron = require('node-cron');

const { logConnChange } = require('./connectionLogger');
const MapDB = require('../models/Map');
const Robot = require('../models/Robot');
const Log = require('../models/Log');
const { Task, TaskStep } = require('../models');   // ← models/index.js

const taskExecutor = require('./taskExecutorService');   // tick() 호출용
const {
  logButtonPressed,
  logTaskAssigned,
  logTaskPaused,
  logTaskResumed,
  logTaskCanceled
} = require('./taskExecutionLogger');
/* ────────────────────────────── 1. 상수 ───────────────────────────── */
const RIOS = {
  '192.168.0.5': {                              // B4 ➜ A4
    client: new ModbusRTU(),
    retry: 0,
    routes: {
      0: { from: 'B4', to: 'A4', prev: 0, curr: 0 },
      //0: { from: 'A4', to: 'B4', prev: 0, curr: 0 },

      1: { from: 'B1', to: 'B4', prev: 0, curr: 0 },
      2: { from: 'B2', to: 'B4', prev: 0, curr: 0 },
      3: { from: 'B3', to: 'B4', prev: 0, curr: 0 },
      7: { prev: 0, curr: 0 },
    },
    connected: false,
    lastAttempt: 0,
  },
  '192.168.0.6': {                              // A4 ➜ B4
    client: new ModbusRTU(),
    retry: 0,
    routes: {
      0: { from: 'A4', to: 'B4', prev: 0, curr: 0 },
      1: { from: 'A1', to: 'A4', prev: 0, curr: 0 },
      2: { from: 'A2', to: 'A4', prev: 0, curr: 0 },
      3: { from: 'A3', to: 'A4', prev: 0, curr: 0 },
      7: { prev: 0, curr: 0 },
    },
    connected: false,
    lastAttempt: 0,
  },
};
const RIO_PORT = 502;
const RIO_UNIT_ID = 1;
const RIO_RETRY_COOLDOWN = 2_000;
const RIO_CONNECT_TIMEOUT = 2_000;   // 5 초만 기다린다
const RIO_READ_TIMEOUT = 2000;


const IO_HOST = '10.29.176.171';
const IO_AUTH = { username: 'root', password: '00000000' };
// 각 영역별 문 IP 정의
const DOOR_IPS = { 
  A: {
    1: ['192.168.0.7'],     // A지역 안쪽 문
    2: ['192.168.0.8'],     // A지역 바깥 문
    all: ['192.168.0.7', '192.168.0.8']  // A지역 모든 문
  }, 
  B: {
    1: ['192.168.0.9'],     // B지역 안쪽 문
    2: ['192.168.0.10'],    // B지역 바깥 문
    all: ['192.168.0.9', '192.168.0.10']  // B지역 모든 문
  }
};
const DOOR_COOLDOWN = 2000;
const doorState = new Map();   // id→{open,ts}

// ──────────── ALARM (slot_0/ch_3) ─────────────
const ALARM_IP = '192.168.0.10';
const ALARM_SLOT = 0;
const ALARM_CH = 3;
const ALARM_STATE = { open: null, timestamp: 0 };

const lastRioSignal = new Map();

// AMR DI 신호 이전 상태 저장 (rising edge 감지용)
const lastAmrDiSignals = new Map(); // robotName -> { di12: boolean, di13: boolean }

// AMR 상태 추적 변수들
const amrLastNetworkTime = new Map(); // robotName -> timestamp (마지막 네트워크 연결 시간)
const amrLastPosition = new Map(); // robotName -> { x, y, timestamp } (마지막 위치 변화 시간)
const amrErrorStartTime = new Map(); // robotName -> timestamp (오류 상태 시작 시간)
const amrStopStartTime = new Map(); // robotName -> timestamp (is_stop=true 시작 시간)
const amrLastConnectionStatus = new Map(); // robotName -> boolean (이전 연결 상태)
const robotRioStates = new Map(); // robotName -> boolean (RIO 레지스터 17번 상태)
const amrResumeGraceTime = new Map(); // robotName -> timestamp (재개 후 유예시간)

/* ────────────────────────────── 2. 공통 헬퍼 ──────────────────────── */
const delay = ms => new Promise(r => setTimeout(r, ms));
const log = async (t, m, meta = {}) => { try { await Log.create({ type: t, message: m, ...meta }); } catch (e) { console.error('[Log]', e.message); } };

const getCls = s => Array.isArray(s.class) ? s.class
  : Array.isArray(s.classList) ? s.classList
    : s.class ? (Array.isArray(s.class) ? s.class : [s.class]) : [];
const hasClass = (s, c) => getCls(s).includes(c);
const regionOf = s => hasClass(s, 'A') ? 'A' : hasClass(s, 'B') ? 'B' : null;


// ───────────────────── 3. Door 컨트롤 ───────────────────────
// 개별 문을 제어하는 함수
async function setDoorSpecific(slot, ch, open, region /* 'A'|'B' */, doorNumber /* 1|2|'all' */) {
  const now = Date.now();
  const payload = {
    Ch: ch, Md: 0, Stat: open ? 1 : 0, Val: open ? 1 : 0,
    PsCtn: 0, PsStop: 0, PsIV: 0,
  };
  const authHeader = 'Basic ' + Buffer.from('root:12345678').toString('base64');

  // 특정 문 또는 모든 문 IP 목록 가져오기
  const doorIPs = DOOR_IPS[region][doorNumber] || DOOR_IPS[region].all;
  
  for (const ip of doorIPs) {
    try {
      await axios.put(
        `http://${ip}/do_value/slot_${slot}/ch_${ch}`,
        payload,
        { headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, timeout: 2000 }
      );
      // IP를 key로, open 상태와 타임스탬프 저장
      doorState.set(ip, { open, timestamp: now, region, doorNumber });
      //console.log(`[DOOR] ${region}지역 ${doorNumber}번 문 ${open ? '열림' : '닫힘'} (${ip})`);
    } catch (e) {
      console.error(`[setDoor] ${ip} 오류:`, e.message);
      // 실패해도 timestamp만 갱신(끊김 표시용)
      doorState.set(ip, { open: false, timestamp: now, region, doorNumber });
    }
  }
}

// 기존 호환성을 위한 함수 (모든 문 제어)
async function setDoor(slot, ch, open, region /* 'A'|'B' */) {
  await setDoorSpecific(slot, ch, open, region, 'all');
}


/* ───────────────────── 4. ALARM 컨트롤 ─────────────────────────── */
async function setAlarm(active) {
  // only send when state actually changes
  if (ALARM_STATE.open === active) return;
  ALARM_STATE.open = active;
  if (Date.now() - ALARM_STATE.timestamp < DOOR_COOLDOWN) return;
  ALARM_STATE.timestamp = Date.now();

  const payload = {
    Ch: ALARM_CH, Md: 0, Stat: 0, Val: active ? 1 : 0,
    PsCtn: 0, PsStop: 0, PsIV: 0
  };
  const authHeader = 'Basic ' + Buffer.from('root:12345678').toString('base64');

  try {
    await axios.put(
      `http://${ALARM_IP}/do_value/slot_${ALARM_SLOT}/ch_${ALARM_CH}`,
      payload,
      { headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, timeout: 2_000 }
    );
  } catch (e) {
    console.error('[setAlarm]', e.response?.data ?? e.message);
  }
}

/* ───────────────────── 4. NAV write helper ───────────────────────── */
// services/dispatcherService.js
/* ------------------------------------------------------------------
   _buildPkt  – Low-level 헤더 + JSON body → Buffer
   ------------------------------------------------------------------ */
let _serial = 0;
function _buildPkt(code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');

  /* 16-byte 헤더 생성 */
  const head = Buffer.alloc(16);
  head.writeUInt8(0x5A, 0);                       // magic
  head.writeUInt8(0x01, 1);                       // version
  head.writeUInt16BE(++_serial & 0xffff, 2);       // serial
  head.writeUInt32BE(body.length, 4);              // body length
  head.writeUInt16BE(code, 8);                     // command
  // 나머지 6바이트(10~15)는 필요 시 reserved 용으로 0 으로 둬도 OK

  return Buffer.concat([head, body]);
}

function sendGotoNav(ip, dest, src, taskId) {
  return new Promise((ok, ng) => {
    const sock = net.createConnection(19206, ip);
    const bye = () => sock.destroy();

    sock.once('connect', () => {
      sock.write(_buildPkt(0x0BEB, { id: String(dest), source_id: String(src), task_id: taskId }), () => {
        log('NAV_SEND', `${ip}→${dest} (${taskId})`);
        bye(); ok();
      });
    });
    sock.once('error', e => { bye(); ng(e); });
    sock.setTimeout(2000, () => { bye(); ng(new Error('timeout')); });
  });
}

// 가상 DI 설정 함수 (API 6020)
function setVirtualDI(ip, diId, status) {
  return new Promise((ok, ng) => {
    // DI 번호를 가상 DI ID로 매핑 (DI 11→0, DI 12→1, DI 13→2)
    let virtualDiId;
    if (diId === 11) virtualDiId = 0;
    else if (diId === 12) virtualDiId = 1;
    else if (diId === 13) virtualDiId = 2;
    else {
      const error = new Error(`지원하지 않는 DI 번호: ${diId}`);
      console.error(`[VDI_API] ${ip}: ${error.message}`);
      return ng(error);
    }
    
    console.log(`[VDI_API] ${ip}: DI${diId}(가상ID:${virtualDiId})를 ${status}로 설정 시도 (포트 19210, API 6020)`);
    
    const sock = net.createConnection(19210, ip);
    const bye = () => sock.destroy();

    sock.once('connect', () => {
      console.log(`[VDI_API] ${ip}: TCP 연결 성공, 패킷 전송 중...`);
      sock.write(_buildPkt(0x1784, { id: virtualDiId, status: status }), () => {
        console.log(`[VDI_SET] ${ip}: DI${diId}(가상ID:${virtualDiId})=${status} 설정 완료`);
        bye(); ok();
      });
    });
    
    sock.once('error', e => { 
      console.error(`[VDI_API] ${ip}: TCP 연결 오류 - ${e.message}`);
      bye(); ng(e); 
    });
    
    sock.setTimeout(2000, () => { 
      console.error(`[VDI_API] ${ip}: TCP 타임아웃 (2초)`);
      bye(); ng(new Error('VDI timeout')); 
    });
  });
}

/* ─────────────── 5. RIO 연결 & 폴링 (edge 감지용) ────────────────── */

(async () => {
  for (const ip of Object.keys(RIOS)) {
    await Log.create({
      type: 'CONN',
      message: `RIO:${ip}`,
      status: 'server-on',
    });}
  // 초기 연결: 서비스 부트 시 한 번씩 시도
  for (const [ip, dev] of Object.entries(RIOS)) {
    try {
      await dev.client.connectTCP(ip, { port: RIO_PORT });
      dev.client.setID(RIO_UNIT_ID);

      // 소켓 레벨 타임아웃 걸기 (예: 3초)
      dev.client._port.setTimeout(2000);
      dev.client._port.on('timeout', () => {
        console.warn(`[RIO] socket timeout at ${ip}`);
        dev.connected = false;
        dev.client._port.destroy();
      });

      dev.connected = true;
      console.log(`[RIO] ${ip} connected`);
      logConnChange(`RIO:${ip}`, true);

      dev.client._port.on('close', () => { dev.connected = false; logConnChange(`RIO:${ip}`, false); });
      dev.client._port.on('error', () => { dev.connected = false; logConnChange(`RIO:${ip}`, false); });
    } catch (e) {
      console.error(`[RIO] ${ip} connect error`, e.message);
    }
  }
})();

async function tryConnectRio(ip, dev) {
  const pConnect = dev.client.connectTCP(ip, { port: RIO_PORT });
  const pTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('connect timeout')), RIO_CONNECT_TIMEOUT)
  );
  await Promise.race([pConnect, pTimeout]);
  dev.client.setID(RIO_UNIT_ID);
  dev.connected = true;
  logConnChange(`RIO:${ip}`, true);
  // 재설정된 소켓 가드
  dev.client._port.on('close', () => { dev.connected = false; logConnChange(`RIO:${ip}`, false); });
  dev.client._port.on('error', () => { dev.connected = false; logConnChange(`RIO:${ip}`, false); });
}

async function pollAllRios() {
  for (const [ip, dev] of Object.entries(RIOS)) {
    // 1) 연결 안 된 경우: 재접속만 시도, 읽기는 스킵
    if (!dev.connected) {
      if (Date.now() - dev.lastAttempt < RIO_RETRY_COOLDOWN) {
        continue;
      }
      dev.lastAttempt = Date.now();
      try {
        await tryConnectRio(ip, dev);
        dev.retry = 0;
        console.log(`[RIO] ✅ re-connected ${ip}`);
      } catch (err) {
        dev.retry += 1;
        console.error(`[RIO] ❌ reconnect error (#${dev.retry}) –`, err.message);
        continue;  // 재접속 실패 시 읽기 없이 다음 장치로
      }
    }

    // 2) 연결된 경우에만 읽기 시도 + 타임아웃 적용
    if (dev.connected) {
      try {
        const readPromise = dev.client.readHoldingRegisters(0, 18);
        const { data } = await Promise.race([
          readPromise,
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('RIO read timeout')), RIO_READ_TIMEOUT)
          )
        ]);
        lastRioSignal.set(ip, Date.now());

        dev.lastRegs = data;
        //console.log(data)
        //console.log(DataTypes)
        for (const [idx, r] of Object.entries(dev.routes)) {
          r.prev = r.curr;
          r.curr = data[idx];
        }
      } catch (err) {
        console.error(`[RIO] ${ip} read error:`, err.message);
        dev.connected = false;
        logConnChange(`RIO:${ip}`, false);
        // 블로킹 소켓 해제
        try { dev.client._port.destroy(); } catch { }
      }
    }
  }
}

const clearRio = async (dev, idx) => { 
  try { 
    const regNum = +idx;
    // 0~6번 레지스터만 초기화
    if (regNum >= 0 && regNum <= 6) {
      await dev.client.writeRegister(regNum, 0);
      //console.log(`[RIO_CLEAR] 레지스터 ${regNum}번 초기화 완료`);
    } else {
      //console.log(`[RIO_CLEAR] 레지스터 ${regNum}번은 초기화 범위(0~6) 밖이므로 건너뜀`);
    }
  } catch (e) {
    console.error(`[RIO_CLEAR] 레지스터 ${idx}번 초기화 오류: ${e.message}`);
  } 
};

// 17번 레지스터에 값을 설정하는 함수 (테스트용: 192.168.0.5에만 작성)
const setRioRegister17 = async (ip, value) => {
  try {
    // 테스트용: 192.168.0.5에만 작성
    const targetIP = '192.168.0.5';
    const dev = RIOS[targetIP];
    
    if (!dev || !dev.connected) {
      console.log(`[RIO_REG17] ${targetIP}: RIO가 연결되지 않음 (요청된 IP: ${ip})`);
      return false;
    }
    
    await dev.client.writeRegister(7, value ? 1 : 0);
    console.log(`[RIO_REG17] ${targetIP}: 레지스터 7번을 ${value ? 1 : 0}으로 설정 완료 (요청된 IP: ${ip})`);
    return true;
  } catch (error) {
    console.error(`[RIO_REG17] 192.168.0.5: 레지스터 7번 설정 오류 - ${error.message} (요청된 IP: ${ip})`);
    return false; // throw 대신 false 반환으로 변경
  }
};

// 범용 RIO 레지스터 작성 함수 (버퍼 피드백용)
const setRioRegister = async (ip, registerNumber, value) => {
  try {
    const dev = RIOS[ip];
    
    if (!dev || !dev.connected) {
      console.log(`[RIO_REG] ${ip}: RIO가 연결되지 않음 (레지스터 ${registerNumber}번)`);
      return false;
    }
    
    await dev.client.writeRegister(registerNumber, value ? 1 : 0);
    console.log(`[RIO_REG] ${ip}: 레지스터 ${registerNumber}번을 ${value ? 1 : 0}으로 설정 완료`);
    return true;
  } catch (error) {
    console.error(`[RIO_REG] ${ip}: 레지스터 ${registerNumber}번 설정 오류 - ${error.message}`);
    return false;
  }
};

// 버퍼 버튼 피드백 함수 (성공/실패에 따른 레지스터 설정)
const setBufferButtonFeedback = async (region, bufferNumber, success) => {
  try {
    // IP 결정: A지역은 192.168.0.6, B지역은 192.168.0.5
    const targetIP = region === 'A' ? '192.168.0.6' : '192.168.0.5';
    
    // 레지스터 번호 결정
    let registerNumber;
    if (bufferNumber === 1) {
      registerNumber = success ? 10 : 11; // 성공: 10, 실패: 11
    } else if (bufferNumber === 2) {
      registerNumber = success ? 12 : 13; // 성공: 12, 실패: 13
    } else if (bufferNumber === 3) {
      registerNumber = success ? 14 : 15; // 성공: 14, 실패: 15
    } else {
      console.error(`[BUFFER_FEEDBACK] 잘못된 버퍼 번호: ${bufferNumber}`);
      return false;
    }
    
    console.log(`[BUFFER_FEEDBACK] ${region}${bufferNumber} 버퍼 버튼 ${success ? '성공' : '실패'} 피드백 - IP: ${targetIP}, 레지스터: ${registerNumber}`);
    
    // 레지스터에 1 설정
    return await setRioRegister(targetIP, registerNumber, true);
    
  } catch (error) {
    console.error(`[BUFFER_FEEDBACK] 오류 발생: ${error.message}`);
    return false;
  }
};

/* ─────────────── 6. Route→Task 변환 (예시 로직만) ────────────────── */
async function buildTaskFromRioEdge(route, robot, stations) {
  console.log("building task from rio edge")
  const findByName = n => stations.find(s => s.name === n);
  const icA = stations.find(s => regionOf(s) === 'A' && hasClass(s, 'IC'));
  const icB = stations.find(s => regionOf(s) === 'B' && hasClass(s, 'IC'));
  const lm73 = stations.find(s => String(s.id) === '73' || s.name === 'LM73');
  const lm78 = stations.find(s => String(s.id) === '78' || s.name === 'LM78');
  const waitA = stations.find(s => regionOf(s) === 'A' && hasClass(s, '대기'));
  const waitB = stations.find(s => regionOf(s) === 'B' && hasClass(s, '대기'));

  let steps = [];

  /* ───── A-side 단방향 ───────────────────────────────────── */
  if (['A1', 'A2', 'A3'].includes(route.from)) {
    steps = [
      { type: 'JACK_UP', payload: { height: 0.03 } },          // 선택
      {
        type: 'NAV_PRE',
        payload: { dest: findByName(`${route.from}_PRE`)?.id }
      }, { type: 'JACK_DOWN', payload: { height: 0 } },             // 선택
      // { type: 'NAV', payload: { dest: icA?.id } },        // IC-A
      // { type: 'WAIT_FREE_PATH' },
      { type: 'NAV', payload: { dest: findByName('A4')?.id } },
    ];
  }

  /* ───── B-side 단방향 (B1 시퀀스는 기존 + 나머지) ────────── */
  else if (['B1', 'B2', 'B3'].includes(route.from)) {
    steps = [
      { type: 'JACK_UP', payload: { height: 0.03 } },
      {
        type: 'NAV_PRE',
        payload: { dest: findByName(`${route.from}_PRE`)?.id }
      },
      { type: 'JACK_DOWN', payload: { height: 0 } },
      // { type: 'NAV', payload: { dest: icB?.id } },        // IC-B
      // { type: 'WAIT_FREE_PATH' },
      { type: 'NAV', payload: { dest: findByName('B4')?.id } },
    ];
  }

  /* ───── cross A4 ↔ B4 ──────────────────────────────────── */
  else if (route.from === 'A4') {   // A4 → B4
    steps = [
      { type: 'NAV', payload: { dest: icA?.id } },
      { type: 'WAIT_FREE_PATH' },
      { type: 'NAV', payload: { dest: lm78?.id } },
//{ type: 'WAIT_FREE_PATH' },
      { type: 'NAV', payload: { dest: icB?.id } },

      //{ type: 'WAIT_FREE_PATH' },
      // 기존: B4로 바로 이동
      // { type: 'NAV_OR_BUFFER', payload: { primary: 'B4' } },
      
      // 수정: B영역의 빈 버퍼 찾아 이동하는 커스텀 단계
      { type: 'FIND_EMPTY_B_BUFFER', payload: {} },
    ];
  } else if (route.from === 'B4') { // B4 → A4  (기존에 있던 로직)
    steps = [
      { type: 'NAV', payload: { dest: icB?.id } },
      { type: 'WAIT_FREE_PATH' },
      { type: 'NAV', payload: { dest: lm73?.id } },
      { type: 'WAIT_FREE_PATH' },
      { type: 'NAV', payload: { dest: icA?.id } },
      { type: 'WAIT_FREE_PATH' },
      { type: 'NAV_OR_BUFFER', payload: { primary: 'A4' } },
    ];
  } else {f
    return null;           // 정의 안 됨 → 무시
  }

  /* ▼ 기존과 동일: Task/TaskStep 생성 */
  console.log(steps)
  return Task.create(
    {
      robot_id: robot.id,
      steps: steps.map((s, i) => ({
        seq: i,
        type: s.type,
        payload: JSON.stringify(s.payload ?? {}),
        status: 'PENDING',
      })),
    },
    { include: [{ model: TaskStep, as: 'steps' }] },
  ).then(async (task) => {
    // 태스크 할당 로그 기록
    try {
      await logTaskAssigned(
        task.id,
        robot.id,
        robot.name,
        route.from,
        route.to || '목적지'
      );
    } catch (error) {
      console.error('[TASK_LOG] 태스크 할당 로그 기록 오류:', error.message);
    }
    return task;
  });
}


/* ─────────────── 7. Edge 핸들러 (Task 생성) ───────────────────────── */

// 로봇의 기존 태스크 상태 확인 헬퍼 함수
async function checkRobotTaskStatus(robot) {
  const existingTask = await Task.findOne({
    where: {
      robot_id: robot.id,
      status: { [Op.in]: ['PENDING', 'RUNNING', 'PAUSED'] }
    },
    order: [['id', 'DESC']]
  });
  
  if (existingTask) {
    console.log(`[태스크중복방지] 로봇 ${robot.name}에 이미 실행 중인 태스크가 있습니다: 태스크 ID ${existingTask.id}, 상태: ${existingTask.status}`);
    return false; // 태스크 생성 불가
  }
  
  return true; // 태스크 생성 가능
}

// 목적지 중복 체크 헬퍼 함수
async function checkDestinationConflict(destinationId, excludeRobotId = null) {
  try {
    // 현재 PENDING, RUNNING, PAUSED 상태인 모든 태스크들의 스텝 확인
    const conflictingTasks = await Task.findAll({
      where: {
        status: { [Op.in]: ['PENDING', 'RUNNING', 'PAUSED'] },
        ...(excludeRobotId && { robot_id: { [Op.ne]: excludeRobotId } })
      },
      include: [{
        model: TaskStep,
        as: 'steps',
        where: {
          status: { [Op.in]: ['PENDING', 'RUNNING'] },
          type: { [Op.in]: ['NAV', 'NAV_PRE'] }
        },
        required: true
      }]
    });

    // 각 태스크의 스텝들을 확인하여 목적지가 일치하는지 체크
    for (const task of conflictingTasks) {
      for (const step of task.steps) {
        try {
          const payload = typeof step.payload === 'string' 
            ? JSON.parse(step.payload) 
            : step.payload;
          
          if (payload.dest && String(payload.dest) === String(destinationId)) {
            // 충돌하는 태스크 정보 가져오기
            const robot = await Robot.findByPk(task.robot_id);
            console.log(`[목적지중복방지] 목적지 ${destinationId}로 향하는 기존 태스크가 있습니다: 로봇 ${robot?.name || 'Unknown'}, 태스크 ID ${task.id}, 스텝 ${step.type}`);
            return false; // 목적지 충돌 발생
          }
        } catch (e) {
          // payload 파싱 오류 시 무시하고 계속 진행
          console.warn(`[목적지중복체크] 스텝 ${step.id} payload 파싱 오류: ${e.message}`);
        }
      }
    }

    console.log(`[목적지중복방지] 목적지 ${destinationId}에 대한 충돌 없음`);
    return true; // 목적지 충돌 없음
  } catch (error) {
    console.error(`[목적지중복체크] 오류 발생: ${error.message}`);
    return false; // 오류 발생 시 안전하게 충돌로 처리
  }
}

async function handleRioEdge(ip, idx, route) {
  console.log('function handlerioedge')
  const map = await MapDB.findOne({ where: { is_current: true } });
  if (!map) return;
  const stations = (JSON.parse(map.stations || '{}').stations) || [];
  const robots = await Robot.findAll(); // robots 변수 정의 추가
  const fromSt = stations.find(s => s.name === route.from); if (!fromSt) return;
  const tgtSt = stations.find(s => s.name === (route.to ?? ''));
  //console.log("values:",map, stations, fromSt, tgtSt)
  
  // 특별 케이스 처리: 레지스터 0번 신호 (A4/B4 위치 신호)
  if (parseInt(idx) === 0) {
    console.log(`[메인신호] 레지스터 ${idx}번 신호 감지: ${route.from}→${route.to}`);
    
    // route.from이 A4 또는 B4인지 확인
    if (route.from === 'A4' || route.from === 'B4') {
      // 해당 위치(A4/B4)에 AMR이 있는지 확인
      const robotAtMainPoint = await Robot.findOne({ where: { location: fromSt.id } });
      
      if (!robotAtMainPoint) {
        console.log(`[메인신호] ${route.from}에 로봇이 없습니다. 버퍼에서 로봇 호출 시도...`);
        
        // 버퍼 위치를 찾기 위한 지역 확인
        const region = route.from.charAt(0); // 'A' 또는 'B'
        
        // 같은 지역의 버퍼 위치를 찾아 버퍼에 있는 로봇 확인
        const bufferNumbers = [1, 2, 3]; // 버퍼 번호 (A1, A2, A3 또는 B1, B2, B3)
        let robotFound = false;
        
        for (const bufferNum of bufferNumbers) {
          const bufferName = `${region}${bufferNum}`;
          const bufferSt = stations.find(s => s.name === bufferName);
          
          if (!bufferSt) {
            console.log(`[메인신호] ${bufferName} 스테이션을 찾을 수 없습니다.`);
            continue;
          }
          
          // 해당 버퍼에 로봇이 있는지 확인
          const robotAtBuffer = await Robot.findOne({ where: { location: bufferSt.id } });
          
          if (robotAtBuffer) {
            console.log(`[메인신호] ${bufferName}에서 로봇(${robotAtBuffer.name})을 찾았습니다. ${route.from}으로 호출합니다.`);
            
            // 기존 태스크 상태 확인
            if (!(await checkRobotTaskStatus(robotAtBuffer))) {
              console.log(`[메인신호] 로봇 ${robotAtBuffer.name}에 이미 실행 중인 태스크가 있어 호출을 건너뜁니다.`);
              continue; // 다음 버퍼 확인
            }
            
            // 목적지 중복 체크
            if (!(await checkDestinationConflict(fromSt.id, robotAtBuffer.id))) {
              console.log(`[메인신호] 목적지 ${route.from}에 대한 중복 태스크가 있어 호출을 건너뜁니다.`);
              continue; // 다음 버퍼 확인
            }
            
            // 버퍼 PRE 스테이션 찾기
            const bufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
            
            if (!bufferPreSt) {
              console.error(`[메인신호] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
              continue;
            }
            
            // 태스크 생성 (JACK_UP → PRE 버퍼로 이동 → JACK_DOWN → A4/B4로 이동)
            const task = await Task.create(
              {
                robot_id: robotAtBuffer.id,
                steps: [
                  {
                    seq: 0,
                    type: 'JACK_UP',
                    payload: JSON.stringify({ height: 0.03 }),
                    status: 'PENDING',
                  },
                  {
                    seq: 1,
                    type: 'NAV_PRE',
                    payload: JSON.stringify({ dest: bufferPreSt.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 2,
                    type: 'JACK_DOWN',
                    payload: JSON.stringify({ height: 0.0 }),
                    status: 'PENDING',
                  },
                  {
                    seq: 3,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: fromSt.id }),
                    status: 'PENDING',
                  }
                ],
              },
              { include: [{ model: TaskStep, as: 'steps' }] },
            );
            
            console.log(`[메인신호] 로봇(${robotAtBuffer.name})을 ${route.from}으로 호출하는 태스크 생성 완료 (태스크 ID: ${task.id})`);
            await log('MAIN_POINT_CALL', `메인위치 호출: ${robotAtBuffer.name} → ${route.from}`, { robot_name: robotAtBuffer.name });
            
            robotFound = true;
            break; // 하나의 로봇을 찾았으면 반복 종료
          }
        }
        
        if (!robotFound) {
          console.log(`[메인신호] ${region} 지역 버퍼에 호출할 수 있는 로봇이 없습니다.`);
        }
        
        return; // 여기서 처리 종료
      }
    }
  }
  
  // 특별 케이스 처리: 레지스터 1, 2, 3번 신호 (버퍼→A4/B4 이동)
  if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
    console.log(`[버퍼신호] 레지스터 ${idx}번 신호 감지: ${route.from}→${route.to}`);
    
    // 버튼 눌림 로그 기록
    try {
      await logButtonPressed('시스템', `버퍼${route.from} 호출`, route.from, route.to);
    } catch (error) {
      console.error('[TASK_LOG] 버튼 눌림 로그 기록 오류:', error.message);
    }
    
    // 지역 확인
    const region = route.from.charAt(0); // 'A' 또는 'B'
    const bufferNum = parseInt(route.from.charAt(1)); // 1, 2, 3
    const bufferName = `${region}${bufferNum}`;
    
    // 레지스터 4, 5, 6번(버퍼 상태) 값 확인
    const rioDevice = RIOS[ip];
    let bufferStatus = { 
      1: false, // 기본값: 모든 버퍼가 비어있다고 가정
      2: false,
      3: false
    };
    
    if (rioDevice && rioDevice.connected && rioDevice.lastRegs) {
      // 레지스터 4,5,6번은 각 버퍼의 상태 (1=차있음, 0=비어있음)
      bufferStatus[1] = rioDevice.lastRegs[4] === 1; // 버퍼1 상태
      bufferStatus[2] = rioDevice.lastRegs[5] === 1; // 버퍼2 상태
      bufferStatus[3] = rioDevice.lastRegs[6] === 1; // 버퍼3 상태
      
      console.log(`[버퍼신호] ${region} 지역 버퍼 상태 확인: ${bufferName}=${bufferStatus[bufferNum] ? '차있음' : '비어있음'}`);
    } else {
      console.log(`[버퍼신호] RIO 연결 안됨, 버퍼 상태를 로봇 위치로만 확인합니다.`);
    }
    
    // 해당 버퍼에 AMR이 있는지 확인
    const robotAtBuffer = await Robot.findOne({ where: { location: fromSt.id } });
    
    if (!robotAtBuffer) {
      console.log(`[버퍼신호] ${bufferName}에 로봇이 없습니다.`);
      
      // 레지스터 값으로도 확인
      if (bufferStatus[bufferNum]) {
        console.log(`[버퍼신호] 주의: 레지스터 값은 ${bufferName}에 로봇이 있다고 표시하지만, DB에서는 로봇을 찾을 수 없습니다.`);
        
        // AMR이 없고 레지스터 값이 1인 경우: 새로운 우선순위 로직 적용
        console.log(`[버퍼신호] ${bufferName}에 로봇이 없고 레지스터 값이 1입니다. 우선순위에 따른 AMR 호출 시도...`);
        
        // 우선순위별 AMR 찾기 및 호출
        const calledRobot = await callAmrToBufferWithPriority(region, bufferNum, bufferName, fromSt, stations, robots);
        
        if (calledRobot) {
          console.log(`[버퍼신호] AMR 호출 성공: ${calledRobot.robot.name} (${calledRobot.source} → ${bufferName})`);
          // 성공 피드백 전송
          await setBufferButtonFeedback(region, bufferNum, true);
        } else {
          console.log(`[버퍼신호] 호출 가능한 AMR이 없습니다.`);
          // 실패 피드백 전송
          await setBufferButtonFeedback(region, bufferNum, false);
        }
        
        return; // 여기서 처리 종료
      }
      
      // 버퍼에 AMR이 없고, 레지스터 값도 0인 경우 (버퍼가 정말 비어있음)
      if (!bufferStatus[bufferNum]) {
        console.log(`[버퍼신호] ${bufferName}에 로봇이 없고 레지스터 값도 0입니다. AMR 호출 시도...`);
        
        // 우선순위 1: 해당 지역의 메인 위치(A4/B4)에서 로봇 호출
        const mainPoint = `${region}4`;
        const mainSt = stations.find(s => s.name === mainPoint);
        
        if (mainSt) {
          const robotAtMainPoint = await Robot.findOne({ where: { location: mainSt.id } });
          
          if (robotAtMainPoint) {
            console.log(`[버퍼신호] 우선순위 1: ${mainPoint}에서 로봇(${robotAtMainPoint.name})을 찾았습니다. ${bufferName}으로 호출합니다.`);
            
            // 기존 태스크 상태 확인
            if (!(await checkRobotTaskStatus(robotAtMainPoint))) {
              console.log(`[버퍼신호] 로봇 ${robotAtMainPoint.name}에 이미 실행 중인 태스크가 있어 호출을 건너뜁니다.`);
              // 실패 피드백 전송
              await setBufferButtonFeedback(region, bufferNum, false);
              return;
            }
            
            // 목적지 중복 체크
            if (!(await checkDestinationConflict(fromSt.id, robotAtMainPoint.id))) {
              console.log(`[버퍼신호] 목적지 ${bufferName}에 대한 중복 태스크가 있어 호출을 건너뜁니다.`);
              // 실패 피드백 전송
              await setBufferButtonFeedback(region, bufferNum, false);
              return;
            }
            
            // 버퍼 PRE 스테이션 찾기
            const bufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
            
            if (!bufferPreSt) {
              console.error(`[버퍼신호] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
              // 실패 피드백 전송
              await setBufferButtonFeedback(region, bufferNum, false);
            } else {
              // 태스크 생성 (PRE로 이동 → JACK_UP → 버퍼로 이동)
              const task = await Task.create(
                {
                  robot_id: robotAtMainPoint.id,
                  steps: [
                    {
                      seq: 0,
                      type: 'NAV',
                      payload: JSON.stringify({ dest: bufferPreSt.id }),
                      status: 'PENDING',
                    },
                    {
                      seq: 1,
                      type: 'JACK_UP',
                      payload: JSON.stringify({ height: 0.03 }),
                      status: 'PENDING',
                    },
                    {
                      seq: 2,
                      type: 'NAV',
                      payload: JSON.stringify({ dest: fromSt.id }),
                      status: 'PENDING',
                    },
                  ],
                },
                { include: [{ model: TaskStep, as: 'steps' }] },
              );
              
              console.log(`[버퍼신호] 로봇(${robotAtMainPoint.name})을 ${bufferName}으로 호출하는 태스크 생성 완료 (태스크 ID: ${task.id})`);
              await log('BUTTON_TASK', `버퍼 호출: ${robotAtMainPoint.name} → ${bufferName}`, { robot_name: robotAtMainPoint.name });
              
              // 성공 피드백 전송
              await setBufferButtonFeedback(region, bufferNum, true);
              
              return; // 메인 위치에서 로봇을 호출했으므로 여기서 처리 종료
            }
          } else {
            console.log(`[버퍼신호] 우선순위 1: ${mainPoint}에 호출할 로봇이 없습니다.`);
          }
        }
        
        // 메인 위치에 로봇이 없으면 입력 무시
        console.log(`[버퍼신호] ${region} 지역 메인 위치(${mainPoint})에 호출할 수 있는 AMR이 없습니다. 입력을 무시합니다.`);
        // 실패 피드백 전송
        await setBufferButtonFeedback(region, bufferNum, false);
        return; // 입력 무시
      }
      
      return; // 여기서 처리 종료
    }
  }

  // 기존 로직에서는 이미 fromSt를 기준으로 robot을 조회했기 때문에,
  // 위에서 robotAtBuffer가 없는 경우는 이미 return되었으므로 
  // 아래 robot 변수는 항상 존재할 것입니다.
  const robot = await Robot.findOne({ where: { location: fromSt.id } });
  if (!robot) {
    console.log("no robot in station")
    
    // 버튼 눌림 로그 기록 (무시 사유 포함)
    try {
      await logButtonPressed('시스템', `${route.from} 버튼 (무시: 스테이션에 로봇 없음)`, route.from);
    } catch (error) {
      console.error('[TASK_LOG] 버튼 눌림 무시 로그 기록 오류:', error.message);
    }
    
    // 버퍼 버튼인 경우 실패 피드백
    if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
      const region = route.from.charAt(0);
      const bufferNum = parseInt(route.from.charAt(1));
      await setBufferButtonFeedback(region, bufferNum, false);
    }
    
    return
  } else {
    console.log("robot in station")
  }

  // 배터리 체크: 버퍼에 있는 AMR의 배터리가 20% 이하면 무시
  if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
    const batteryLevel = robot.battery || 0;
    if (batteryLevel <= 30) {
      console.log(`[배터리부족] ${robot.name}: 배터리 ${batteryLevel}%로 20% 이하입니다. 버튼 입력을 무시합니다.`);
      
      // 버튼 눌림 로그 기록 (무시 사유 포함)
      try {
        await logButtonPressed(robot.name, `${route.from} 버튼 (무시: 배터리 부족 ${batteryLevel}%)`, route.from);
      } catch (error) {
        console.error('[TASK_LOG] 배터리 부족 무시 로그 기록 오류:', error.message);
      }
      
      // 버퍼 버튼인 경우 실패 피드백
      const region = route.from.charAt(0);
      const bufferNum = parseInt(route.from.charAt(1));
      await setBufferButtonFeedback(region, bufferNum, false);
      
      return;
    } else {
      console.log(`[배터리체크] ${robot.name}: 배터리 ${batteryLevel}% - 충분함`);
    }
  }

  // 메인 태스크 생성 전 기존 태스크 상태 확인
  if (!(await checkRobotTaskStatus(robot))) {
    console.log(`[태스크중복방지] 로봇 ${robot.name}에 이미 실행 중인 태스크가 있어 새로운 태스크 생성을 건너뜁니다.`);
    
    // 버튼 눌림 로그 기록 (무시 사유 포함)
    try {
      await logButtonPressed(robot.name, `${route.from} 버튼 (무시: 태스크 실행 중)`, route.from);
    } catch (error) {
      console.error('[TASK_LOG] 버튼 눌림 무시 로그 기록 오류:', error.message);
    }
    
    // 버퍼 버튼인 경우 실패 피드백
    if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
      const region = route.from.charAt(0);
      const bufferNum = parseInt(route.from.charAt(1));
      await setBufferButtonFeedback(region, bufferNum, false);
    }
    
    return;
  }

  // 목적지 중복 체크 (route.to가 있는 경우에만)
  if (tgtSt && !(await checkDestinationConflict(tgtSt.id, robot.id))) {
    console.log(`[태스크중복방지] 목적지 ${route.to}에 대한 중복 태스크가 있어 새로운 태스크 생성을 건너뜁니다.`);
    
    // 버튼 눌림 로그 기록 (무시 사유 포함)
    try {
      await logButtonPressed(robot.name, `${route.from} 버튼 (무시: 목적지 중복)`, route.from);
    } catch (error) {
      console.error('[TASK_LOG] 버튼 눌림 무시 로그 기록 오류:', error.message);
    }
    
    // 버퍼 버튼인 경우 실패 피드백
    if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
      const region = route.from.charAt(0);
      const bufferNum = parseInt(route.from.charAt(1));
      await setBufferButtonFeedback(region, bufferNum, false);
    }
    
    return;
  }

  /*  --------  (1) 목적지 점유 체크  ------------ */
  if (tgtSt) {
    const occupied = await Robot.findOne({ where: { location: tgtSt.id } });
    const toIsA4 = route.to === 'A4', toIsB4 = route.to === 'B4';
    const fromIsBLine = ['B1', 'B2', 'B3'].includes(route.from);
    const fromIsALine = ['A1', 'A2', 'A3'].includes(route.from);
    console.log((fromIsBLine && toIsB4 && occupied) ||
      (fromIsALine && toIsA4 && occupied))
    if ((fromIsBLine && toIsB4 && occupied) ||
      (fromIsALine && toIsA4 && occupied)) {
      await log('RIO_IGNORE', `${route.from}→${route.to} (dest occupied)`);
      console.log('toSt Occupied')
      
      // 버튼 눌림 로그 기록 (무시 사유 포함)
      try {
        await logButtonPressed('시스템', `${route.from} 버튼 (무시: 목적지 점유)`, route.from);
      } catch (error) {
        console.error('[TASK_LOG] 버튼 눌림 무시 로그 기록 오류:', error.message);
      }
      
      // 버퍼 버튼인 경우 실패 피드백
      if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
        const region = route.from.charAt(0);
        const bufferNum = parseInt(route.from.charAt(1));
        await setBufferButtonFeedback(region, bufferNum, false);
      }
      
      return;                      // ★ 태스크 생성 안 함
    }
  }

  /*  --------  (1.5) A4→B 특별 체크: B 지역 버퍼 상태 확인  ------------ */
  if (route.from === 'A4' && route.to === 'B4') {
    console.log(`[A4→B체크] A4에서 B로 이동 시도: B 지역 버퍼 상태 확인`);
    
    // B 지역 RIO 장치에서 버퍼 상태 확인 (192.168.0.5)
    const bRioDevice = RIOS['192.168.0.5'];
    let allBBuffersOccupied = false;
    
    try {
      if (bRioDevice && bRioDevice.connected && bRioDevice.lastRegs) {
        // 레지스터 4,5,6은 각각 B1,B2,B3 버퍼 상태를 나타냄 (1=차있음, 0=비어있음)  
        const buf1Occupied = bRioDevice.lastRegs[4] === 1;
        const buf2Occupied = bRioDevice.lastRegs[5] === 1;
        const buf3Occupied = bRioDevice.lastRegs[6] === 1;
        
        allBBuffersOccupied = buf1Occupied && buf2Occupied && buf3Occupied;
        console.log(`[A4→B체크] B 지역 버퍼 상태: B1=${buf1Occupied}, B2=${buf2Occupied}, B3=${buf3Occupied}, 모두차있음=${allBBuffersOccupied}`);
      } else {
        console.log(`[A4→B체크] B 지역 RIO(192.168.0.5) 연결 안됨, 안전하게 모두 차있다고 간주`);
        // RIO 연결 안 되면 안전하게 버퍼가 모두 차있다고 간주
        allBBuffersOccupied = true;
      }
    } catch (err) {
      console.error(`[A4→B체크] B 지역 RIO 상태 확인 오류: ${err.message}`);
      // 오류 발생 시 안전하게 버퍼가 모두 차있다고 간주
      allBBuffersOccupied = true;
    }
    
    // B 지역 버퍼가 모두 차있으면 A4→B 이동 무시
    if (allBBuffersOccupied) {
      console.log(`[A4→B체크] A4→B 이동 무시: B 지역 버퍼(B1,B2,B3)가 모두 차있음`);
      await log('RIO_IGNORE', `A4→B (B 지역 버퍼 모두 차있음)`);
      
      // 버튼 눌림 로그 기록 (무시 사유 포함)
      try {
        await logButtonPressed('시스템', `A4 버튼 (무시: B 지역 버퍼 모두 차있음)`, route.from);
      } catch (error) {
        console.error('[TASK_LOG] A4→B 무시 로그 기록 오류:', error.message);
      }
      
      return;  // 태스크 생성 안 함
    }
    
    console.log(`[A4→B체크] A4→B 이동 허용: B 지역에 빈 버퍼 있음`);
  }

  /*  --------  (2) 교차점 및 버퍼 상태 체크  ------------ */
  const fromIsB = ['B1', 'B2', 'B3', 'B4'].includes(route.from);
  const fromIsA = ['A1', 'A2', 'A3', 'A4'].includes(route.from);
  
  if (fromIsB || fromIsA) {
    // 버퍼와 교차점 상태 확인을 위한 로직
    const targetRegion = fromIsB ? 'A' : 'B'; // B->A 또는 A->B 이동 방향
    const crossPoint = targetRegion === 'A' ? 'A4' : 'B4';
    
    // 1. 교차점에 로봇이 있는지 확인
    const crossPointSt = stations.find(s => s.name === crossPoint);
    const crossPointOccupied = crossPointSt ? 
                             await Robot.findOne({ where: { location: crossPointSt.id } }) : null;
    
    // 2. 목적지 지역의 버퍼 상태 확인
    const rioIP = targetRegion === 'A' ? '192.168.0.6' : '192.168.0.5';
    const rioDevice = RIOS[rioIP];
    
    let allBuffersOccupied = false;
    
    try {
      if (rioDevice && rioDevice.connected && rioDevice.lastRegs) {
        // 레지스터 4,5,6은 각각 버퍼 상태를 나타냄 (1=차있음, 0=비어있음)
        const buf1Occupied = rioDevice.lastRegs[4] === 1;
        const buf2Occupied = rioDevice.lastRegs[5] === 1;
        const buf3Occupied = rioDevice.lastRegs[6] === 1;
        
        allBuffersOccupied = buf1Occupied && buf2Occupied && buf3Occupied;
        console.log(`${targetRegion} 지역 버퍼 상태: BUF1=${buf1Occupied}, BUF2=${buf2Occupied}, BUF3=${buf3Occupied}`);
      } else {
        console.log(`${targetRegion} 지역 RIO 연결 안됨, 버퍼 상태 확인 불가`);
        // RIO 연결 안 되면 안전하게 버퍼가 모두 차있다고 간주
        allBuffersOccupied = true;
      }
    } catch (err) {
      console.error(`RIO 상태 확인 오류: ${err.message}`);
      // 오류 발생 시 안전하게 버퍼가 모두 차있다고 간주
      allBuffersOccupied = true;
    }
    
    // 목적지 지역의 버퍼가 모두 차있고 교차점에 로봇이 있으면 이동 금지
    if (allBuffersOccupied && crossPointOccupied) {
      console.log(`${route.from}→${crossPoint} 이동 불가: 버퍼 모두 차있고 ${crossPoint}에 로봇 있음`);
      await log('RIO_IGNORE', `${route.from}→${targetRegion} (버퍼 모두 차있고 ${crossPoint} 점유됨)`);
      
      // 버튼 눌림 로그 기록 (무시 사유 포함)
      try {
        await logButtonPressed('시스템', `${route.from} 버튼 (무시: 버퍼 만점 및 교차점 점유)`, route.from);
      } catch (error) {
        console.error('[TASK_LOG] 버튼 눌림 무시 로그 기록 오류:', error.message);
      }
      
      // 버퍼 버튼인 경우 실패 피드백
      if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
        const region = route.from.charAt(0);
        const bufferNum = parseInt(route.from.charAt(1));
        await setBufferButtonFeedback(region, bufferNum, false);
      }
      
      return;  // 태스크 생성 안 함
    }
  }

  console.log('handleriodedge: building task')
  const task = await buildTaskFromRioEdge(route, robot, stations);
  if (task) {
    console.log("task_create", `RIO ${ip} reg${idx} -> task#${task.id}`)
    await log('TASK_CREATE', `RIO ${ip} reg${idx} -> task#${task.id}`, { robot_name: robot.name });
    
    // 버퍼 버튼인 경우 성공 피드백
    if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
      const region = route.from.charAt(0);
      const bufferNum = parseInt(route.from.charAt(1));
      await setBufferButtonFeedback(region, bufferNum, true);
    }
  } else {
    // 태스크 생성 실패인 경우
    console.log("task creation failed")
    
    // 버퍼 버튼인 경우 실패 피드백
    if (parseInt(idx) >= 1 && parseInt(idx) <= 3) {
      const region = route.from.charAt(0);
      const bufferNum = parseInt(route.from.charAt(1));
      await setBufferButtonFeedback(region, bufferNum, false);
    }
  }
}


/* ─────────────── 8. 메인 워커 (1 Hz) ─────────────────────────────── */
let busy = false;
let lastTimerReport = 0; // 마지막 타이머 리포트 시간
const TIMER_REPORT_INTERVAL = 1 * 1000; // 1초마다 리포트

// AMR 타이머 상태 출력 함수
function reportAmrTimers() {
  const now = Date.now();
  console.log('\n=== AMR 타이머 상태 리포트 ===');
  
  // 모든 AMR의 타이머 정보를 수집
  const allRobotNames = new Set([
    ...amrLastNetworkTime.keys(),
    ...amrLastPosition.keys(),
    ...amrErrorStartTime.keys(),
    ...amrStopStartTime.keys(),
    ...amrLastConnectionStatus.keys()
  ]);
  
  if (allRobotNames.size === 0) {
    console.log('등록된 AMR이 없습니다.');
    console.log('================================\n');
    return;
  }
  
  for (const robotName of allRobotNames) {
    console.log(`\n[${robotName}]`);
    
    // 네트워크 연결 상태
    const lastNetworkTime = amrLastNetworkTime.get(robotName);
    const isConnected = amrLastConnectionStatus.get(robotName);
    const networkAge = lastNetworkTime ? Math.round((now - lastNetworkTime) / 1000) : 'N/A';
    console.log(`  네트워크: ${isConnected ? '연결됨' : '끊김'} (마지막: ${networkAge}초 전)`);
    
    // 위치 변화
    const lastPosData = amrLastPosition.get(robotName);
    const positionAge = lastPosData ? Math.round((now - lastPosData.timestamp) / 1000) : 'N/A';
    const positionInfo = lastPosData ? `(${lastPosData.x.toFixed(2)}, ${lastPosData.y.toFixed(2)})` : 'N/A';
    console.log(`  위치변화: ${positionAge}초 전 ${positionInfo}`);
    
    // 오류 상태
    const errorStartTime = amrErrorStartTime.get(robotName);
    const errorDuration = errorStartTime ? Math.round((now - errorStartTime) / 1000) : 0;
    if (errorDuration > 0) {
      console.log(`  오류상태: ${errorDuration}초 지속 중 ${errorDuration >= 60 ? '⚠️' : ''}`);
    } else {
      console.log(`  오류상태: 정상`);
    }
    
    // 위치 정지 상태 (NAV 중)
    const stopStartTime = amrStopStartTime.get(robotName);
    const stopDuration = stopStartTime ? Math.round((now - stopStartTime) / 1000) : 0;
    if (stopDuration > 0) {
      console.log(`  NAV정지: ${stopDuration}초 지속 중 ${stopDuration >= 60 ? '⚠️' : ''}`);
    } else {
      console.log(`  NAV정지: 이동 중`);
    }
  }
  
  console.log('\n================================\n');
}

async function workerTick() {
  if (busy) return; busy = true;
  try {
    await pollAllRios();

    for (const [ip, dev] of Object.entries(RIOS)) {
      for (const [idx, r] of Object.entries(dev.routes)) {
        if (r.curr === 1 && r.prev === 0) {
          console.log("handlerioedge")
          await handleRioEdge(ip, idx, r).catch(console.error);
          await clearRio(dev, idx);
        } else if (r.curr === 1) { await clearRio(dev, idx); }
      }
    }

    // Door 자동
    const map = await MapDB.findOne({ where: { is_current: true } });
    if (map) {
      const stations = (JSON.parse(map.stations || '{}').stations) || [];
      const robots = await Robot.findAll();
      
      // 세분화된 문 제어
      const doorStations = {
        'A1': false, // A지역 첫번째 문
        'A2': false, // A지역 두번째 문
        'B1': false, // B지역 첫번째 문
        'B2': false  // B지역 두번째 문
      };
      
      // 로봇의 위치에 따라 각 문 상태 확인
      for (const s of stations) {
        const robotAtStation = robots.some(r => r.location == s.id);
        if (!robotAtStation) continue;
        
        const cls = getCls(s);
        
        // doorA_1, doorA_2, doorB_1, doorB_2 형식의 클래스 검사
        for (const region of ['A', 'B']) {
          for (const doorNum of [1, 2]) {
            const doorClass = `door${region}_${doorNum}`;
            if (cls.includes(doorClass)) {
              doorStations[`${region}${doorNum}`] = true;
              console.log(`${doorClass} 감지됨: 로봇 ${s.id}번 위치`);
            }
          }
          
          // 이전 버전 호환성: 단순히 'door' 클래스와 지역만 있는 경우
          if (cls.includes('door') && regionOf(s) === region) {
            doorStations[`${region}1`] = true;
            doorStations[`${region}2`] = true;
            console.log(`door 클래스(지역 ${region}) 감지됨: 로봇 ${s.id}번 위치`);
          }
        }
      }
      
      // 각 문 개별 제어
      await setDoorSpecific(0, 0, doorStations.A1, 'A', 1);
      await setDoorSpecific(0, 0, doorStations.A2, 'A', 2);
      await setDoorSpecific(0, 0, doorStations.B1, 'B', 1);
      await setDoorSpecific(0, 0, doorStations.B2, 'B', 2);
      
      // ALARM 있으면 켜고, 없으면 끄기
      const alarmActive = stations.some(s => hasClass(s, 'ALARM') && robots.find(r => r.location == s.id));
      //console.log('alarm', alarmActive)
      await setAlarm(alarmActive);
      
      // AMR DI 신호 상태 출력 (11: 자동/수동, 12: 취소 On/Off, 13: 재시작 On/Off)
      for (const robot of robots) {
        try {
          const now = Date.now();
          
          // 네트워크 연결 상태 업데이트
          const isCurrentlyConnected = robot.status !== '연결 안됨';
          const wasConnected = amrLastConnectionStatus.get(robot.name);
          
          if (isCurrentlyConnected) {
            // 현재 연결된 상태
            amrLastNetworkTime.set(robot.name, now);
            
            // 재연결 감지 (이전에 연결 안됨 상태였다가 지금 연결됨)
            if (wasConnected === false) {
              console.log(`[NETWORK_RECONNECT] ${robot.name}: 네트워크 재연결 감지 - 타이머 초기화`);
              // 네트워크 연결 타이머 초기화는 위에서 이미 처리됨 (amrLastNetworkTime.set)
            }
          }
          
          // 현재 연결 상태 저장 (다음 tick에서 비교용)
          amrLastConnectionStatus.set(robot.name, isCurrentlyConnected);
          
          // 위치 변화 추적
          let position = { x: 0, y: 0 };
          try {
            if (robot.position) {
              position = typeof robot.position === 'string' 
                ? JSON.parse(robot.position) 
                : robot.position;
            }
          } catch (e) {
            // position 파싱 오류 시 기본값 사용
          }
          
          // 속도 정보 추출
          let additionalInfo = {};
          let velocity = { vx: 0, vy: 0 };
          try {
            if (robot.additional_info) {
              additionalInfo = typeof robot.additional_info === 'string' 
                ? JSON.parse(robot.additional_info) 
                : robot.additional_info;
              velocity.vx = additionalInfo.vx || 0;
              velocity.vy = additionalInfo.vy || 0;
            }
          } catch (e) {
            // additional_info 파싱 오류 시 기본값 사용
          }
          
          const lastPos = amrLastPosition.get(robot.name);
          const positionChanged = !lastPos || 
              Math.abs(lastPos.x - position.x) > 0.01 || 
              Math.abs(lastPos.y - position.y) > 0.01;
          
          // 속도가 있으면 움직이고 있다고 판단 (임계값: 0.01 m/s)
          const isMoving = Math.abs(velocity.vx) > 0.01 || Math.abs(velocity.vy) > 0.01;
          
          if (positionChanged || isMoving) {
            // 위치가 변했거나 속도가 있으면 시간 업데이트
            amrLastPosition.set(robot.name, { 
              x: position.x, 
              y: position.y, 
              timestamp: now 
            });
            
            // 위치 변화가 감지되면 일시정지 타이머도 리셋
            if (amrStopStartTime.has(robot.name)) {
              console.log(`[POSITION_RESET] ${robot.name}: 위치 변화 감지로 일시정지 타이머 리셋`);
              amrStopStartTime.delete(robot.name);
            }
            
            // 위치 변화가 감지되면 RIO 신호도 0으로 리셋
            const currentRioState = robotRioStates.get(robot.name);
            if (currentRioState === true) {
              console.log(`[POSITION_RESET] ${robot.name}: 위치 변화 감지로 RIO 신호 0으로 리셋`);
              try {
                const allRioIPs = ['192.168.0.5', '192.168.0.6'];
                for (const rioIP of allRioIPs) {
                  await setRioRegister17(rioIP, false);
                  console.log(`[POSITION_RESET] ${robot.name}: RIO 레지스터 17번을 0으로 설정 완료 (${rioIP})`);
                }
                robotRioStates.set(robot.name, false);
              } catch (error) {
                console.error(`[POSITION_RESET] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
              }
            }
          } else {
            // 위치 변화가 없는 경우, NAV 스텝이면서 이동 상태일 때만 타이머 시작
            // 실행 중인 태스크와 스텝 확인
            try {
              const runningTask = await Task.findOne({
                where: {
                  robot_id: robot.id,
                  status: 'RUNNING'
                },
                include: [{
                  model: TaskStep,
                  as: 'steps',
                  where: { status: 'RUNNING' },
                  required: false
                }]
              });
              
              const isNavStep = runningTask?.steps?.[0]?.type === 'NAV' || runningTask?.steps?.[0]?.type === 'NAV_PRE';
              const isMoving = robot.status === '이동';
              
              if (isNavStep && isMoving) {
                // NAV 스텝이면서 이동 상태인 경우에만 타이머 시작
                if (!amrStopStartTime.has(robot.name)) {
                  amrStopStartTime.set(robot.name, now);
                  console.log(`[POSITION_CHECK] ${robot.name}: NAV 중 위치 변화 없음 감지 시작 - 현재 위치: (${position.x.toFixed(3)}, ${position.y.toFixed(3)})`);
                }
              } else {
                // NAV 스텝이 아니거나 이동 상태가 아닌 경우 타이머 리셋
                if (amrStopStartTime.has(robot.name)) {
                  console.log(`[POSITION_RESET] ${robot.name}: NAV 스텝 아님 또는 이동 상태 아님으로 타이머 리셋 - 스텝: ${runningTask?.steps?.[0]?.type || 'N/A'}, 상태: ${robot.status}`);
                  amrStopStartTime.delete(robot.name);
                }
              }
            } catch (e) {
              // 태스크 조회 오류 시 무시
            }
          }
          
          // 오류 상태 추적
          if (robot.status === '오류') {
            if (!amrErrorStartTime.has(robot.name)) {
              // 새로 오류 상태가 된 경우
              amrErrorStartTime.set(robot.name, now);
              console.log(`[ERROR_DETECTED] ${robot.name}: 오류 상태 감지됨`);
            }
          } else {
            // 오류 상태가 아닌 경우
            if (amrErrorStartTime.has(robot.name)) {
              console.log(`[ERROR_RECOVERED] ${robot.name}: 오류 상태 복구됨`);
              amrErrorStartTime.delete(robot.name);
            }
          }
          
          // DI 센서 정보 처리
          const diSensors = additionalInfo.diSensors || [];
          
          // DI 11, 12, 13번 센서 찾기
          const di11 = diSensors.find(s => s.id === 11);
          const di12 = diSensors.find(s => s.id === 12);
          const di13 = diSensors.find(s => s.id === 13);
          
          // 현재 상태
          const mode = di11?.status === true ? '자동' : '수동';
          const cancelCurrent = di12?.status === true;
          const restartCurrent = di13?.status === true;
          
          // 이전 상태 가져오기
          const lastSignals = lastAmrDiSignals.get(robot.name) || { di12: false, di13: false };
          
          // Rising edge 감지 (0 → 1)
          if (cancelCurrent && !lastSignals.di12) {
            console.log(`[AMR_CANCEL] ${robot.name}: 취소 신호 감지!`);
            
            // 취소 신호 처리
            await handleCancelSignal(robot);
          }
          
          if (restartCurrent && !lastSignals.di13) {
            console.log(`[AMR_RESTART] ${robot.name}: 재시작 신호 감지!`);
            
            // 재시작 신호 처리
            await handleRestartSignal(robot);
          }
          
          // 현재 상태를 이전 상태로 저장
          lastAmrDiSignals.set(robot.name, { 
            di12: cancelCurrent, 
            di13: restartCurrent 
          });
          
          // 자동/수동 모드는 계속 출력 (상태 확인용)
          //console.log(`[AMR_DI] ${robot.name}: ${mode}`);
          
          // 태스크 일시정지 조건 확인
          await checkTaskPauseConditions(robot, now);
          
          // 위치 변화와 RIO 신호 처리 (태스크 일시정지 없음)
          await checkPositionAndRioSignal(robot, now);
          
        } catch (e) {
          // DI 정보 파싱 오류 시 무시 (너무 많은 로그 방지)
        }
      }
      
      // 자동 충전 로직: B동 버퍼에 있는 배터리 30% 이하 AMR을 충전소로 이동
      await checkAndSendLowBatteryRobotsToChargeStation(map, stations, robots);
    }

    // Task 실행기
    taskExecutor.tick().catch(console.error);
    
    // 30초마다 AMR 타이머 리포트 출력
    const now = Date.now();
    if (now - lastTimerReport >= TIMER_REPORT_INTERVAL) {
      //reportAmrTimers();
      lastTimerReport = now;
    }
    
  } catch (err) {
    console.error('[workerTick]', err);
  } finally { busy = false; }
}
setInterval(workerTick, 1000);

exports.manualDispatch = async (req, res) => {
  try {
    const { robotName, dest } = req.body || {};
    if (!robotName || !dest) return res.status(400).json({ msg: 'robotName & dest' });

    const robot = await Robot.findOne({ where: { name: robotName } });
    if (!robot) return res.status(404).json({ msg: 'robot not found' });

    // 기존 태스크 상태 확인
    if (!(await checkRobotTaskStatus(robot))) {
      return res.status(409).json({ 
        msg: `로봇 ${robot.name}에 이미 실행 중인 태스크가 있습니다.` 
      });
    }

    // 목적지 중복 체크
    if (!(await checkDestinationConflict(dest, robot.id))) {
      return res.status(409).json({ 
        msg: `목적지 ${dest}에 대한 중복 태스크가 있습니다.` 
      });
    }

    const task = await Task.create(
      {
        robot_id: robot.id,
        steps: [{
          seq: 0,
          type: 'NAV',
          payload: JSON.stringify({ dest }),
          status: 'PENDING',
        }],
      },
      { include: [{ model: TaskStep, as: 'steps' }] },
    );

    await Log.create({ type: 'TASK_MANUAL', message: `${robotName}→${dest}`, robot_name: robotName });
    
    // TaskExecutionLog에 수동 태스크 할당 기록
    try {
      await logTaskAssigned(task.id, robot.id, robot.name, '현재위치', String(dest));
    } catch (error) {
      console.error('[TASK_LOG] 수동 태스크 할당 로그 기록 오류:', error.message);
    }
    
    res.json({ task_id: task.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: e.message });
  }
};

// 서비스 최하단에 추가
async function reconnectRio(ip) {
  const dev = RIOS[ip];
  if (!dev) throw new Error('RIO not found');
  // 기존 소켓 종료
  try { dev.client._port.destroy(); } catch { }
  dev.connected = false;
  // 재접속 시도
  console.log("!!!reconnect RIO!!!")
  await tryConnectRio(ip, dev);
}

exports.reconnectRio = reconnectRio;

// 취소 신호 처리 함수
async function handleCancelSignal(robot) {
  try {
    console.log(`[CANCEL_HANDLER] ${robot.name}: 취소 신호 처리 시작`);
    
    // 1. 현재 실행 중인 태스크 찾기
    const runningTask = await Task.findOne({
      where: {
        robot_id: robot.id,
        status: { [Op.in]: ['RUNNING', 'PAUSED'] }
      }
    });
    
    if (!runningTask) {
      console.log(`[CANCEL_HANDLER] ${robot.name}: 실행 중인 태스크가 없습니다.`);
    } else {
      console.log(`[CANCEL_HANDLER] ${robot.name}: 태스크 ID ${runningTask.id} 취소 처리`);
      
      // 2. 태스크 상태를 CANCELED로 변경
      await runningTask.update({ 
        status: 'CANCELED',
        error_message: '사용자 취소 신호에 의한 태스크 취소'
      });
      
      // 3. 실행 중인 스텝들도 CANCELED로 변경
      await TaskStep.update(
        { 
          status: 'CANCELED',
          error_message: '사용자 취소 신호에 의한 스텝 취소'
        },
        {
          where: {
            task_id: runningTask.id,
            status: { [Op.in]: ['RUNNING', 'PENDING'] }
          }
        }
      );
      
      console.log(`[CANCEL_HANDLER] ${robot.name}: 태스크 취소 완료`);
      await log('TASK_CANCEL', `${robot.name}: 사용자 취소 신호`, { robot_name: robot.name });
      
      // 태스크 취소 로그 기록
      try {
        await logTaskCanceled(runningTask.id, robot.id, robot.name, '사용자 취소 신호');
      } catch (error) {
        console.error('[TASK_LOG] 태스크 취소 로그 기록 오류:', error.message);
      }
      
      // RIO 레지스터 17번을 0으로 설정 (취소 신호)
      try {
        // 모든 RIO IP에 대해 레지스터 17번 설정
        const allRioIPs = ['192.168.0.5', '192.168.0.6'];
        for (const rioIP of allRioIPs) {
          await setRioRegister17(rioIP, false);
          console.log(`[CANCEL_HANDLER] ${robot.name}: RIO 레지스터 17번을 0으로 설정 완료 (${rioIP})`);
        }
      } catch (error) {
        console.error(`[CANCEL_HANDLER] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
      }
    }
    
    // 4. DI 12번을 false로 리셋 (태스크 유무와 관계없이 항상 수행)
    console.log(`[CANCEL_HANDLER] ${robot.name}: DI 12번 리셋 시도 (API 6020 호출)`);
    await setVirtualDI(robot.ip, 12, false);
    console.log(`[CANCEL_HANDLER] ${robot.name}: 취소 신호 처리 완료`);
    
  } catch (error) {
    console.error(`[CANCEL_HANDLER] ${robot.name}: 오류 발생 - ${error.message}`);
    // 오류가 발생해도 DI 리셋은 시도
    try {
      console.log(`[CANCEL_HANDLER] ${robot.name}: 오류 발생으로 인한 DI 12번 강제 리셋 시도`);
      await setVirtualDI(robot.ip, 12, false);
    } catch (resetError) {
      console.error(`[CANCEL_HANDLER] ${robot.name}: DI 리셋 실패 - ${resetError.message}`);
    }
  }
}

// 재시작 신호 처리 함수
async function handleRestartSignal(robot) {
  try {
    console.log(`[RESTART_HANDLER] ${robot.name}: 재시작 신호 처리 시작`);
    
    // 1. 현재 실행 중인 태스크와 스텝 찾기
    const runningTask = await Task.findOne({
      where: {
        robot_id: robot.id,
        status: { [Op.in]: ['RUNNING', 'PAUSED'] }
      },
      include: [{
        model: TaskStep,
        as: 'steps',
        where: { status: 'RUNNING' },
        required: false
      }]
    });
    
    if (!runningTask || !runningTask.steps || runningTask.steps.length === 0) {
      console.log(`[RESTART_HANDLER] ${robot.name}: 실행 중인 태스크/스텝이 없습니다.`);
    } else {
      const currentStep = runningTask.steps[0];
      console.log(`[RESTART_HANDLER] ${robot.name}: 현재 스텝 ${currentStep.type} 재실행`);
      
      // 2. 태스크 상태를 RUNNING으로 변경 (PAUSED였다면)
      if (runningTask.status === 'PAUSED') {
        await runningTask.update({ status: 'RUNNING' });
        console.log(`[RESTART_HANDLER] ${robot.name}: 태스크 상태를 PAUSED → RUNNING으로 변경`);
        
        // 재개 후 유예시간 설정 (오류 상태 재체크 방지)
        const now = Date.now();
        amrResumeGraceTime.set(robot.name, now);
        console.log(`[RESTART_HANDLER] ${robot.name}: 재개 후 30초 유예시간 설정`);
        
        // 태스크 재개 로그 기록
        try {
          await logTaskResumed(runningTask.id, robot.id, robot.name, '사용자 재시작 신호');
        } catch (error) {
          console.error('[TASK_LOG] 태스크 재개 로그 기록 오류:', error.message);
        }
        
        // RIO 레지스터 17번을 0으로 설정 (재개 신호)
        try {
          // 모든 RIO IP에 대해 레지스터 17번 설정
          const allRioIPs = ['192.168.0.5', '192.168.0.6'];
          for (const rioIP of allRioIPs) {
            await setRioRegister17(rioIP, false);
            console.log(`[RESTART_HANDLER] ${robot.name}: RIO 레지스터 17번을 0으로 설정 완료 (${rioIP})`);
          }
        } catch (error) {
          console.error(`[RESTART_HANDLER] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
        }
      }
      
      // 3. 현재 스텝 명령 재전송
      await resendCurrentStepCommand(robot, currentStep);
    }
    
    // 4. DI 13번을 false로 리셋 (태스크 유무와 관계없이 항상 수행)
    console.log(`[RESTART_HANDLER] ${robot.name}: DI 13번 리셋 시도 (API 6020 호출)`);
    await setVirtualDI(robot.ip, 13, false);
    console.log(`[RESTART_HANDLER] ${robot.name}: 재시작 신호 처리 완료`);
    
  } catch (error) {
    console.error(`[RESTART_HANDLER] ${robot.name}: 오류 발생 - ${error.message}`);
    // 오류가 발생해도 DI 리셋은 시도
    try {
      console.log(`[RESTART_HANDLER] ${robot.name}: 오류 발생으로 인한 DI 13번 강제 리셋 시도`);
      await setVirtualDI(robot.ip, 13, false);
    } catch (resetError) {
      console.error(`[RESTART_HANDLER] ${robot.name}: DI 리셋 실패 - ${resetError.message}`);
    }
  }
}

// 현재 스텝 명령 재전송 함수
async function resendCurrentStepCommand(robot, step) {
  try {
    const payload = typeof step.payload === 'string' 
      ? JSON.parse(step.payload) 
      : (step.payload ?? {});
    
    console.log(`[RESEND_CMD] ${robot.name}: ${step.type} 명령 재전송`);
    
    if (step.type === 'NAV' || step.type === 'NAV_PRE') {
      // NAV 명령 재전송
      await sendGotoNav(robot.ip, payload.dest, 'SELF_POSITION', `${Date.now()}`);
      console.log(`[RESEND_CMD] ${robot.name}: NAV 명령 재전송 완료 → dest=${payload.dest}`);
      
    } else if (['JACK', 'JACK_UP', 'JACK_DOWN'].includes(step.type)) {
      // JACK 명령 재전송
      const height = step.type === 'JACK_UP' ? 0.03
                   : step.type === 'JACK_DOWN' ? 0.0
                   : payload.height;
      
      // JACK 명령은 robotJackService를 사용해야 하므로 import 필요
      const { sendJackCommand } = require('./robotJackService');
      const JACK_CODES = require('../controllers/jackController').CODES;
      
      await sendJackCommand(robot.ip, JACK_CODES.setHeight, { height });
      console.log(`[RESEND_CMD] ${robot.name}: JACK 명령 재전송 완료 → height=${height}`);
    }
    
  } catch (error) {
    console.error(`[RESEND_CMD] ${robot.name}: 명령 재전송 오류 - ${error.message}`);
  }
}

// 태스크 일시정지 조건 확인 함수 (위치 변화 없음 조건 제거)
async function checkTaskPauseConditions(robot, now) {
  try {
    const TIMEOUT_MS = 60 * 1000; // 1분 (네트워크 연결 끊김용)
    const GRACE_PERIOD_MS = 30 * 1000; // 30초 (재개 후 유예시간)
    
    // 현재 실행 중인 태스크 확인
    const runningTask = await Task.findOne({
      where: {
        robot_id: robot.id,
        status: 'RUNNING'
      },
      include: [{
        model: TaskStep,
        as: 'steps',
        where: { status: 'RUNNING' },
        required: false
      }]
    });
    
    if (!runningTask) return; // 실행 중인 태스크가 없으면 체크 안함
    
    let shouldPause = false;
    let reason = '';
    
    // 1. 네트워크 연결 끊김 체크 (1분 이상)
    const lastNetworkTime = amrLastNetworkTime.get(robot.name);
    if (lastNetworkTime && now - lastNetworkTime > TIMEOUT_MS) {
      shouldPause = true;
      reason = '네트워크 연결 끊김 (1분 이상)';
    }
    
    // 2. 오류 상태 체크 (바로 일시정지, 단 재개 후 유예시간 고려)
    const errorStartTime = amrErrorStartTime.get(robot.name);
    const resumeGraceTime = amrResumeGraceTime.get(robot.name);
    
    if (errorStartTime) {
      // 재개 후 유예시간 내인지 확인
      const inGracePeriod = resumeGraceTime && (now - resumeGraceTime) < GRACE_PERIOD_MS;
      
      if (!inGracePeriod) {
        // 유예시간이 없거나 유예시간이 지났으면 바로 일시정지
        shouldPause = true;
        reason = 'AMR 오류 상태 감지';
        console.log(`[ERROR_PAUSE] ${robot.name}: 오류 상태로 인한 즉시 일시정지 (유예시간: ${inGracePeriod ? '적용중' : '없음'})`);
      } else {
        console.log(`[ERROR_GRACE] ${robot.name}: 오류 상태이지만 재개 후 유예시간 중 (${Math.round((GRACE_PERIOD_MS - (now - resumeGraceTime)) / 1000)}초 남음)`);
      }
    }
    
    // 태스크 일시정지 실행
    if (shouldPause) {
      console.log(`[TASK_PAUSE] ${robot.name}: ${reason} - 태스크 일시정지`);
      await runningTask.update({ status: 'PAUSED' });
      await log('TASK_PAUSE', `${robot.name}: ${reason}`, { robot_name: robot.name });
      
      // 유예시간 초기화 (일시정지되었으므로)
      if (amrResumeGraceTime.has(robot.name)) {
        amrResumeGraceTime.delete(robot.name);
        console.log(`[GRACE_CLEAR] ${robot.name}: 일시정지로 인한 유예시간 초기화`);
      }
      
      // 태스크 일시정지 로그 기록
      try {
        await logTaskPaused(runningTask.id, robot.id, robot.name, reason);
      } catch (error) {
        console.error('[TASK_LOG] 태스크 일시정지 로그 기록 오류:', error.message);
      }
      
      // 🚨 알람 울림 - 매우 눈에 띄는 경고 메시지
      console.log('\n' + '🚨'.repeat(50));
      console.log('🚨🚨🚨 【 AMR 알람 발생 】 🚨🚨🚨');
      console.log(`🚨 로봇명: ${robot.name}`);
      console.log(`🚨 사유: ${reason}`);
      console.log(`🚨 시간: ${new Date().toLocaleString()}`);
      console.log(`🚨 상태: 태스크 일시정지로 인한 알람 활성화`);
      console.log('🚨'.repeat(50) + '\n');
      
      // RIO 레지스터 17번을 1로 설정 (일시정지 신호)
      try {
        // 모든 RIO IP에 대해 레지스터 17번 설정
        const allRioIPs = ['192.168.0.5', '192.168.0.6'];
        for (const rioIP of allRioIPs) {
          await setRioRegister17(rioIP, true);
          console.log(`[TASK_PAUSE] ${robot.name}: RIO 레지스터 17번을 1로 설정 완료 (${rioIP})`);
        }
      } catch (error) {
        console.error(`[TASK_PAUSE] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error(`[TASK_PAUSE_CHECK] ${robot.name}: 오류 발생 - ${error.message}`);
  }
}

// 위치 변화와 RIO 신호 처리 함수 (태스크는 일시정지하지 않음)
async function checkPositionAndRioSignal(robot, now) {
  try {
    const TIMEOUT_MS = 60 * 1000; // 1분
    
    // 현재 실행 중인 태스크 확인
    const runningTask = await Task.findOne({
      where: {
        robot_id: robot.id,
        status: 'RUNNING'
      },
      include: [{
        model: TaskStep,
        as: 'steps',
        where: { status: 'RUNNING' },
        required: false
      }]
    });
    
    if (!runningTask) {
      // 실행 중인 태스크가 없으면 RIO 신호를 0으로 리셋
      const currentRioState = robotRioStates.get(robot.name);
      if (currentRioState === true) {
        try {
          const allRioIPs = ['192.168.0.5', '192.168.0.6'];
          for (const rioIP of allRioIPs) {
            await setRioRegister17(rioIP, false);
            console.log(`[RIO_RESET] ${robot.name}: 태스크 없음으로 RIO 레지스터 17번을 0으로 설정 (${rioIP})`);
          }
          robotRioStates.set(robot.name, false);
        } catch (error) {
          console.error(`[RIO_RESET] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
        }
      }
      return;
    }
    
    // NAV 스텝 중 위치 변화 없음 체크 (1분 이상)
    if (runningTask.steps && runningTask.steps.length > 0) {
      const currentStep = runningTask.steps[0];
      if ((currentStep.type === 'NAV' || currentStep.type === 'NAV_PRE') && robot.status === '이동') {
        const stopStartTime = amrStopStartTime.get(robot.name);
        const currentRioState = robotRioStates.get(robot.name);
        
        if (stopStartTime && now - stopStartTime > TIMEOUT_MS) {
          // 위치 변화 없음이 1분 이상 지속됨 - RIO 신호만 1로 설정
          if (currentRioState !== true) {
            console.log(`[RIO_SIGNAL] ${robot.name}: NAV 중 위치 변화 없음 (1분 이상) - RIO 신호 1로 설정`);
            console.log(`[RIO_SIGNAL] ${robot.name}: 시작 시간: ${new Date(stopStartTime).toLocaleTimeString()}, 지속 시간: ${Math.round((now - stopStartTime) / 1000)}초, 현재 스텝: ${currentStep.type}`);
            
            // 🚨 알람 울림 - 매우 눈에 띄는 경고 메시지
            console.log('\n' + '⚠️'.repeat(50));
            console.log('⚠️⚠️⚠️ 【 AMR 위치 변화 없음 알람 】 ⚠️⚠️⚠️');
            console.log(`⚠️ 로봇명: ${robot.name}`);
            console.log(`⚠️ 사유: NAV 중 위치 변화 없음 (1분 이상 지속)`);
            console.log(`⚠️ 시작시간: ${new Date(stopStartTime).toLocaleString()}`);
            console.log(`⚠️ 지속시간: ${Math.round((now - stopStartTime) / 1000)}초`);
            console.log(`⚠️ 현재스텝: ${currentStep.type}`);
            console.log(`⚠️ 시간: ${new Date().toLocaleString()}`);
            console.log('⚠️'.repeat(50) + '\n');
            
            try {
              const allRioIPs = ['192.168.0.5', '192.168.0.6'];
              for (const rioIP of allRioIPs) {
                await setRioRegister17(rioIP, true);
                console.log(`[RIO_SIGNAL] ${robot.name}: RIO 레지스터 17번을 1로 설정 완료 (${rioIP})`);
              }
              robotRioStates.set(robot.name, true);
            } catch (error) {
              console.error(`[RIO_SIGNAL] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
            }
          }
        } else {
          // 위치 변화 없음이 1분 미만이거나 타이머가 없음 - RIO 신호를 0으로 유지
          if (currentRioState === true) {
            console.log(`[RIO_SIGNAL] ${robot.name}: NAV 중이지만 위치 변화 없음 시간이 1분 미만 - RIO 신호 0으로 리셋`);
            
            try {
              const allRioIPs = ['192.168.0.5', '192.168.0.6'];
              for (const rioIP of allRioIPs) {
                await setRioRegister17(rioIP, false);
                console.log(`[RIO_SIGNAL] ${robot.name}: RIO 레지스터 17번을 0으로 설정 완료 (${rioIP})`);
              }
              robotRioStates.set(robot.name, false);
            } catch (error) {
              console.error(`[RIO_SIGNAL] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
            }
          }
        }
      } else {
        // NAV 스텝이 아니거나 이동 상태가 아님 - RIO 신호를 0으로 리셋
        const currentRioState = robotRioStates.get(robot.name);
        if (currentRioState === true) {
          console.log(`[RIO_SIGNAL] ${robot.name}: NAV 스텝 아님 또는 이동 상태 아님 - RIO 신호 0으로 리셋`);
          
          try {
            const allRioIPs = ['192.168.0.5', '192.168.0.6'];
            for (const rioIP of allRioIPs) {
              await setRioRegister17(rioIP, false);
              console.log(`[RIO_SIGNAL] ${robot.name}: RIO 레지스터 17번을 0으로 설정 완료 (${rioIP})`);
            }
            robotRioStates.set(robot.name, false);
          } catch (error) {
            console.error(`[RIO_SIGNAL] ${robot.name}: RIO 레지스터 설정 오류 - ${error.message}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error(`[RIO_SIGNAL_CHECK] ${robot.name}: 오류 발생 - ${error.message}`);
  }
}

/* ─────────────── 10. export (테스트용) ─────────────────────────── */
exports.workerTick = workerTick;
exports.pollAllRios = pollAllRios;
exports.lastRioSignal = lastRioSignal;
exports.lastAmrDiSignals = lastAmrDiSignals;
exports.amrLastNetworkTime = amrLastNetworkTime;
exports.amrLastPosition = amrLastPosition;
exports.amrErrorStartTime = amrErrorStartTime;
exports.amrStopStartTime = amrStopStartTime;
exports.amrLastConnectionStatus = amrLastConnectionStatus;
exports.amrResumeGraceTime = amrResumeGraceTime;
exports.RIOS = RIOS;
exports.doorState = doorState;
exports.ALARM_STATE = ALARM_STATE;
exports.DOOR_IPS = DOOR_IPS;

/* ─────────────── 버퍼 버튼 눌림 처리 (충전소->버퍼 AMR 호출) ─────────────── */
async function callAmrToBuffer(region, bufferNum) {
  try {
    // 1. 지도와 스테이션 정보 로드
    const map = await MapDB.findOne({ where: { is_current: true } });
    if (!map) {
      console.error(`[버퍼버튼] 맵 정보를 찾을 수 없습니다.`);
      return;
    }
    
    const stations = (JSON.parse(map.stations || '{}').stations) || [];
    const bufferName = `${region}${bufferNum}`;
    const bufferSt = stations.find(s => s.name === bufferName);
    
    if (!bufferSt) {
      console.error(`[버퍼버튼] ${bufferName} 스테이션을 찾을 수 없습니다.`);
      return;
    }
    
    // 2. 해당 버퍼에 로봇이 있는지 확인
    const robots = await Robot.findAll();
    const robotAtBuffer = robots.find(r => String(r.location) === String(bufferSt.id));
    
    if (robotAtBuffer) {
      console.log(`[버퍼버튼] ${bufferName}에 이미 로봇(${robotAtBuffer.name})이 있습니다. 호출 무시.`);
      return;
    }
    
    // 3. 충전 스테이션에 있는 로봇 찾기
    const chargeStations = stations.filter(s => 
      regionOf(s) === region && 
      hasClass(s, '충전')
    );
    
    if (chargeStations.length === 0) {
      console.log(`[버퍼버튼] ${region} 지역에 충전 스테이션이 없습니다.`);
      return;
    }
    
    // 충전 스테이션에 있는 로봇들 중 새로운 조건에 따라 선택
    const robotsAtChargeStations = [];
    
    for (const chargeSt of chargeStations) {
      const robot = robots.find(r => String(r.location) === String(chargeSt.id));
      if (robot) {
        const batteryLevel = robot.battery || 0;
        console.log(`[버퍼버튼] 충전 스테이션 ${chargeSt.name}의 로봇 ${robot.name}: 배터리 ${batteryLevel}%`);
        robotsAtChargeStations.push({ robot, batteryLevel, chargeStation: chargeSt });
      }
    }
    
    if (robotsAtChargeStations.length === 0) {
      console.log(`[버퍼버튼] ${region} 지역 충전 스테이션에 로봇이 없습니다.`);
      
      // 같은 지역의 다른 버퍼에서 AMR 찾기
      console.log(`[버퍼버튼] 같은 지역의 다른 버퍼에서 AMR 호출 시도...`);
      
      // 같은 지역의 다른 버퍼 스테이션들 찾기 (현재 요청된 버퍼 제외)
      const otherBufferStations = stations.filter(s => 
        regionOf(s) === region && 
        hasClass(s, '버퍼') && 
        s.name.match(/^[AB][1-3]$/) && // A1-A3, B1-B3 형태
        s.name !== bufferName // 현재 요청된 버퍼 제외
      );
      
      console.log(`[버퍼버튼] ${region} 지역 다른 버퍼 스테이션: ${otherBufferStations.map(s => s.name).join(', ')}`);
      
      // 다른 버퍼에서 AMR 찾기
      let selectedBufferRobot = null;
      let sourceBufferStation = null;
      
      for (const bufferSt of otherBufferStations) {
        const robotAtOtherBuffer = robots.find(r => String(r.location) === String(bufferSt.id));
        
        if (robotAtOtherBuffer) {
          console.log(`[버퍼버튼] ${bufferSt.name}에서 로봇 ${robotAtOtherBuffer.name} 발견`);
          
          // 기존 태스크 상태 확인
          const hasTask = await checkRobotTaskStatus(robotAtOtherBuffer);
          
          if (hasTask) {
            selectedBufferRobot = robotAtOtherBuffer;
            sourceBufferStation = bufferSt;
            console.log(`[버퍼버튼] ${bufferSt.name}의 로봇 ${robotAtOtherBuffer.name}을 선택했습니다.`);
            break; // 첫 번째로 찾은 사용 가능한 로봇 선택
          } else {
            console.log(`[버퍼버튼] ${bufferSt.name}의 로봇 ${robotAtOtherBuffer.name}에 이미 태스크가 있어 건너뜀`);
          }
        }
      }
      
      if (!selectedBufferRobot) {
        console.log(`[버퍼버튼] ${region} 지역 다른 버퍼에도 사용 가능한 AMR이 없습니다.`);
        return;
      }
      
      // 목적지 중복 체크
      if (!(await checkDestinationConflict(bufferSt.id, selectedBufferRobot.id))) {
        console.log(`[버퍼버튼] 목적지 ${bufferName}에 대한 중복 태스크가 있어 호출을 건너뜁니다.`);
        return;
      }
      
      // 소스 버퍼의 PRE 스테이션과 목적지 버퍼의 PRE 스테이션 찾기
      const sourceBufferPreSt = stations.find(s => s.name === `${sourceBufferStation.name}_PRE`);
      const targetBufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
      
      if (!sourceBufferPreSt) {
        console.error(`[버퍼버튼] ${sourceBufferStation.name}_PRE 스테이션을 찾을 수 없습니다.`);
        return;
      }
      
      if (!targetBufferPreSt) {
        console.error(`[버퍼버튼] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
        return;
      }
      
      // 태스크 생성 (JACK_DOWN → 소스버퍼_PRE → 목적지버퍼_PRE → 목적지버퍼 → JACK_UP)
      const task = await Task.create(
        {
          robot_id: selectedBufferRobot.id,
          steps: [
            {
              seq: 0,
              type: 'JACK_DOWN',
              payload: JSON.stringify({ height: 0.0 }),
              status: 'PENDING',
            },
            {
              seq: 1,
              type: 'NAV',
              payload: JSON.stringify({ dest: sourceBufferPreSt.id }),
              status: 'PENDING',
            },
            {
              seq: 2,
              type: 'NAV',
              payload: JSON.stringify({ dest: targetBufferPreSt.id }),
              status: 'PENDING',
            },
            {
              seq: 3,
              type: 'NAV',
              payload: JSON.stringify({ dest: bufferSt.id }),
              status: 'PENDING',
            },
            {
              seq: 4,
              type: 'JACK_UP',
              payload: JSON.stringify({ height: 0.03 }),
              status: 'PENDING',
            }
          ],
        },
        { include: [{ model: TaskStep, as: 'steps' }] },
      );
      
      console.log(`[버퍼버튼] 다른 버퍼에서 로봇(${selectedBufferRobot.name})을 ${sourceBufferStation.name} → ${bufferName}으로 호출하는 태스크 생성 완료 (태스크 ID: ${task.id})`);
      await log('BUTTON_TASK', `버퍼간 호출: ${selectedBufferRobot.name} ${sourceBufferStation.name} → ${bufferName}`, { robot_name: selectedBufferRobot.name });
      
      // 태스크 할당 로그 기록
      try {
        await logTaskAssigned(task.id, selectedBufferRobot.id, selectedBufferRobot.name, sourceBufferStation.name, bufferName);
      } catch (error) {
        console.error('[TASK_LOG] 버퍼간 호출 태스크 할당 로그 기록 오류:', error.message);
      }
      
      return; // 다른 버퍼에서 로봇을 호출했으므로 여기서 처리 종료
    } else {
      // 충전 스테이션에 로봇이 있는 경우의 처리
      // 새로운 호출 조건 적용
      let selectedRobot = null;
      
      if (robotsAtChargeStations.length >= 2) {
        // 2대 이상: 배터리가 가장 높은 로봇 선택
        const bestRobot = robotsAtChargeStations.reduce((highest, current) => {
          return current.batteryLevel > highest.batteryLevel ? current : highest;
        });
        selectedRobot = bestRobot.robot;
        console.log(`[버퍼버튼] 충전소에 ${robotsAtChargeStations.length}대 있음: 배터리 최고인 ${bestRobot.robot.name} (${bestRobot.batteryLevel}%) 선택`);
      } else if (robotsAtChargeStations.length === 1) {
        // 1대: 배터리 70% 이상인 경우만 호출
        const singleRobotInfo = robotsAtChargeStations[0];
        if (singleRobotInfo.batteryLevel >= 70) {
          selectedRobot = singleRobotInfo.robot;
          console.log(`[버퍼버튼] 충전소에 1대 있음: ${singleRobotInfo.robot.name} (${singleRobotInfo.batteryLevel}%) - 70% 이상이므로 호출`);
        } else {
          console.log(`[버퍼버튼] 충전소에 1대 있지만 배터리가 ${singleRobotInfo.batteryLevel}%로 70% 미만입니다. 호출하지 않습니다.`);
          return;
        }
      }
      
      if (!selectedRobot) {
        console.log(`[버퍼버튼] 호출 조건을 만족하는 로봇이 없습니다.`);
        return;
      }
      
      const batteryLevel = selectedRobot.battery || 0;
      console.log(`[버퍼버튼] 선택된 로봇: ${selectedRobot.name} (배터리: ${batteryLevel}%)`);
      console.log(`[버퍼버튼] ${bufferName}로 로봇(${selectedRobot.name}, 배터리:${batteryLevel}%) 호출 시작`);
      
      // 기존 태스크 상태 확인
      if (!(await checkRobotTaskStatus(selectedRobot))) {
        console.log(`[버퍼버튼] 로봇 ${selectedRobot.name}에 이미 실행 중인 태스크가 있어 호출을 건너뜁니다.`);
        return;
      }
      
      // 목적지 중복 체크
      if (!(await checkDestinationConflict(bufferSt.id, selectedRobot.id))) {
        console.log(`[버퍼버튼] 목적지 ${bufferName}에 대한 중복 태스크가 있어 호출을 건너뜁니다.`);
        return;
      }
      
      // 버퍼 PRE 스테이션 찾기
      const bufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
      
      if (!bufferPreSt) {
        console.error(`[버퍼버튼] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
        return;
      }
      
      // 태스크 생성 (충전소 → 버퍼_PRE → 버퍼)
      const task = await Task.create(
        {
          robot_id: selectedRobot.id,
          steps: [
            {
              seq: 0,
              type: 'NAV',
              payload: JSON.stringify({ dest: bufferPreSt.id }),
              status: 'PENDING',
            },
            {
              seq: 1,
              type: 'NAV',
              payload: JSON.stringify({ dest: bufferSt.id }),
              status: 'PENDING',
            }
          ],
        },
        { include: [{ model: TaskStep, as: 'steps' }] },
      );
      
      console.log(`[버퍼버튼] 충전소에서 로봇(${selectedRobot.name})을 ${bufferName}으로 호출하는 태스크 생성 완료 (태스크 ID: ${task.id})`);
      await log('BUTTON_TASK', `충전소 호출: ${selectedRobot.name} → ${bufferName}`, { robot_name: selectedRobot.name });
      
      // 태스크 할당 로그 기록
      try {
        await logTaskAssigned(task.id, selectedRobot.id, selectedRobot.name, 'charge_1', bufferName);
      } catch (error) {
        console.error('[TASK_LOG] 충전소 호출 태스크 할당 로그 기록 오류:', error.message);
      }
      
      return; // 충전소에서 로봇을 호출했으므로 여기서 처리 종료
    }
  } catch (error) {
    console.error(`[버퍼버튼] 오류 발생:`, error);
    throw error;
  }
}

exports.sendGotoNav = sendGotoNav;
exports.setRioRegister17 = setRioRegister17;
exports.setRioRegister = setRioRegister;
exports.setBufferButtonFeedback = setBufferButtonFeedback;
exports.checkDestinationConflict = checkDestinationConflict;

// 자동 충전 로직: B동 버퍼에 있는 배터리 30% 이하 AMR을 충전소로 이동
async function checkAndSendLowBatteryRobotsToChargeStation(map, stations, robots) {
  try {
    if (!map || !stations || !robots) return;
    
    // B지역 버퍼 스테이션들 찾기
    const bBufferStations = stations.filter(s => 
      regionOf(s) === 'B' && 
      hasClass(s, '버퍼') && 
      s.name.match(/^B[1-3]$/) // B1, B2, B3 형태
    );
    
    // A지역 버퍼 스테이션들 찾기
    const aBufferStations = stations.filter(s => 
      regionOf(s) === 'A' && 
      hasClass(s, '버퍼') && 
      s.name.match(/^A[1-3]$/) // A1, A2, A3 형태
    );
    
    // B지역 충전 스테이션들 찾기
    const bChargeStations = stations.filter(s => 
      regionOf(s) === 'B' && 
      hasClass(s, '충전')
    );
    
    if (bChargeStations.length === 0) {
      console.log('[AUTO_CHARGE] B지역 충전 스테이션을 찾을 수 없습니다.');
      return;
    }
    
    // A→B 이동에 필요한 스테이션들 찾기
    const icA = stations.find(s => regionOf(s) === 'A' && hasClass(s, 'IC'));
    const icB = stations.find(s => regionOf(s) === 'B' && hasClass(s, 'IC'));
    const lm78 = stations.find(s => String(s.id) === '78' || s.name === 'LM78');
    
    // 저배터리 로봇들 수집
    const lowBatteryRobots = [];
    
    // B지역 버퍼에 있는 로봇들 중 배터리 30% 이하인 로봇 찾기
    for (const bufferStation of bBufferStations) {
      const robotAtBuffer = robots.find(r => String(r.location) === String(bufferStation.id));
      
      if (robotAtBuffer) {
        const batteryLevel = robotAtBuffer.battery || 0;
        
        if (batteryLevel <= 50) {
          // 기존 태스크가 있는지 확인
          const hasTask = await checkRobotTaskStatus(robotAtBuffer);
          
          if (hasTask) {
            lowBatteryRobots.push({
              robot: robotAtBuffer,
              currentStation: bufferStation,
              batteryLevel: batteryLevel,
              region: 'B'
            });
            
            console.log(`[AUTO_CHARGE] B지역 저배터리 로봇 발견: ${robotAtBuffer.name} (${batteryLevel}%) at ${bufferStation.name}`);
          } else {
            console.log(`[AUTO_CHARGE] B지역 저배터리 로봇 ${robotAtBuffer.name}에 이미 태스크가 있어 건너뜀`);
          }
        }
      }
    }
    
    // A지역 버퍼에 있는 로봇들 중 배터리 30% 이하인 로봇 찾기
    if (aBufferStations.length > 0 && icA && icB && lm78) {
      for (const bufferStation of aBufferStations) {
        const robotAtBuffer = robots.find(r => String(r.location) === String(bufferStation.id));
        
        if (robotAtBuffer) {
          const batteryLevel = robotAtBuffer.battery || 0;
          
          if (batteryLevel <= 50) {
            // 기존 태스크가 있는지 확인
            const hasTask = await checkRobotTaskStatus(robotAtBuffer);
            
            if (hasTask) {
              lowBatteryRobots.push({
                robot: robotAtBuffer,
                currentStation: bufferStation,
                batteryLevel: batteryLevel,
                region: 'A'
              });
              
              console.log(`[AUTO_CHARGE] A지역 저배터리 로봇 발견: ${robotAtBuffer.name} (${batteryLevel}%) at ${bufferStation.name}`);
            } else {
              console.log(`[AUTO_CHARGE] A지역 저배터리 로봇 ${robotAtBuffer.name}에 이미 태스크가 있어 건너뜀`);
            }
          }
        }
      }
    } else if (aBufferStations.length > 0) {
      console.log('[AUTO_CHARGE] A지역 버퍼가 있지만 A→B 이동에 필요한 스테이션을 찾을 수 없습니다. (IC-A, IC-B, LM78 필요)');
    }
    
    if (lowBatteryRobots.length === 0) {
      //console.log('[AUTO_CHARGE] 배터리 50% 이하의 태스크 없는 로봇이 없습니다.');
      return;
    }
    
    // 각 저배터리 로봇을 빈 충전소로 보내기
    for (const { robot, currentStation, batteryLevel, region } of lowBatteryRobots) {
      try {
        // 빈 충전 스테이션 찾기
        const emptyChargeStation = bChargeStations.find(cs => 
          !robots.some(r => String(r.location) === String(cs.id))
        );
        
        if (!emptyChargeStation) {
          console.log(`[AUTO_CHARGE] ${robot.name}: 빈 충전 스테이션이 없어 대기`);
          continue;
        }
        
        // 충전 스테이션의 PRE 스테이션 찾기
        const chargePreStation = stations.find(s => 
          s.name === `${emptyChargeStation.name}_PRE`
        );
        
        if (!chargePreStation) {
          console.log(`[AUTO_CHARGE] ${robot.name}: ${emptyChargeStation.name}_PRE 스테이션을 찾을 수 없음`);
          continue;
        }
        
        // 목적지 중복 체크
        if (!(await checkDestinationConflict(emptyChargeStation.id, robot.id))) {
          console.log(`[AUTO_CHARGE] ${robot.name}: 충전소 ${emptyChargeStation.name}에 대한 중복 태스크가 있어 건너뜀`);
          continue;
        }
        
        let taskSteps = [];
        
        if (region === 'B') {
          // B지역: 기존 로직 (JACK_DOWN → 충전소PRE → 충전소)
          taskSteps = [
            {
              seq: 0,
              type: 'JACK_DOWN',
              payload: JSON.stringify({ height: 0.0 }),
              status: 'PENDING',
            },
            {
              seq: 1,
              type: 'NAV',
              payload: JSON.stringify({ dest: chargePreStation.id }),
              status: 'PENDING',
            },
            {
              seq: 2,
              type: 'NAV',
              payload: JSON.stringify({ dest: emptyChargeStation.id }),
              status: 'PENDING',
            }
          ];
        } else if (region === 'A') {
          // A지역: JACK_DOWN → IC-A → WAIT_FREE_PATH → LM78 → IC-B → 동적으로 빈 충전소 찾기
          taskSteps = [
            {
              seq: 0,
              type: 'JACK_DOWN',
              payload: JSON.stringify({ height: 0.0 }),
              status: 'PENDING',
            },
            {
              seq: 1,
              type: 'NAV',
              payload: JSON.stringify({ dest: icA.id }),
              status: 'PENDING',
            },
            {
              seq: 2,
              type: 'WAIT_FREE_PATH',
              payload: JSON.stringify({}),
              status: 'PENDING',
            },
            {
              seq: 3,
              type: 'NAV',
              payload: JSON.stringify({ dest: lm78.id }),
              status: 'PENDING',
            },
            {
              seq: 4,
              type: 'NAV',
              payload: JSON.stringify({ dest: icB.id }),
              status: 'PENDING',
            },
            {
              seq: 5,
              type: 'FIND_EMPTY_B_CHARGE',
              payload: JSON.stringify({}),
              status: 'PENDING',
            }
          ];
        }
        
        // 자동 충전 태스크 생성
        const task = await Task.create(
          {
            robot_id: robot.id,
            steps: taskSteps,
          },
          { include: [{ model: TaskStep, as: 'steps' }] },
        );
        
        console.log(`[AUTO_CHARGE] ${region}지역 ${robot.name} (배터리:${batteryLevel}%) → ${emptyChargeStation.name} 자동 충전 태스크 생성 (태스크 ID: ${task.id})`);
        await log('AUTO_CHARGE', `자동 충전: ${region}지역 ${robot.name} (${batteryLevel}%) → ${emptyChargeStation.name}`, { robot_name: robot.name });
        
        // 태스크 할당 로그 기록
        try {
          await logTaskAssigned(task.id, robot.id, robot.name, currentStation.name, emptyChargeStation.name);
        } catch (error) {
          console.error('[TASK_LOG] 자동 충전 태스크 할당 로그 기록 오류:', error.message);
        }
        
      } catch (error) {
        console.error(`[AUTO_CHARGE] ${robot.name} 자동 충전 태스크 생성 오류:`, error.message);
      }
    }
    
  } catch (error) {
    console.error('[AUTO_CHARGE] 자동 충전 로직 오류:', error.message);
  }
}

exports.sendGotoNav = sendGotoNav;

// 새로운 우선순위 기반 AMR 호출 함수
async function callAmrToBufferWithPriority(region, bufferNum, bufferName, targetSt, stations, robots) {
  console.log(`[우선순위호출] ${bufferName} 버퍼 호출 시작`);
  
  // 필요한 스테이션들 미리 찾기
  const targetBufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
  const icA = stations.find(s => regionOf(s) === 'A' && hasClass(s, 'IC'));
  const icB = stations.find(s => regionOf(s) === 'B' && hasClass(s, 'IC'));
  const lm73 = stations.find(s => String(s.id) === '73' || s.name === 'LM73');
  
  if (!targetBufferPreSt) {
    console.error(`[우선순위호출] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
    return null;
  }
  
  // 우선순위 1: 같은 지역(A,B)의 버퍼(A1~3, B1~3)에 있는 다른 AMR
  console.log(`[우선순위호출] 우선순위 1: ${region} 지역 다른 버퍼에서 AMR 찾기`);
  
  const sameRegionBuffers = stations.filter(s => 
    regionOf(s) === region && 
    hasClass(s, '버퍼') && 
    s.name.match(/^[AB][1-3]$/) && 
    s.name !== bufferName
  );
  
  for (const bufferSt of sameRegionBuffers) {
    const robotAtBuffer = robots.find(r => String(r.location) === String(bufferSt.id));
    
    if (robotAtBuffer) {
      // 기존 태스크 상태 확인
      const hasTask = await checkRobotTaskStatus(robotAtBuffer);
      
      if (hasTask) {
        // 목적지 중복 체크
        if (await checkDestinationConflict(targetSt.id, robotAtBuffer.id)) {
          console.log(`[우선순위호출] 우선순위 1 성공: ${bufferSt.name}의 로봇 ${robotAtBuffer.name} 선택`);
          
          // 소스 버퍼의 PRE 스테이션 찾기
          const sourceBufferPreSt = stations.find(s => s.name === `${bufferSt.name}_PRE`);
          
          if (!sourceBufferPreSt) {
            console.error(`[우선순위호출] ${bufferSt.name}_PRE 스테이션을 찾을 수 없습니다.`);
            continue;
          }
          
          // 1번 시퀀스: JACK_DOWN → 소스버퍼_PRE → 타겟버퍼_PRE → 타겟버퍼 → JACK_UP
          const task = await Task.create(
            {
              robot_id: robotAtBuffer.id,
              steps: [
                {
                  seq: 0,
                  type: 'JACK_DOWN',
                  payload: JSON.stringify({ height: 0.0 }),
                  status: 'PENDING',
                },
                {
                  seq: 1,
                  type: 'NAV',
                  payload: JSON.stringify({ dest: sourceBufferPreSt.id }),
                  status: 'PENDING',
                },
                {
                  seq: 2,
                  type: 'NAV',
                  payload: JSON.stringify({ dest: targetBufferPreSt.id }),
                  status: 'PENDING',
                },
                {
                  seq: 3,
                  type: 'NAV',
                  payload: JSON.stringify({ dest: targetSt.id }),
                  status: 'PENDING',
                },
                {
                  seq: 4,
                  type: 'JACK_UP',
                  payload: JSON.stringify({ height: 0.03 }),
                  status: 'PENDING',
                }
              ],
            },
            { include: [{ model: TaskStep, as: 'steps' }] },
          );
          
          await log('PRIORITY_CALL', `우선순위1-버퍼간: ${robotAtBuffer.name} ${bufferSt.name} → ${bufferName}`, { robot_name: robotAtBuffer.name });
          
          try {
            await logTaskAssigned(task.id, robotAtBuffer.id, robotAtBuffer.name, bufferSt.name, bufferName);
          } catch (error) {
            console.error('[TASK_LOG] 우선순위1 태스크 할당 로그 기록 오류:', error.message);
          }
          
          return { robot: robotAtBuffer, source: bufferSt.name, task: task };
        }
      }
    }
  }
  
  //우선순위 2: 충전소에 있는 AMR 중 배터리가 가장 높고 30% 이상인 것

  console.log(`[우선순위호출] 우선순위 2: 충전소에서 AMR 찾기`);
  
  const chargeStations = stations.filter(s => hasClass(s, '충전'));
  const robotsAtChargeStations = [];
  
  for (const chargeSt of chargeStations) {
    const robotAtCharge = robots.find(r => String(r.location) === String(chargeSt.id));
    if (robotAtCharge) {
      const batteryLevel = robotAtCharge.battery || 0;
      if (batteryLevel >= 30) {
        robotsAtChargeStations.push({ 
          robot: robotAtCharge, 
          batteryLevel, 
          chargeStation: chargeSt 
        });
      }
    }
  }
  
  if (robotsAtChargeStations.length > 0) {
    // 배터리가 가장 높은 로봇 선택
    const bestChargeRobot = robotsAtChargeStations.reduce((highest, current) => {
      return current.batteryLevel > highest.batteryLevel ? current : highest;
    });
    
    const selectedRobot = bestChargeRobot.robot;
    const chargeRegion = regionOf(bestChargeRobot.chargeStation);
    
    // 기존 태스크 상태 및 목적지 중복 체크
    if ((await checkRobotTaskStatus(selectedRobot)) && 
        (await checkDestinationConflict(targetSt.id, selectedRobot.id))) {
      
      console.log(`[우선순위호출] 우선순위 2 성공: 충전소의 로봇 ${selectedRobot.name} (배터리: ${bestChargeRobot.batteryLevel}%, 충전소 지역: ${chargeRegion}) 선택`);
      
      let taskSteps = [];
      
      if (region === 'B') {
        // B동 버퍼: 호출한 버퍼의 PRE → 버퍼 → JACK_UP
        taskSteps = [
          {
            seq: 0,
            type: 'NAV',
            payload: JSON.stringify({ dest: targetBufferPreSt.id }),
            status: 'PENDING',
          },
          {
            seq: 1,
            type: 'NAV',
            payload: JSON.stringify({ dest: targetSt.id }),
            status: 'PENDING',
          },
          {
            seq: 2,
            type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }),
            status: 'PENDING',
          }
        ];
      } else if (region === 'A' && chargeRegion === 'B') {
        // A동에서 충전소(B동)에 있는 로봇을 호출: IC-B → WAIT_FREE_PATH → LM73 → WAIT_FREE_PATH → IC-A → WAIT_FREE_PATH → 호출한 버퍼의 PRE → 버퍼 → JACK_UP
        if (!icB || !lm73 || !icA) {
          console.error(`[우선순위호출] 필요한 스테이션을 찾을 수 없습니다: IC-B=${!!icB}, LM73=${!!lm73}, IC-A=${!!icA}`);
          return null;
        }
        
        taskSteps = [
          {
            seq: 0,
            type: 'NAV',
            payload: JSON.stringify({ dest: icB.id }),
            status: 'PENDING',
          },
          {
            seq: 1,
            type: 'WAIT_FREE_PATH',
            payload: JSON.stringify({}),
            status: 'PENDING',
          },
          {
            seq: 2,
            type: 'NAV',
            payload: JSON.stringify({ dest: lm73.id }),
            status: 'PENDING',
          },
          {
            seq: 3,
            type: 'WAIT_FREE_PATH',
            payload: JSON.stringify({}),
            status: 'PENDING',
          },
          {
            seq: 4,
            type: 'NAV',
            payload: JSON.stringify({ dest: icA.id }),
            status: 'PENDING',
          },
          {
            seq: 5,
            type: 'WAIT_FREE_PATH',
            payload: JSON.stringify({}),
            status: 'PENDING',
          },
          {
            seq: 6,
            type: 'NAV',
            payload: JSON.stringify({ dest: targetBufferPreSt.id }),
            status: 'PENDING',
          },
          {
            seq: 7,
            type: 'NAV',
            payload: JSON.stringify({ dest: targetSt.id }),
            status: 'PENDING',
          },
          {
            seq: 8,
            type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }),
            status: 'PENDING',
          }
        ];
      } else {
        // A동에서 A동 충전소 또는 기타
        taskSteps = [
          {
            seq: 0,
            type: 'NAV',
            payload: JSON.stringify({ dest: targetBufferPreSt.id }),
            status: 'PENDING',
          },
          {
            seq: 1,
            type: 'NAV',
            payload: JSON.stringify({ dest: targetSt.id }),
            status: 'PENDING',
          },
          {
            seq: 2,
            type: 'JACK_UP',
            payload: JSON.stringify({ height: 0.03 }),
            status: 'PENDING',
          }
        ];
      }
      
      const task = await Task.create(
        {
          robot_id: selectedRobot.id,
          steps: taskSteps,
        },
        { include: [{ model: TaskStep, as: 'steps' }] },
      );
      
      await log('PRIORITY_CALL', `우선순위2-충전소: ${selectedRobot.name} (${bestChargeRobot.batteryLevel}%) → ${bufferName}`, { robot_name: selectedRobot.name });
      
      try {
        await logTaskAssigned(task.id, selectedRobot.id, selectedRobot.name, bestChargeRobot.chargeStation.name, bufferName);
      } catch (error) {
        console.error('[TASK_LOG] 우선순위2 태스크 할당 로그 기록 오류:', error.message);
      }
      
      return { robot: selectedRobot, source: bestChargeRobot.chargeStation.name, task: task };
    }
  }
  
  // 우선순위 3: 다른 지역의 버퍼에 있는 AMR (A동 버퍼에서 B동 버퍼 호출만 처리)
  console.log(`[우선순위호출] 우선순위 3 시작: 호출 지역=${region}`);
  if (region === 'A') {
    console.log(`[우선순위호출] 우선순위 3: B 지역 버퍼에서 AMR 찾기`);
    
    const otherRegionBuffers = stations.filter(s => 
      regionOf(s) === 'B' && 
      hasClass(s, '버퍼') && 
      s.name.match(/^B[1-3]$/)
    );
    
    for (const bufferSt of otherRegionBuffers) {
      const robotAtBuffer = robots.find(r => String(r.location) === String(bufferSt.id));
      
      if (robotAtBuffer) {
        // 기존 태스크 상태 확인
        const hasTask = await checkRobotTaskStatus(robotAtBuffer);
        
        if (hasTask) {
          // 목적지 중복 체크
          if (await checkDestinationConflict(targetSt.id, robotAtBuffer.id)) {
            console.log(`[우선순위호출] 우선순위 3 성공: A지역 ${bufferSt.name}의 로봇 ${robotAtBuffer.name} 선택`);
            
            // 소스 버퍼의 PRE 스테이션 찾기
            const sourceBufferPreSt = stations.find(s => s.name === `${bufferSt.name}_PRE`);
            
            if (!sourceBufferPreSt) {
              console.error(`[우선순위호출] ${bufferSt.name}_PRE 스테이션을 찾을 수 없습니다.`);
              continue;
            }
            
            // 1번 시퀀스: JACK_DOWN → 소스버퍼_PRE → 타겟버퍼_PRE → 타겟버퍼 → JACK_UP
            const task = await Task.create(
              {
                robot_id: robotAtBuffer.id,
                steps: [
                  {
                    seq: 0,
                    type: 'JACK_DOWN',
                    payload: JSON.stringify({ height: 0.0 }),
                    status: 'PENDING',
                  },
                  {
                    seq: 1,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: sourceBufferPreSt.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 2,
                    type: 'JACK_DOWN',
                    payload: JSON.stringify({ height: 0.0 }),
                    status: 'PENDING',
                  },
                  {
                    seq: 3,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: icB.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 4,
                    type: 'WAIT_FREE_PATH',
                    payload: JSON.stringify({}),
                    status: 'PENDING',
                  },
                  {
                    seq: 5,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: lm73.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 6,
                    type: 'WAIT_FREE_PATH',
                    payload: JSON.stringify({}),
                    status: 'PENDING',
                  },
                  {
                    seq: 7,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: icA.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 8,
                    type: 'WAIT_FREE_PATH',
                    payload: JSON.stringify({}),
                    status: 'PENDING',
                  },
                  {
                    seq: 9,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: targetBufferPreSt.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 10,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: targetSt.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 11,
                    type: 'JACK_UP',
                    payload: JSON.stringify({ height: 0.03 }),
                    status: 'PENDING',
                  }
                ],
              },
              { include: [{ model: TaskStep, as: 'steps' }] },
            );
            
            await log('PRIORITY_CALL', `우선순위3-지역간: ${robotAtBuffer.name} A지역 ${bufferSt.name} → B지역 ${bufferName}`, { robot_name: robotAtBuffer.name });
            
            try {
              await logTaskAssigned(task.id, robotAtBuffer.id, robotAtBuffer.name, bufferSt.name, bufferName);
            } catch (error) {
              console.error('[TASK_LOG] 우선순위3 태스크 할당 로그 기록 오류:', error.message);
            }
            return { robot: robotAtBuffer, source: bufferSt.name, task: task };
          }
        }
      }
    }
  }
  
  console.log(`[우선순위호출] 모든 우선순위에서 호출 가능한 AMR을 찾지 못했습니다.`);
  return null;
}

/* ─────────────── 정시 충전 스케줄러 ─────────────────────────── */

// 정시 충전 스케줄러 초기화
function initScheduledCharging() {
  console.log('[정시충전] 스케줄러 시작: 11:40, 16:50');
  
  // 매일 11:40에 실행
  cron.schedule('0 40 11 * * *', async () => {
    console.log('\n=== 11:40 정시 충전 시작 ===');
    await executeScheduledCharging('morning');
  });

  // 매일 16:50에 실행  
  cron.schedule('0 50 16 * * *', async () => {
    console.log('\n=== 16:50 정시 충전 시작 ===');
    await executeScheduledCharging('afternoon');
  });
}

// 정시 충전 실행 함수
async function executeScheduledCharging(timeSlot) {
  try {
    console.log(`[정시충전] ${timeSlot} 시간대 충전 작업 시작`);
    
    // 1. 현재 맵과 스테이션 정보 로드
    const map = await MapDB.findOne({ where: { is_current: true } });
    if (!map) {
      console.error('[정시충전] 맵 정보를 찾을 수 없습니다.');
      return;
    }
    
    const stations = (JSON.parse(map.stations || '{}').stations) || [];
    const robots = await Robot.findAll();
    
    // 2. 버퍼에 있는 AMR들 찾기
    const bufferAmrs = await findAmrsInBuffers(stations, robots);
    
    if (bufferAmrs.length === 0) {
      console.log(`[정시충전] 버퍼에 태스크 없는 AMR이 없습니다.`);
      return;
    }
    
    console.log(`[정시충전] 버퍼 AMR 발견: ${bufferAmrs.map(a => `${a.robot.name}(${a.location})`).join(', ')}`);
    
    // 3. 빈 충전소 확인
    const availableChargeStations = findAvailableChargeStations(stations, robots);
    
    if (availableChargeStations.length === 0) {
      console.log(`[정시충전] 사용 가능한 충전소가 없습니다.`);
      return;
    }
    
    console.log(`[정시충전] 사용 가능한 충전소: ${availableChargeStations.map(cs => cs.name).join(', ')}`);
    
    // 4. 충전 태스크 생성
    await createScheduledChargingTasks(bufferAmrs, availableChargeStations, stations, timeSlot);
    
    console.log(`[정시충전] ${timeSlot} 시간대 충전 작업 완료\n`);
    
  } catch (error) {
    console.error(`[정시충전] ${timeSlot} 시간대 오류:`, error.message);
  }
}

// 버퍼에 있는 태스크 없는 AMR들 찾기
async function findAmrsInBuffers(stations, robots) {
  const bufferAmrs = [];
  
  // A동, B동 버퍼 스테이션들 찾기
  const bufferStations = stations.filter(s => 
    (regionOf(s) === 'A' || regionOf(s) === 'B') && 
    hasClass(s, '버퍼') && 
    s.name.match(/^[AB][1-3]$/) // A1-A3, B1-B3 형태
  );
  
  for (const bufferStation of bufferStations) {
    const robotAtBuffer = robots.find(r => String(r.location) === String(bufferStation.id));
    
    if (robotAtBuffer) {
      // 현재 실행 중인 태스크가 있는지 확인
      const hasTask = await checkRobotTaskStatus(robotAtBuffer);
      
      if (hasTask) {
        bufferAmrs.push({
          robot: robotAtBuffer,
          location: bufferStation.name,
          region: regionOf(bufferStation)
        });
        console.log(`[정시충전] 대상 AMR: ${robotAtBuffer.name} at ${bufferStation.name} (태스크 없음)`);
      } else {
        console.log(`[정시충전] 제외 AMR: ${robotAtBuffer.name} at ${bufferStation.name} (태스크 실행 중)`);
      }
    }
  }
  
  return bufferAmrs;
}

// 사용 가능한 충전소들 찾기
function findAvailableChargeStations(stations, robots) {
  const chargeStations = stations.filter(s => hasClass(s, '충전'));
  
  return chargeStations.filter(cs => {
    // 충전소에 로봇이 없는지 확인
    const robotAtCharge = robots.find(r => String(r.location) === String(cs.id));
    return !robotAtCharge;
  });
}

// 정시 충전 태스크들 생성 (순차 실행으로 수정)
async function createScheduledChargingTasks(bufferAmrs, availableChargeStations, stations, timeSlot) {
  const icA = stations.find(s => regionOf(s) === 'A' && hasClass(s, 'IC'));
  const icB = stations.find(s => regionOf(s) === 'B' && hasClass(s, 'IC'));
  const lm78 = stations.find(s => String(s.id) === '78' || s.name === 'LM78');
  
  if (bufferAmrs.length === 0) {
    console.log(`[정시충전] 충전할 AMR이 없습니다.`);
    return;
  }

  console.log(`[정시충전] 총 ${bufferAmrs.length}대의 AMR을 순차적으로 충전소로 보냅니다 (1분 간격)`);
  
  // 첫 번째 AMR은 즉시 실행
  await createSingleChargingTask(bufferAmrs[0], availableChargeStations[0], stations, timeSlot, icA, icB, lm78, 0);

  // 나머지 AMR들은 1분 간격으로 순차 실행
  for (let i = 1; i < bufferAmrs.length && i < availableChargeStations.length; i++) {
    const delayMinutes = i * 1; // 1분씩 간격
    const delayMs = delayMinutes * 60 * 1000;
    
    console.log(`[정시충전] ${bufferAmrs[i].robot.name}: ${delayMinutes}분 후 충전 태스크 예약됨`);
    
    setTimeout(async () => {
      try {
        // 태스크 생성 시점에 로봇 상태를 다시 확인
        const robot = await Robot.findByPk(bufferAmrs[i].robot.id);
        if (!robot) {
          console.log(`[정시충전-지연] ${bufferAmrs[i].robot.name}: 로봇을 찾을 수 없음`);
          return;
        }

        // 현재도 태스크가 없는지 다시 확인
        const hasTask = await checkRobotTaskStatus(robot);
        if (!hasTask) {
          console.log(`[정시충전-지연] ${robot.name}: 태스크가 생성되어 충전 건너뜀`);
          return;
        }

        // 충전소가 여전히 비어있는지 확인
        const targetChargeStation = availableChargeStations[i];
        const currentRobots = await Robot.findAll();
        const robotAtCharge = currentRobots.find(r => String(r.location) === String(targetChargeStation.id));
        
        if (robotAtCharge) {
          console.log(`[정시충전-지연] ${robot.name}: 충전소 ${targetChargeStation.name}이 이미 사용 중`);
          // 다른 빈 충전소 찾기
          const allChargeStations = stations.filter(s => hasClass(s, '충전'));
          const emptyChargeStation = allChargeStations.find(cs => 
            !currentRobots.some(r => String(r.location) === String(cs.id))
          );
          
          if (!emptyChargeStation) {
            console.log(`[정시충전-지연] ${robot.name}: 사용 가능한 충전소가 없어 건너뜀`);
            return;
          }
          
          console.log(`[정시충전-지연] ${robot.name}: 대체 충전소 ${emptyChargeStation.name} 사용`);
          await createSingleChargingTask(
            { robot, location: bufferAmrs[i].location, region: bufferAmrs[i].region }, 
            emptyChargeStation, 
            stations, 
            timeSlot, 
            icA, 
            icB, 
            lm78, 
            i
          );
        } else {
          await createSingleChargingTask(bufferAmrs[i], targetChargeStation, stations, timeSlot, icA, icB, lm78, i);
        }
        
      } catch (error) {
        console.error(`[정시충전-지연] ${bufferAmrs[i].robot.name} 오류:`, error.message);
      }
    }, delayMs);
  }
  
  // 사용 가능한 충전소보다 AMR이 많은 경우 경고
  if (bufferAmrs.length > availableChargeStations.length) {
    console.log(`[정시충전] 경고: AMR ${bufferAmrs.length}대 > 충전소 ${availableChargeStations.length}개, 일부 AMR은 충전소 대기`);
  }
}

// 단일 AMR 충전 태스크 생성 함수
async function createSingleChargingTask(amrInfo, targetChargeStation, stations, timeSlot, icA, icB, lm78, index) {
  const { robot, location, region } = amrInfo;
  
  // 충전소 PRE 스테이션 찾기
  const chargePreStation = stations.find(s => s.name === `${targetChargeStation.name}_PRE`);
  
  if (!chargePreStation) {
    console.log(`[정시충전] ${robot.name}: ${targetChargeStation.name}_PRE 스테이션을 찾을 수 없음`);
    return;
  }
  
  try {
    let taskSteps = [];
    
    if (region === 'A') {
      // A동 버퍼 AMR: JACK_DOWN → IC-A → WAIT_FREE_PATH → LM78 → IC-B → 충전소PRE → 충전소
      if (!icA || !icB || !lm78) {
        console.error(`[정시충전] ${robot.name}: A→B 이동에 필요한 스테이션 부족 (IC-A=${!!icA}, IC-B=${!!icB}, LM78=${!!lm78})`);
        return;
      }
      
      taskSteps = [
        {
          seq: 0,
          type: 'JACK_DOWN',
          payload: JSON.stringify({ height: 0.0 }),
          status: 'PENDING',
        },
        {
          seq: 1,
          type: 'NAV',
          payload: JSON.stringify({ dest: icA.id }),
          status: 'PENDING',
        },
        {
          seq: 2,
          type: 'WAIT_FREE_PATH',
          payload: JSON.stringify({}),
          status: 'PENDING',
        },
        {
          seq: 3,
          type: 'NAV',
          payload: JSON.stringify({ dest: lm78.id }),
          status: 'PENDING',
        },
        {
          seq: 4,
          type: 'NAV',
          payload: JSON.stringify({ dest: icB.id }),
          status: 'PENDING',
        },
        {
          seq: 5,
          type: 'NAV',
          payload: JSON.stringify({ dest: chargePreStation.id }),
          status: 'PENDING',
        },
        {
          seq: 6,
          type: 'NAV',
          payload: JSON.stringify({ dest: targetChargeStation.id }),
          status: 'PENDING',
        }
      ];
    } else if (region === 'B') {
      // B동 버퍼 AMR: JACK_DOWN → 충전소PRE → 충전소
      taskSteps = [
        {
          seq: 0,
          type: 'JACK_DOWN',
          payload: JSON.stringify({ height: 0.0 }),
          status: 'PENDING',
        },
        {
          seq: 1,
          type: 'NAV',
          payload: JSON.stringify({ dest: chargePreStation.id }),
          status: 'PENDING',
        },
        {
          seq: 2,
          type: 'NAV',
          payload: JSON.stringify({ dest: targetChargeStation.id }),
          status: 'PENDING',
        }
      ];
    }
    
    // 태스크 생성
    const task = await Task.create(
      {
        robot_id: robot.id,
        steps: taskSteps,
      },
      { include: [{ model: TaskStep, as: 'steps' }] },
    );
    
    const executionTime = index === 0 ? '즉시' : `${index * 1}분 후`;
    console.log(`[정시충전] ${robot.name} (${location}) → ${targetChargeStation.name} 태스크 생성 완료 (${executionTime}, 태스크 ID: ${task.id})`);
    await log('SCHEDULED_CHARGE', `정시 충전 ${timeSlot} (${executionTime}): ${robot.name} (${location}) → ${targetChargeStation.name}`, { robot_name: robot.name });
    
    // 태스크 할당 로그 기록
    try {
      await logTaskAssigned(task.id, robot.id, robot.name, location, targetChargeStation.name);
    } catch (error) {
      console.error('[TASK_LOG] 정시 충전 태스크 할당 로그 기록 오류:', error.message);
    }
    
  } catch (error) {
    console.error(`[정시충전] ${robot.name} 태스크 생성 오류:`, error.message);
  }
}

// 정시 충전 스케줄러 시작 (서버 부트 시 호출)
initScheduledCharging();
