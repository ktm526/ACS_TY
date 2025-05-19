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
const DOOR_IPS = { A: ['192.168.0.7', '192.168.0.8'], B: ['192.168.0.9', '192.168.0.10'] };
const DOOR_COOLDOWN = 2000;
const doorState = new Map();   // id→{open,ts}

// ──────────── ALARM (slot_0/ch_3) ─────────────
const ALARM_IP = '192.168.0.10';
const ALARM_SLOT = 0;
const ALARM_CH = 3;
const ALARM_STATE = { open: null, timestamp: 0 };

const lastRioSignal = new Map();

/* ────────────────────────────── 2. 공통 헬퍼 ──────────────────────── */
const delay = ms => new Promise(r => setTimeout(r, ms));
const log = async (t, m, meta = {}) => { try { await Log.create({ type: t, message: m, ...meta }); } catch (e) { console.error('[Log]', e.message); } };

const getCls = s => Array.isArray(s.class) ? s.class
  : Array.isArray(s.classList) ? s.classList
    : s.class ? (Array.isArray(s.class) ? s.class : [s.class]) : [];
const hasClass = (s, c) => getCls(s).includes(c);
const regionOf = s => hasClass(s, 'A') ? 'A' : hasClass(s, 'B') ? 'B' : null;


// ───────────────────── 3. Door 컨트롤 ───────────────────────
async function setDoor(slot, ch, open, region /* 'A'|'B' */) {
  const now = Date.now();
  const payload = {
    Ch: ch, Md: 0, Stat: open ? 1 : 0, Val: open ? 1 : 0,
    PsCtn: 0, PsStop: 0, PsIV: 0,
  };
  const authHeader = 'Basic ' + Buffer.from('root:12345678').toString('base64');

  for (const ip of DOOR_IPS[region]) {
    try {
      await axios.put(
        `http://${ip}/do_value/slot_${slot}/ch_${ch}`,
        payload,
        { headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, timeout: 2000 }
      );
      // IP를 key로, open 상태와 타임스탬프 저장
      doorState.set(ip, { open, timestamp: now });
    } catch (e) {
      console.error(`[setDoor] ${ip} 오류:`, e.message);
      // 실패해도 timestamp만 갱신(끊김 표시용)
      doorState.set(ip, { open: false, timestamp: now });
    }
  }
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
exports.sendGotoNav = sendGotoNav;

/* ─────────────── 5. RIO 연결 & 폴링 (edge 감지용) ────────────────── */

(async () => {
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
        const readPromise = dev.client.readHoldingRegisters(0, 16);
        const { data } = await Promise.race([
          readPromise,
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('RIO read timeout')), RIO_READ_TIMEOUT)
          )
        ]);
        lastRioSignal.set(ip, Date.now());

        dev.lastRegs = data;
        console.log(DataTypes)
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

const clearRio = async (dev, idx) => { try { await dev.client.writeRegister(+idx, 0); } catch { } };

/* ─────────────── 6. Route→Task 변환 (예시 로직만) ────────────────── */
async function buildTaskFromRioEdge(route, robot, stations) {
  console.log("building task from rio edge")
  const findByName = n => stations.find(s => s.name === n);
  const icA = stations.find(s => regionOf(s) === 'A' && hasClass(s, 'IC'));
  const icB = stations.find(s => regionOf(s) === 'B' && hasClass(s, 'IC'));
  const lm73 = stations.find(s => String(s.id) === '73' || s.name === 'LM73');
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
      { type: 'NAV', payload: { dest: icB?.id } },
      { type: 'WAIT_FREE_PATH' },
      { type: 'NAV_OR_BUFFER', payload: { primary: 'B4' } },
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
  } else {
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
async function handleRioEdge(ip, idx, route) {
  console.log('function handlerioedge')
  const map = await MapDB.findOne({ where: { is_current: true } }); if (!map) return;
  const stations = (JSON.parse(map.stations || '{}').stations) || [];
  const fromSt = stations.find(s => s.name === route.from); if (!fromSt) return;
  const tgtSt = stations.find(s => s.name === (route.to ?? ''));
  //console.log("values:",map, stations, fromSt, tgtSt)
  const robot = await Robot.findOne({ where: { location: fromSt.id } });
  if (!robot) {
    console.log("no robot in station")
    return
  } else {
    console.log("robot in station")
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
  console.log('handleriodedge: building task')
  const task = await buildTaskFromRioEdge(route, robot, stations);
  if (task) {
    console.log("task_create", `RIO ${ip} reg${idx} -> task#${task.id}`)
    await log('TASK_CREATE', `RIO ${ip} reg${idx} -> task#${task.id}`, { robot_name: robot.name });
  }
}

/* ─────────────── 8. 메인 워커 (1 Hz) ─────────────────────────────── */
let busy = false;
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
      const doorA = stations.some(s => hasClass(s, 'door') && regionOf(s) === 'A' && robots.find(r => r.location == s.id));
      const doorB = stations.some(s => hasClass(s, 'door') && regionOf(s) === 'B' && robots.find(r => r.location == s.id));
      console.log('doorA:', doorA, 'doorB:', doorB)
      await setDoor(0, 0, doorA, 'A', 'doorA');
      await setDoor(0, 0, doorB, 'B', 'doorB');
      // ■ ALRAM 있으면 켜고, 없으면 꺼기
      const alarmActive = stations.some(s => hasClass(s, 'ALARM') && robots.find(r => r.location == s.id));
      console.log('alarm', alarmActive)
      await setAlarm(alarmActive);
    }

    // Task 실행기
    taskExecutor.tick().catch(console.error);
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

// ■ ALRAM 있으면 켜고, 없으면 꺼기

/* ─────────────── 10. export (테스트용) ─────────────────────────── */
exports.workerTick = workerTick;
exports.pollAllRios = pollAllRios;
exports.lastRioSignal = lastRioSignal;
exports.RIOS = RIOS;
exports.doorState = doorState;
exports.ALARM_STATE = ALARM_STATE;
exports.DOOR_IPS = DOOR_IPS;
