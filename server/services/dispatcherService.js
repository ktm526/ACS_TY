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

const { logConnChange } = require('./connectionLogger');
const MapDB = require('../models/Map');
const Robot = require('../models/Robot');
const Log = require('../models/Log');
const { Task, TaskStep } = require('../models');   // ← models/index.js

const taskExecutor = require('./taskExecutorService');   // tick() 호출용
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

// 17번 레지스터에 값을 설정하는 함수
const setRioRegister17 = async (ip, value) => {
  try {
    const dev = RIOS[ip];
    if (!dev || !dev.connected) {
      throw new Error(`RIO ${ip} is not connected`);
    }
    await dev.client.writeRegister(7, value ? 1 : 0);

    //await dev.client.writeRegister(15, value ? 1 : 0);

    //await dev.client.writeRegister(17, value ? 1 : 0);

    //await dev.client.writeRegister(16, value ? 1 : 0);
    console.log(`[RIO_REG17] ${ip}: 레지스터 17번을 ${value ? 1 : 0}으로 설정 완료`);
    return true;
  } catch (error) {
    console.error(`[RIO_REG17] ${ip}: 레지스터 17번 설정 오류 - ${error.message}`);
    throw error;
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
  );
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

async function handleRioEdge(ip, idx, route) {
  console.log('function handlerioedge')
  const map = await MapDB.findOne({ where: { is_current: true } });
  if (!map) return;
  const stations = (JSON.parse(map.stations || '{}').stations) || [];
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
    
    // 지역 확인
    const region = route.from.charAt(0); // 'A' 또는 'B'
    const bufferNum = route.from.charAt(1); // '1', '2', '3'
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
        
        // AMR이 없고 레지스터 값이 1인 경우: 충전 스테이션에서 AMR 호출
        console.log(`[버퍼신호] ${bufferName}에 로봇이 없고 레지스터 값이 1입니다. 충전 스테이션에서 AMR 호출 시도...`);
        
        // 충전 스테이션에 있는 로봇 찾기
        const chargeStations = stations.filter(s => 
          regionOf(s) === region && 
          hasClass(s, '충전')
        );
        
        if (chargeStations.length === 0) {
          console.log(`[버퍼신호] ${region} 지역에 충전 스테이션이 없습니다. 입력을 무시합니다.`);
          return;
        }
        
        // 충전 스테이션에 있는 로봇들 확인
        const robots = await Robot.findAll();
        const robotsAtChargeStations = [];
        
        for (const chargeSt of chargeStations) {
          const robot = robots.find(r => String(r.location) === String(chargeSt.id));
          if (robot) {
            const batteryLevel = robot.battery || 0;
            console.log(`[버퍼신호] 충전 스테이션 ${chargeSt.name}의 로봇 ${robot.name}: 배터리 ${batteryLevel}%`);
            robotsAtChargeStations.push({ robot, batteryLevel, chargeStation: chargeSt });
          }
        }
        
        if (robotsAtChargeStations.length === 0) {
          console.log(`[버퍼신호] ${region} 지역 충전 스테이션에 로봇이 없습니다. 입력을 무시합니다.`);
          return;
        }
        
        // 배터리가 가장 높은 로봇 선택
        const bestRobot = robotsAtChargeStations.reduce((highest, current) => {
          return current.batteryLevel > highest.batteryLevel ? current : highest;
        });
        
        // 배터리가 40% 이하면 호출하지 않음
        if (bestRobot.batteryLevel <= 40) {
          console.log(`[버퍼신호] 가장 높은 배터리 로봇(${bestRobot.robot.name})의 배터리가 ${bestRobot.batteryLevel}%로 40% 이하입니다. 호출하지 않습니다.`);
          return;
        }
        
        console.log(`[버퍼신호] 선택된 로봇: ${bestRobot.robot.name} (배터리: ${bestRobot.batteryLevel}%)`);
        
        // 기존 태스크 상태 확인
        if (!(await checkRobotTaskStatus(bestRobot.robot))) {
          console.log(`[버퍼신호] 로봇 ${bestRobot.robot.name}에 이미 실행 중인 태스크가 있어 호출을 건너뜁니다.`);
          return;
        }
        
        // 버퍼 PRE 스테이션 찾기
        const bufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
        
        if (!bufferPreSt) {
          console.error(`[버퍼신호] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
          return;
        }
        
        // 태스크 생성 (충전소 → 버퍼_PRE → 버퍼)
        const task = await Task.create(
          {
            robot_id: bestRobot.robot.id,
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
                payload: JSON.stringify({ dest: fromSt.id }),
                status: 'PENDING',
              }
            ],
          },
          { include: [{ model: TaskStep, as: 'steps' }] },
        );
        
        console.log(`[버퍼신호] 충전소에서 로봇(${bestRobot.robot.name})을 ${bufferName}으로 호출하는 태스크 생성 완료 (태스크 ID: ${task.id})`);
        await log('BUTTON_TASK', `충전소 호출: ${bestRobot.robot.name} → ${bufferName}`, { robot_name: bestRobot.robot.name });
        
        return; // 충전소에서 로봇을 호출했으므로 여기서 처리 종료
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
              return;
            }
            
            // 버퍼 PRE 스테이션 찾기
            const bufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
            
            if (!bufferPreSt) {
              console.error(`[버퍼신호] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
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
              
              return; // 메인 위치에서 로봇을 호출했으므로 여기서 처리 종료
            }
          } else {
            console.log(`[버퍼신호] 우선순위 1: ${mainPoint}에 호출할 로봇이 없습니다.`);
          }
        }
        
        // 우선순위 2: 다른 버퍼에 있는 AMR 호출 (화물 이송)
        console.log(`[버퍼신호] 우선순위 2: 다른 버퍼에서 AMR 호출 시도...`);
        
        // 같은 지역의 다른 버퍼들 확인 (A1,A2,A3 또는 B1,B2,B3)
        const otherBufferNumbers = [1, 2, 3].filter(num => num !== parseInt(bufferNum));
        let sourceRobot = null;
        let sourceBufferSt = null;
        let sourceBufferPreSt = null;
        
        for (const otherBufferNum of otherBufferNumbers) {
          const otherBufferName = `${region}${otherBufferNum}`;
          const otherBufferSt = stations.find(s => s.name === otherBufferName);
          
          if (!otherBufferSt) {
            console.log(`[버퍼신호] ${otherBufferName} 스테이션을 찾을 수 없습니다.`);
            continue;
          }
          
          // 해당 버퍼에 로봇이 있는지 확인
          const robotAtOtherBuffer = await Robot.findOne({ where: { location: otherBufferSt.id } });
          
          if (robotAtOtherBuffer) {
            console.log(`[버퍼신호] ${otherBufferName}에서 로봇(${robotAtOtherBuffer.name})을 찾았습니다.`);
            
            // 기존 태스크 상태 확인
            if (!(await checkRobotTaskStatus(robotAtOtherBuffer))) {
              console.log(`[버퍼신호] 로봇 ${robotAtOtherBuffer.name}에 이미 실행 중인 태스크가 있어 다음 버퍼를 확인합니다.`);
              continue;
            }
            
            // 소스 버퍼의 PRE 스테이션 찾기
            const otherBufferPreSt = stations.find(s => s.name === `${otherBufferName}_PRE`);
            
            if (!otherBufferPreSt) {
              console.error(`[버퍼신호] ${otherBufferName}_PRE 스테이션을 찾을 수 없습니다.`);
              continue;
            }
            
            sourceRobot = robotAtOtherBuffer;
            sourceBufferSt = otherBufferSt;
            sourceBufferPreSt = otherBufferPreSt;
            break; // 첫 번째로 찾은 로봇 사용
          } else {
            console.log(`[버퍼신호] ${otherBufferName}에 로봇이 없습니다.`);
          }
        }
        
        if (sourceRobot && sourceBufferSt && sourceBufferPreSt) {
          console.log(`[버퍼신호] 우선순위 2: ${sourceBufferSt.name}에서 로봇(${sourceRobot.name})을 ${bufferName}으로 이송합니다.`);
          
          // 목적지 버퍼 PRE 스테이션 찾기
          const targetBufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
          
          if (!targetBufferPreSt) {
            console.error(`[버퍼신호] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
          } else {
            // 태스크 생성 (JACK_UP → 소스 PRE → JACK_DOWN → 목적지 PRE → JACK_UP → 목적지 버퍼)
            const task = await Task.create(
              {
                robot_id: sourceRobot.id,
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
                    payload: JSON.stringify({ dest: targetBufferPreSt.id }),
                    status: 'PENDING',
                  },
                  {
                    seq: 4,
                    type: 'JACK_UP',
                    payload: JSON.stringify({ height: 0.03 }),
                    status: 'PENDING',
                  },
                  {
                    seq: 5,
                    type: 'NAV',
                    payload: JSON.stringify({ dest: fromSt.id }),
                    status: 'PENDING',
                  },
                ],
              },
              { include: [{ model: TaskStep, as: 'steps' }] },
            );
            
            console.log(`[버퍼신호] 로봇(${sourceRobot.name})을 ${sourceBufferSt.name}에서 ${bufferName}으로 이송하는 태스크 생성 완료 (태스크 ID: ${task.id})`);
            await log('BUTTON_TASK', `버퍼 이송: ${sourceRobot.name} ${sourceBufferSt.name} → ${bufferName}`, { robot_name: sourceRobot.name });
            
            return; // 다른 버퍼에서 로봇을 호출했으므로 여기서 처리 종료
          }
        } else {
          console.log(`[버퍼신호] 우선순위 2: 다른 버퍼에도 호출할 수 있는 로봇이 없습니다.`);
        }
        
        // 우선순위 3: 모든 버퍼가 비어있으면 입력 무시
        console.log(`[버퍼신호] 우선순위 3: ${region} 지역에 호출할 수 있는 AMR이 없습니다. 입력을 무시합니다.`);
        return; // 입력 무시
      }
      
      return; // 여기서 처리 종료
    }
    
    // 레지스터 값과 DB 상태가 불일치하는지 확인 (주의 로그만 출력)
    if (!bufferStatus[bufferNum]) {
      console.log(`[버퍼신호] 주의: 레지스터 값은 ${bufferName}이 비어있다고 표시하지만, DB에는 로봇(${robotAtBuffer.name})이 있습니다.`);
    }
    
    // 여기서부터는 기존 로직 계속 진행 (해당 버퍼에 AMR이 있는 경우)
    console.log(`[버퍼신호] ${bufferName}에 로봇(${robotAtBuffer.name})이 있습니다. 기존 로직으로 처리...`);
  }

  // 기존 로직에서는 이미 fromSt를 기준으로 robot을 조회했기 때문에,
  // 위에서 robotAtBuffer가 없는 경우는 이미 return되었으므로 
  // 아래 robot 변수는 항상 존재할 것입니다.
  const robot = await Robot.findOne({ where: { location: fromSt.id } });
  if (!robot) {
    console.log("no robot in station")
    return
  } else {
    console.log("robot in station")
  }

  // 메인 태스크 생성 전 기존 태스크 상태 확인
  if (!(await checkRobotTaskStatus(robot))) {
    console.log(`[태스크중복방지] 로봇 ${robot.name}에 이미 실행 중인 태스크가 있어 새로운 태스크 생성을 건너뜁니다.`);
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
      return;                      // ★ 태스크 생성 안 함
    }
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
      return;  // 태스크 생성 안 함
    }
  }

  console.log('handleriodedge: building task')
  const task = await buildTaskFromRioEdge(route, robot, stations);
  if (task) {
    console.log("task_create", `RIO ${ip} reg${idx} -> task#${task.id}`)
    await log('TASK_CREATE', `RIO ${ip} reg${idx} -> task#${task.id}`, { robot_name: robot.name });
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
              amrErrorStartTime.set(robot.name, now);
            }
          } else {
            amrErrorStartTime.delete(robot.name);
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
          
        } catch (e) {
          // DI 정보 파싱 오류 시 무시 (너무 많은 로그 방지)
        }
      }
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

// 태스크 일시정지 조건 확인 함수
async function checkTaskPauseConditions(robot, now) {
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
    
    if (!runningTask) return; // 실행 중인 태스크가 없으면 체크 안함
    
    let shouldPause = false;
    let reason = '';
    
    // 1. 네트워크 연결 끊김 체크 (1분 이상)
    const lastNetworkTime = amrLastNetworkTime.get(robot.name);
    if (robot.status === '연결 안됨' || (lastNetworkTime && now - lastNetworkTime > TIMEOUT_MS)) {
      shouldPause = true;
      reason = '네트워크 연결 끊김 (1분 이상)';
    }
    
    // 2. 오류 상태 체크 (1분 이상)
    const errorStartTime = amrErrorStartTime.get(robot.name);
    if (errorStartTime && now - errorStartTime > TIMEOUT_MS) {
      shouldPause = true;
      reason = '오류 상태 지속 (1분 이상)';
    }
    
    // 3. NAV 스텝 중 위치 변화 없음 체크 (1분 이상) - workerTick에서 관리되는 타이머 확인
    if (runningTask.steps && runningTask.steps.length > 0) {
      const currentStep = runningTask.steps[0];
      if ((currentStep.type === 'NAV' || currentStep.type === 'NAV_PRE') && robot.status === '이동') {
        const stopStartTime = amrStopStartTime.get(robot.name);
        if (stopStartTime && now - stopStartTime > TIMEOUT_MS) {
          shouldPause = true;
          reason = 'NAV 중 위치 변화 없음 (1분 이상)';
          console.log(`[PAUSE_CHECK] ${robot.name}: NAV 중 위치 변화 없음 지속 감지 - 시작 시간: ${new Date(stopStartTime).toLocaleTimeString()}, 지속 시간: ${Math.round((now - stopStartTime) / 1000)}초, 현재 스텝: ${currentStep.type}`);
        }
      }
    }
    
    // 태스크 일시정지 실행
    if (shouldPause) {
      console.log(`[TASK_PAUSE] ${robot.name}: ${reason} - 태스크 일시정지`);
      await runningTask.update({ status: 'PAUSED' });
      await log('TASK_PAUSE', `${robot.name}: ${reason}`, { robot_name: robot.name });
      
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
    
    // 충전 스테이션에 있는 로봇들 중 배터리 40% 이상인 로봇들만 필터링
    const eligibleRobots = [];
    
    for (const chargeSt of chargeStations) {
      const robot = robots.find(r => String(r.location) === String(chargeSt.id));
      if (robot) {
        const batteryLevel = robot.battery || 0;
        console.log(`[버퍼버튼] 충전 스테이션 ${chargeSt.name}의 로봇 ${robot.name}: 배터리 ${batteryLevel}%`);
        
        if (batteryLevel >= 40) {
          eligibleRobots.push(robot);
        } else {
          console.log(`[버퍼버튼] 로봇 ${robot.name}의 배터리(${batteryLevel}%)가 40% 미만이므로 제외`);
        }
      }
    }
    
    if (eligibleRobots.length === 0) {
      console.log(`[버퍼버튼] ${region} 지역 충전 스테이션에 배터리 40% 이상인 로봇이 없습니다.`);
      return;
    }
    
    // 배터리가 가장 높은 로봇 선택
    const amrAtCharger = eligibleRobots.reduce((highest, current) => {
      return (current.battery || 0) > (highest.battery || 0) ? current : highest;
    });
    
    const batteryLevel = amrAtCharger.battery || 0;
    console.log(`[버퍼버튼] 선택된 로봇: ${amrAtCharger.name} (배터리: ${batteryLevel}%)`);
    console.log(`[버퍼버튼] ${bufferName}로 로봇(${amrAtCharger.name}, 배터리:${batteryLevel}%) 호출 시작`);
    
    // 기존 태스크 상태 확인
    if (!(await checkRobotTaskStatus(amrAtCharger))) {
      console.log(`[버퍼버튼] 로봇 ${amrAtCharger.name}에 이미 실행 중인 태스크가 있어 호출을 건너뜁니다.`);
      return;
    }
    
    // 5. 버퍼 PRE 스테이션 찾기
    const bufferPreSt = stations.find(s => s.name === `${bufferName}_PRE`);
    
    if (!bufferPreSt) {
      console.error(`[버퍼버튼] ${bufferName}_PRE 스테이션을 찾을 수 없습니다.`);
      return;
    }
    
    // 6. 테스크 생성 (버퍼_PRE로 이동 -> 버퍼로 이동)
    const task = await Task.create(
      {
        robot_id: amrAtCharger.id,
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
    
    console.log(`[버퍼버튼] ${amrAtCharger.name}을(를) ${bufferName}으로 호출하는 태스크 생성 완료 (태스크 ID: ${task.id})`);
    await log('BUTTON_TASK', `버퍼 이송: ${amrAtCharger.name} → ${bufferName}`, { robot_name: amrAtCharger.name });
    
    return task;
  } catch (error) {
    console.error(`[버퍼버튼] 오류 발생:`, error);
    throw error;
  }
}

exports.sendGotoNav = sendGotoNav;
exports.setRioRegister17 = setRioRegister17;
