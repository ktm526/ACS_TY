// dispatcherService.js  (2025-05-01)
const net = require('net');
const axios = require('axios');
const MapDB = require('../models/Map');
const Robot = require('../models/Robot');
const Log = require('../models/Log');
const ModbusRTU = require('modbus-serial');
const  {sendJackCommand } = require('../services/robotJackService');
const  {CODES } = require('../controllers/jackController');
const LIFT_UP   = 0.03;   // 3 cm
const LIFT_DOWN = 0.0;
/* ★ 파일 맨 위에 전역 Map             id → { lastCmd:'up'|'down', ts } */
const jackMemo = new Map();   // 전송-중 플래그 + 시간 기록
const JACK_COOLDOWN = 4000;   // 같은 명령을 4 s 안에 재발사 금지

/* ═══════════════════════════════════════════════════════════════════════
   0-B.  RIOs (Modbus-TCP) 설정
   - register-index → { from, to } 형태로 정의해 두면
     나중에 다른 비트(레지스터)만 추가해서 경로를 확장할 수 있음
   ═════════════════════════════════════════════════════════════════════ */
const RIOS = {
  '192.168.0.5': {                              // B4 ➜ A4
    client: new ModbusRTU(),
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

/* ── 초기 연결 ────────────────────────────────────────────────────────── */
(async () => {
  for (const [ip, dev] of Object.entries(RIOS)) {
    try {
      await dev.client.connectTCP(ip, { port: RIO_PORT });
      dev.client.setID(RIO_UNIT_ID);
      dev.connected = true;
      console.log(`[RIO] ${ip} connected`);
      // dev.client._client.on('close', () => { dev.connected = false; });
      // dev.client._client.on('error', () => { dev.connected = false; });
      if (dev.client._port) {
        dev.client._port.on('close', () => { dev.connected = false; });
        dev.client._port.on('error', () => { dev.connected = false; });
      }

    } catch (e) {
      console.error(`[RIO] ${ip} connect error –`, e.message);
      dev.connected = false;
    }
  }
})();

/* ═════════════════════════════════════════════════════════════════════ */
/* 0-A. IO / Door 설정                                                       */
/* ═════════════════════════════════════════════════════════════════════ */
const IO_HOST = '10.29.176.171';
const IO_AUTH = { username: 'root', password: '00000000' };
/* ── 0-A. Door IP 설정 (A/B 분리) ─────────────────────────────── */
const DOOR_IPS = {
  A: ['192.168.0.7', '192.168.0.8'],   // A 쪽
  B: ['192.168.0.9', '192.168.0.10'],  // B 쪽
};
const DOOR_COOLDOWN = 3_000;
const doorState = new Map();                    // id → { open, timestamp }

/* ═════════════════════════════════════════════════════════════════════ */
/* 1. 글로벌 재시도 큐 (A↔B 교차 전용)                                          */
/* ═════════════════════════════════════════════════════════════════════ */
if (!global.pendingQ) global.pendingQ = new Map();
let _pq = global.pendingQ;
const pq = {
  set: (k, v) => (_pq instanceof Map ? _pq.set(k, v) : (_pq[k] = v)),
  del: k => (_pq instanceof Map ? _pq.delete(k) : delete _pq[k]),
  entries: () => (_pq instanceof Map ? Array.from(_pq) : Object.entries(_pq)),
  size: () => (_pq instanceof Map ? _pq.size : Object.keys(_pq).length),
};

/* ═════════════════════════════════════════════════════════════════════ */
/* 2. Log helper (연결 로그는 남기지 않고, 엣지-이벤트만 기록)                       */
/* ═════════════════════════════════════════════════════════════════════ */
async function log(type, message, meta = {}) {
  try {
    await Log.create({ type, message, ...meta });
  } catch (e) {
    console.error('[Log]', e.message);
  }
}

/* ═════════════════════════════════════════════════════════════════════ */
/* 3. 스테이션/로봇 유틸                                                      */
/* ═════════════════════════════════════════════════════════════════════ */
function getClasses(st) {
  const raw = Array.isArray(st.class) ? st.class
    : Array.isArray(st.classList) ? st.classList
      : st.class ? (Array.isArray(st.class) ? st.class : [st.class])
        : [];
  return raw.flat();
}
const hasClass = (st, c) => getClasses(st).includes(c);
const regionOf = st => hasClass(st, 'A') ? 'A' : hasClass(st, 'B') ? 'B' : null;
const amrAt = (robots, st) => robots.some(r => String(r.location) === String(st.id));

/* ── 버퍼 센서 DI ───────────────────────────────────────────────────── */
async function isBufferEmpty(ch) {
  const url = `http://${IO_HOST}/di_value/slot_0/ch_${ch}`;
  try {
    const { data } = await axios.get(url, { auth: IO_AUTH, timeout: 5_000 });
    return data && typeof data.Val !== 'undefined' ? data.Val === 1 : false;
  } catch (e) {
    console.error('[isBufferEmpty]', e.message);
    return false;
  }
}
function isBufferAvailable(station) {
  const regBase = Number(station.name.slice(1));    // 'B1' → 1, 'A3' → 3
  const regIdx = regBase + 3;                     // → 4,5,6
  // pick the correct RIO by region:
  const rioIp = regionOf(station) === 'B'
    ? '192.168.0.5'
    : '192.168.0.6';
  const dev = RIOS[rioIp];
  return Array.isArray(dev.lastRegs) && dev.lastRegs[regIdx] === 0;
}
/* ═════════════════════════════════════════════════════════════════════ */
/* 4. Door control helper                                                  */
/* ═════════════════════════════════════════════════════════════════════ */
/* ── Door control helper (region 인자 추가) ───────────────────── */
async function setDoor(slot, ch, open, region /* 'A' | 'B' */, id) {
  const last = doorState.get(id) || { open: !open, timestamp: 0 };
  if (last.open === open) return;
  if (Date.now() - last.timestamp < DOOR_COOLDOWN) return;

  const payload = {
    Ch: ch, Md: 0, Stat: open ? 1 : 0, Val: open ? 1 : 0,
    PsCtn: 0, PsStop: 0, PsIV: 0
  };
  const authHeader = 'Basic ' + Buffer.from('root:12345678').toString('base64');

  for (const DOOR_IP of DOOR_IPS[region]) {
    try {
      await axios.put(
        `http://${DOOR_IP}/do_value/slot_${slot}/ch_${ch}`,
        payload,
        { headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, timeout: 5_000 }
      );
      doorState.set(id, { open, timestamp: Date.now() });
    } catch (e) {
      console.error('[setDoor]', e.response?.data ?? e.message);
    }
  }
}


/* ═════════════════════════════════════════════════════════════════════ */
/* 5. TCP Nav 패킷 전송                                                     */
/* ═════════════════════════════════════════════════════════════════════ */
let serial = 0;
function buildPacket(code, obj = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt8(0x5A, 0);       // 'Z'
  head.writeUInt8(0x01, 1);
  head.writeUInt16BE(++serial & 0xffff, 2);
  head.writeUInt32BE(body.length, 4);
  head.writeUInt16BE(code, 8);
  return Buffer.concat([head, body]);
}
/* ─────────── 3-B. dispatcherService.js : sendGotoNav 수정 ─────────── */
function sendGotoNav(ip, dest, src, task) {
  return new Promise((ok, ng) => {
    const s = net.createConnection(19206, ip);
    const pkt = buildPacket(0x0BEB,
      { id: String(dest), source_id: String(src), task_id: task });

    s.setKeepAlive(true, 2000);     // TIME_WAIT 최소화
    s.once('connect', () => { s.write(pkt); s.end(); });
    s.once('close', ok);            // 완전히 닫힌 뒤 resolve
    s.once('error', ng);
    s.setTimeout(5000, () => { s.destroy(); ng(new Error('timeout')); });
  });
}


/* ═════════════════════════════════════════════════════════════════════ */
/* 6. 목적지 선택 로직 (기존 유지)                                            */
/* ═════════════════════════════════════════════════════════════════════ */
/**
 * 목적지 선택 로직
 * - cross-region: B↔A 이동 시 IC → 대기 → 최종 목적지 순으로 처리
 * - same-region: 기존 로직 유지
 */
// dispatcherService.js

/**
 * 목적지 선택 로직
 * @param {object} params
 * @param {object} params.fromSt    – 출발 스테이션 객체
 * @param {object} params.toSt      – 도착 스테이션 객체
 * @param {object} params.robot     – 디스패치 대상 로봇
 * @param {array}  params.robots    – 전체 로봇 목록
 * @param {array}  params.stations  – 전체 스테이션 목록
 * @returns {object|null} 다음 이동할 스테이션 또는 null
 */
async function chooseDestination({ fromSt, toSt, robot, robots, stations }) {
  console.log(`\n[chooseDestination] from='${fromSt.name}' to='${toSt.name}' robot='${robot.name}'`);
  const fr = regionOf(fromSt);
  const tr = regionOf(toSt);
  const crossing = fr && tr && fr !== tr;
  console.log(`[chooseDestination] region from=${fr}, to=${tr}, crossing=${crossing}`);

/* ── Buffer entry:  <BUFFER>_PRE → BUFFER ── */
if (hasClass(toSt, '버퍼')) {
  const preSt = stations.find(s => s.name === `${toSt.name}_PRE`);
  if (!preSt) return null;              // safety

  // ① first hop: send to PRE
  if (String(fromSt.id) !== String(preSt.id)) {
    await Robot.update(
      { phase: 'to_pre', bufferTargetId: toSt.id },
      { where: { id: robot.id } }
    );
    return preSt;
  }

  // ② already at PRE → next hop: BUFFER  (lift FSM will do jack-UP)
  await Robot.update(
    { phase: 'to_pre', bufferTargetId: toSt.id },    // keep same phase
    { where: { id: robot.id } }
  );
  return null;  
}

/* ── Buffer leave:  BUFFER → <BUFFER>_PRE ── */
if (hasClass(fromSt, '버퍼') && !hasClass(toSt, '버퍼')) {
  const preSt = stations.find(s => s.name === `${fromSt.name}_PRE`);
  if (!preSt) return null;

  // ① in BUFFER → jack-UP then go to PRE
  await Robot.update(
    { phase: 'leave_buf_up', bufferTargetId: fromSt.id },
    { where: { id: robot.id } }
  );
  return preSt;
}



  // ── 1) 교차 리전 이동 (A↔B) ───────────────────────────────
  if (crossing) {
    console.log('⮕ crossing-branch');

    // a) 아직 IC 안 왔으면 IC로
    if (!hasClass(fromSt, 'IC') && !hasClass(fromSt, '대기')) {
      console.log('  a) send to IC');
      const ic = stations.find(s =>
        regionOf(s) === fr &&
        hasClass(s, 'IC') &&
        // 아무도 그 IC에 없을 때
        !robots.some(r => String(r.location) === String(s.id))
      );
      console.log('    → IC chosen =', ic?.name || 'none');
      return ic || null;
    }

    // b) IC에 와서 다른 AMR이 경로 막고 있으면 → 대기
    console.log('  b) check if OTHER robots block any 경로-station');
    const crossPathStations = stations.filter(s =>
      hasClass(s, '경로')
    );
    console.log('    pathStations =', crossPathStations.map(s => s.name));
    const pathBlocked = crossPathStations.some(ps =>
      robots.some(r =>
        r.id !== robot.id &&
        String(r.location) === String(ps.id)
      )
    );
    console.log('    pathBlocked by other =', pathBlocked);
    if (pathBlocked) {
      const waitSt = stations.find(s =>
        regionOf(s) === fr &&
        hasClass(s, '대기') &&
        !robots.some(r => String(r.location) === String(s.id))
      );
      console.log('    → 대기 chosen =', waitSt?.name || 'none');
      return waitSt || null;
    }

    // c) 목적지 비어 있으면 → toSt
    console.log('  c) check if final toSt is free');
    const toStOccupied = robots.some(r => String(r.location) === String(toSt.id));
    console.log('    toStOccupied =', toStOccupied);
    if (!toStOccupied) {
      console.log('    → toSt is free, returning toSt');
      return toSt;
    }

    // d) 같은 리전의 빈 버퍼 중 사용 가능한 것
    console.log('  d) find available buffers in target region');
    const bufCandidates = stations.filter(s =>
      regionOf(s) === tr &&
      hasClass(s, '버퍼') &&
      !robots.some(r => String(r.location) === String(s.id))
    );
    console.log('    buffer candidates =', bufCandidates.map(s => s.name));
    for (const buf of bufCandidates) {
      const ok = await isBufferAvailable(buf);
      console.log(`    buffer '${buf.name}' available?`, ok);
      if (ok) {
        console.log('    → returning buffer', buf.name);
        return buf;
      }
    }

    // e) 모두 안 되면 null (큐 로직은 외부에서)
    console.log('  e) no option found, return null');
    return null;
  }

  // ── 2) 동일 리전 이동 (A→A or B→B) ───────────────────────────
  console.log('⮕ same-region branch');

  // 2-1) “경로”에 다른 로봇 있으면 → ‘대기’
  console.log('  2-1) check if OTHER robots block any 경로-station');
  const localPathStations = stations.filter(s =>
    hasClass(s, '경로') && regionOf(s) === fr
  );
  console.log('    pathStations =', localPathStations.map(s => s.name));
  const localBlocked = localPathStations.some(ps =>
    robots.some(r =>
      r.id !== robot.id &&
      String(r.location) === String(ps.id)
    )
  );
  console.log('    pathBlocked by other =', localBlocked);
  if (localBlocked) {
    const waitSt = stations.find(s =>
      regionOf(s) === fr &&
      hasClass(s, '대기') &&
      !robots.some(r => String(r.location) === String(s.id))
    );
    console.log('    → 대기 chosen =', waitSt?.name || 'none');
    return waitSt || null;
  }

  // 2-2) 버퍼 → 적하만 허용
  console.log('  2-2) if fromSt is 버퍼 and toSt is 적하');
  if (hasClass(fromSt, '버퍼') && hasClass(toSt, '적하')) {
    const destFree = !robots.some(r => String(r.location) === String(toSt.id));
    console.log('    toSt free =', destFree);
    if (destFree) {
      console.log('    → returning toSt');
      return toSt;
    } else {
      console.log('    → toSt occupied, return null');
      return null;
    }
  }

  // 기타: 이동 불가
  console.log('  default: no move possible, return null');
  return null;
}



/* ═════════════════════════════════════════════════════════════════════ */
/* 7-A. RIO 폴링                                                            */
/* ═════════════════════════════════════════════════════════════════════ */

async function connectRio(ip, dev) {
  // simple promise‐timeout helper
  function withTimeout(p, ms) {
    let tid;
    const timeout = new Promise((_, rej) => tid = setTimeout(() =>
      rej(new Error('timeout')), ms));
    return Promise.race([p, timeout]).finally(() => clearTimeout(tid));
  }

  try {
    // race connectTCP against a 3s timeout
    await withTimeout(dev.client.connectTCP(ip, { port: RIO_PORT }), 3_000);
    dev.client.setID(RIO_UNIT_ID);
    dev.connected = true;
    console.log(`[RIO] ${ip} re-connected`);

    if (dev.client._port) {
      dev.client._port.removeAllListeners('close');
      dev.client._port.removeAllListeners('error');
      dev.client._port.on('close', () => { dev.connected = false; });
      dev.client._port.on('error', () => { dev.connected = false; });
    }
  } catch (e) {
    dev.connected = false;
    console.error(`[RIO] ${ip} reconnect error –`, e.message);
  }
}

async function pollAllRios() {
  for (const [ip, dev] of Object.entries(RIOS)) {
    // If we’re marked disconnected, but tried too recently, skip reconnect
    if (!dev.connected) {
      if (Date.now() - dev.lastAttempt < 5_000) {
        continue;
      }
      dev.lastAttempt = Date.now();
      await connectRio(ip, dev);
      if (!dev.connected) {
        continue;
      }
    }

    try {
      // Read 16 holding registers at address 0
      const { data } = await dev.client.readHoldingRegisters(0, 16);
      dev.lastRegs = data;
      // Determine which register indices are currently 1
      const activeRegs = data.reduce((regs, val, idx) => {
        if (val === 1) regs.push(idx);
        return regs;
      }, []);

      console.log(
        `[RIO] ${ip} active regs:${activeRegs.length ? ' ' + activeRegs.join(', ') : ' <none>'
        }`
      );

      // Update each route's prev/curr state
      for (const [regIdx, route] of Object.entries(dev.routes)) {
        route.prev = route.curr;
        route.curr = data[regIdx];
      }
    } catch (e) {
      console.error(`[RIO] ${ip} read error –`, e.message);
      // Mark disconnected so we'll try to reconnect on next tick
      dev.connected = false;
    }
  }
}



async function clearRioFlag(dev, regIdx) {
  try {
    await dev.client.writeRegister(Number(regIdx), 0);
    dev.routes[regIdx].prev = 0;
    dev.routes[regIdx].curr = 0;
  } catch (e) {
    console.error('[RIO] clear flag error –', e.message);
  }
}

async function setRioFlag(dev, open, regIdx) {
  try {
    await dev.client.writeRegister(Number(regIdx), open);
    dev.routes[regIdx].prev = open;
    dev.routes[regIdx].curr = open;
  } catch (e) {
    console.error('[RIO] clear flag error –', e.message);
  }
}

/* ═════════════════════════════════════════════════════════════════════ */
/* 7-B. Edge 이벤트 처리 (다단계 검사)                                         */
/* ═════════════════════════════════════════════════════════════════════ */
/**
 * Handle a rising-edge event on a RIO register.
 * @param {string} ip       – IP of the RIO that triggered
 * @param {object} dev      – The RIO device entry (client, routes, etc.)
 * @param {string} regIdx   – The register index that went high
 * @param {object} route    – The route metadata ({ from, to, prev, curr })
 */
async function handleRioEdge(ip, dev, regIdx, route) {
  const { from: fromName, to: toName } = route;

  // 1) Load the current map and stations
  const mapRow = await MapDB.findOne({ where: { is_current: true } });
  if (!mapRow) return;
  const stations = JSON.parse(mapRow.stations || '{}').stations || [];

  // 2) Find the source+destination station objects
  const fromSt = stations.find(s => s.name === fromName);
  const toSt = stations.find(s => s.name === toName);
  if (!(fromSt && toSt)) return;

  // 3) Fetch all robots, and those currently at the from-station
  const robots = await Robot.findAll();
  const robotsAt = robots.filter(r => String(r.location) === String(fromSt.id));
  if (robotsAt.length === 0) return;

  // 4) Compute regions, with safe 'UNKNOWN' fallback
  const fr = regionOf(fromSt) || 'UNKNOWN';
  const tr = regionOf(toSt) || 'UNKNOWN';
  const crossing = fr !== 'UNKNOWN' && tr !== 'UNKNOWN' && fr !== tr;

  // 5) If any robot is already moving in fr-region, then hold or queue
  const movingInRegion = robots.some(r => {
    const st = stations.find(s => String(s.id) === String(r.location));
    const rgn = regionOf(st) || 'UNKNOWN';
    return r.status === '이동' && rgn === fr;
  });
  if (movingInRegion) {
    if (crossing) {
      // queue cross-region retry
      robotsAt.forEach(r => pq.set(r.id, toSt.id));
      await log('RIO_QUEUE',
        `cross-hold ${robotsAt.map(r => r.name).join(',')}`,
        {
          robot_name: robotsAt.map(r => r.name).join(','),
          from: fromName,
          to: toName,
          status: 'queued',
          detail: `edge reg${regIdx}`
        }
      );
    }
    return;
  }

  // 6) Attempt actual dispatch
  const robot = robotsAt[0];
  const next = await chooseDestination({ fromSt, toSt, robot, robots, stations });
  if (!next) {
    if (crossing) {
      pq.set(robot.id, toSt.id);
      await log('RIO_QUEUE',
        `cross-cond ${robot.name}`,
        {
          robot_name: robot.name,
          from: fromName,
          to: toName,
          status: 'queued',
          detail: `edge reg${regIdx}`
        }
      );
    }
    return;
  }

  // 7) Send NAV command and update status/log
  const taskId = Date.now().toString();
  await sendGotoNav(robot.ip, next.id, 'SELF_POSITION', taskId);
  await Robot.update(
    { destination: next.name, status: '이동', timestamp: new Date() },
    { where: { id: robot.id } }
  );
  await log('RIO_DISPATCH',
    `RIO ${ip} ${robot.name} ${fromName}→${next.name} (${taskId})`,
    {
      robot_name: robot.name,
      from: fromName,
      to: next.name,
      status: '이동',
      detail: `edge reg${regIdx}`
    }
  );

  // 8) If cross-region and not yet at final toSt, keep in queue
  if (crossing && String(next.id) !== String(toSt.id)) {
    pq.set(robot.id, toSt.id);
  }
}
function shouldSendJack(id, dir) {
  const rec = jackMemo.get(id);
  const now = Date.now();
  if (!rec || rec.lastCmd !== dir || now - rec.ts > JACK_COOLDOWN) {
    jackMemo.set(id, { lastCmd: dir, ts: now });
    return true;        /* 이번에 보내도 됨 */
  }
  return false;         /* 쿨다운 중 → skip */
}


/* ═════════════════════════════════════════════════════════════════════ */
/* 7-C. 주기 워커 (1 Hz)                                                     */
/* ═════════════════════════════════════════════════════════════════════ */

let lastSeenDoorA = 0;
let lastSeenDoorB = 0;
let running = false;

async function workerTick() {
  if (running) return;              // 중첩 방지
  running = true;
  try {
        /* ───────────────── Lift state machine ─────────────── */


/* ─── ② 버퍼 시퀀스 루프 수정 ─────────────────────────── */
const allRobots = await Robot.findAll();
const mapRow    = await MapDB.findOne({ where: { is_current: true } });
const stations  = JSON.parse(mapRow.stations || '{}').stations || [];
/* ─── lift state machine ────────────────────────────────────────── */
/**********************************************************************
 *  Buffer / lift finite-state machine
 *********************************************************************/
const robos   = await Robot.findAll();
const sts     = JSON.parse(mapRow.stations || '{}').stations || [];

function locOf(r)    { return sts.find(s => String(s.id) === String(r.location)); }
function preOf(buf)  { return sts.find(s => s.name === `${buf.name}_PRE`); }

/* helper – send setHeight exactly once per phase */
async function jackOnce(r, dir) {
  if (!shouldSendJack(r.id, dir)) return;
  const ht = dir === 'up' ? LIFT_UP : LIFT_DOWN;
  await sendJackCommand(r.ip, CODES.setHeight, { height: ht });
  console.log(`[JACK] ${r.name} ${dir.toUpperCase()} → ${ht} m`);
}


for (const r of robos) try {

  const here = locOf(r);

  /* ────── 진입 시퀀스 ───────────────────────────────────────── */
  if (r.phase === 'to_pre') {
    const buf = sts.find(s => s.id == r.bufferTargetId);
    const pre = preOf(buf);
    if (here && pre && here.id === pre.id) {                  // PRE 도착
      await jackOnce(r, 'up');
      await r.update({ phase: 'pre_lifted' });
    }
  }

  else if (r.phase === 'pre_lifted') {                        // 잭 올린 뒤 버퍼로
    const buf = sts.find(s => s.id == r.bufferTargetId);
    await sendGotoNav(r.ip, buf.id, 'SELF_POSITION', Date.now().toString());
    await r.update({ phase: 'to_buf' });
  }

  else if (r.phase === 'to_buf') {                            // 버퍼 도착 → 잭 내림
    if (here && hasClass(here, '버퍼')) {
      await jackOnce(r, 'down');
      await r.update({ phase: 'buf_done', bufferTargetId: null });
    }
  }

  else if (r.phase === 'buf_done') {                          // 완료 → idle
    await r.update({ phase: null });
  }

  /* ────── 출발 시퀀스 ───────────────────────────────────────── */
  else if (r.phase === 'leave_buf_up') {                      // 버퍼에서 잭 올림
    await jackOnce(r, 'up');
    const pre = preOf(here);
    if (pre) {
      await sendGotoNav(r.ip, pre.id, 'SELF_POSITION', Date.now().toString());
      await r.update({ phase: 'leave_to_pre' });
    }
  }

  else if (r.phase === 'leave_to_pre') {                      // PRE 도착 → 잭 내림
    const pre = preOf(sts.find(s => s.id == r.bufferTargetId));
    if (here && pre && here.id === pre.id) {
      await jackOnce(r, 'down');
      await r.update({ phase: 'leave_done', bufferTargetId: null });
    }
  }

  else if (r.phase === 'leave_done') {                        // 종료 → idle
    await r.update({ phase: null });
  }

} catch (e) {
  await log('JACK_ERR', e.message, { robot_name: r.name });
}




    await pollAllRios();

    /* RIO edge handling */
    for (const [ip, dev] of Object.entries(RIOS)) {
      for (const [regIdx, route] of Object.entries(dev.routes)) {
        /* rising-edge 감지 */
        if (route.curr === 1 && route.prev === 0) {
          try { await handleRioEdge(ip, dev, regIdx, route); }
          catch (e) { console.error('[RIO_EDGE]', e.message); }
          console.log("!!!!!!edge!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
          await clearRioFlag(dev, regIdx);           // 반드시 리셋
        }
        /* 비트가 계속 1이라면 PLC 측이 멈춰 있지 않도록 리셋 */
        else if (route.curr === 1) {
          await clearRioFlag(dev, regIdx);
        }
      }
    }

    /* ── Door & 교차-재시도 큐 (기존 로직 유지) ───────────────────────── */
    //const mapRow = await MapDB.findOne({ where: { is_current: true } });
    if (!mapRow) return;
    //const stations = (JSON.parse(mapRow.stations || '{}').stations || []);
    const robots = await Robot.findAll();

    // find any AMR at an A-side door
    const doorAOc = stations
      .filter(s => hasClass(s, 'door') && hasClass(s, 'A'))
      .some(s => robots.some(r => String(r.location) === String(s.id)));

    if (doorAOc) {
      lastSeenDoorA = Date.now();
      //await setDoor(0, 0, true, 'A', 'doorA');
    } else {
      //await setDoor(0, 0, false, 'A', 'doorA');
    }
    console.log("doorA", doorAOc)

    // find any AMR at a B-side door
    const doorBOc = stations
      .filter(s => hasClass(s, 'door') && hasClass(s, 'B'))
      .some(s => robots.some(r => String(r.location) === String(s.id)));

    if (doorBOc) {
      lastSeenDoorB = Date.now();
      //await setDoor(0, 0, true, 'B', 'doorB');
    } else {
      //await setDoor(0, 0, false, 'B', 'doorB');
    }
    console.log("doorB", doorBOc)
    // const anyDoorOccupied = stations
    // .filter(s => hasClass(s,'door'))
    // .some(s => robots.some(r => String(r.location) === String(s.id)));

    /* ── workerTick 내부: 도어 A/B 각각 제어 ───────────────────────── */
    // const doorAOpen = stations.some(s =>
    //   hasClass(s, 'door') && hasClass(s, 'A') &&
    //   robots.find(r => String(r.location) === String(s.id)), 

    // );
    // const doorBOpen = stations.some(s =>
    //   hasClass(s, 'door') && hasClass(s, 'B') &&
    //   robots.find(r => String(r.location) === String(s.id))
    // );
    // if (anyDoorOccupied) {
    //   lastSeenAtDoor = Date.now();
    //   await setDoor(0, 0, true, 'A', 'doorA');
    //   await setDoor(0, 0, true, 'B', 'doorB');
    // } else if (Date.now() - lastSeenAtDoor > 5000) {
    //   // only close if ½ second has passed with nobody at the door
    //   await setDoor(0, 0, false, 'A', 'doorA');
    //   await setDoor(0, 0, false, 'B', 'doorB');
    // }


    if (!pq.size()) return;
    for (const [rid, destId] of pq.entries()) {
      const robot = robots.find(r => r.id == rid);
      if (!robot) { pq.del(rid); continue; }
      if (robot.status === '이동') continue;

      const hereSt = stations.find(s => String(s.id) === String(robot.location));
      const destSt = stations.find(s => String(s.id) === String(destId));
      if (!(hereSt && destSt)) { pq.del(rid); continue; }

      const next = await chooseDestination({ fromSt: hereSt, toSt: destSt, robot, robots, stations });
      if (!next) continue;

      const taskId = Date.now().toString();
      try {
        await sendGotoNav(robot.ip, next.id, 'SELF_POSITION', taskId);
        await Robot.update(
          { destination: next.name, status: '이동', timestamp: new Date() },
          { where: { id: robot.id } },
        );
        await log('AUTO_DISPATCH',
          `${robot.name}→${next.name}`, {
          robot_name: robot.name, from: hereSt.name, to: destSt.name,
          status: '이동', detail: 'auto-retry',
        });
      } catch (e) {
        await log('AUTO_ERR', e.message, { robot_name: robot.name });
      }
      if (String(next.id) === String(destSt.id)) pq.del(rid);
    }
  } finally {
    running = false;
  }
}
setInterval(workerTick, 1_000);

/* ═════════════════════════════════════════════════════════════════════ */
/* 8. POST /api/dispatch 핸들러 (변경 없음)                                   */
/* ═════════════════════════════════════════════════════════════════════ */
exports.handleRequest = async (req, res) => {
  try {
    const { from: fromName, to: toName } = req.body || {};
    if (!fromName || !toName) {
      return res.status(400).json({ message: 'from / to required' });
    }

    const mapRow = await MapDB.findOne({ where: { is_current: true } });
    if (!mapRow) return res.status(400).json({ message: 'no current map' });

    const stations = (JSON.parse(mapRow.stations || '{}').stations || []);
    const fromSt = stations.find(s => (s.name ?? String(s.id)) === fromName);
    const toSt = stations.find(s => (s.name ?? String(s.id)) === toName);
    if (!(fromSt && toSt)) {
      return res.status(404).json({ message: 'station not found' });
    }

    const robots = await Robot.findAll();
    const robotsAtFrom = robots.filter(r => String(r.location) === String(fromSt.id));
    if (!robotsAtFrom.length) {
      return res.json({ ignored: true, reason: 'no amr at from' });
    }

    const crossing =
      regionOf(fromSt) && regionOf(toSt) && regionOf(fromSt) !== regionOf(toSt);

    /* 이미 해당 region 에 이동 중인 AMR 이 있는 경우 */
    if (robots.some(r =>
      r.status === '이동' &&
      regionOf(stations.find(s => String(s.id) === String(r.location)))
      === regionOf(fromSt))) {
      if (crossing) {
        robotsAtFrom.forEach(r => pq.set(r.id, toSt.id));
        await log('QUEUE',
          `cross-hold ${robotsAtFrom.map(r => r.name).join(',')}`,
          {
            robot_name: robotsAtFrom.map(r => r.name).join(','),
            from: fromName, to: toName, status: 'queued',
            detail: 'cross-hold'
          });
        return res.status(202).json({
          holding: true,
          queued: robotsAtFrom.map(r => r.name),
        });
      }
      return res.json({ ignored: true, reason: 'moving amr in region' });
    }

    /* 실제 디스패치 */
    const robot = robotsAtFrom[0];
    const next = await chooseDestination({
      fromSt, toSt, robot,
      robots, stations
    });
    if (!next) {
      if (crossing) {
        pq.set(robot.id, toSt.id);
        await log('QUEUE',
          `cross-cond ${robot.name}`,
          {
            robot_name: robot.name,
            from: fromName, to: toName,
            status: 'queued', detail: 'cross-cond'
          });
        return res.status(202).json({ holding: true, queued: [robot.name] });
      }
      return res.json({ ignored: true, reason: 'cond unmet' });
    }

    const taskId = Date.now().toString();
    await sendGotoNav(robot.ip, next.id, 'SELF_POSITION', taskId);
    await Robot.update(
      { destination: next.name, status: '이동', timestamp: new Date() },
      { where: { id: robot.id } },
    );

    await log('DISPATCH',
      `${robot.name}→${next.name} (${taskId})`,
      {
        robot_name: robot.name,
        from: fromName, to: toName,
        status: '이동', detail: `taskId:${taskId}`
      });

    if (crossing && String(next.id) !== String(toSt.id)) {
      pq.set(robot.id, toSt.id);
    }

    res.json({
      success: true,
      dispatched: robot.name,
      dest: next.name,
      taskId,
      queued_next: pq.entries().some(([id]) => id == robot.id),
    });
  } catch (e) {
    console.error('[dispatcher]', e);
    //await log('HTTP_ERR', e.message);
    res.status(500).json({ message: e.message });
  }
};

/* ═════════════════════════════════════════════════════════════════════ */
/* 9. EXPORTS                                                             */
/* ═════════════════════════════════════════════════════════════════════ */
exports.sendGotoNav = sendGotoNav;
exports.chooseDestination = chooseDestination;
exports.isBufferEmpty = isBufferEmpty;
//exports.buildPacket = buildPacketRoutes;   // ★ 추가