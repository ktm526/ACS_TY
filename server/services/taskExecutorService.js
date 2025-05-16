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

/* ───────────────────────────── constants ───────────────────────────── */
const TICK_MS         = 500;          // 0.5s
const MAX_RETRY       = 3;            // step 실패 시 재시도 횟수
const STEP_TIMEOUT_MS = 1_800_000;    // 30분

/* ───────────────────── waitUntil helper ──────────────────────────── */
const waitUntil = (cond, ms, taskId) => new Promise((resolve) => {
  const start = Date.now();
  const i = setInterval(async () => {
    // 1) 취소·일시정지 검사
    if (taskId) {
      const t = await Task.findByPk(taskId);
      if (['PAUSED', 'CANCELED', 'FAILED'].includes(t?.status)) {
        clearInterval(i);
        return resolve('INTERRUPTED');
      }
    }
    // 2) 원래 조건
    if (await cond()) {
      clearInterval(i);
      return resolve(true);
    }
    // 3) 타임아웃
    if (Date.now() - start > ms) {
      clearInterval(i);
      return resolve(false);
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
  const payload = typeof step.payload === 'string'
    ? JSON.parse(step.payload)
    : (step.payload ?? {});

  console.log(`  ↪ [RUN] task#${task.id} seq=${step.seq} (${step.type})`);

  // ─ NAV_PRE: just send once, no wait
  if (step.type === 'NAV_PRE') {
    console.log(`    ▶ NAV PRE send → dest=${payload.dest}`);
    await sendGotoNav(robot.ip, payload.dest, 'SELF_POSITION', `${Date.now()}`);

    const ok = await waitUntil(async () => {
      const fresh = await Robot.findByPk(robot.id);
      return String(fresh.location) === String(payload.dest);
    }, STEP_TIMEOUT_MS, task.id);

    console.log(`    ◀ NAV ${ok ? 'DONE' : 'TIMEOUT'}`);
    if (!ok) throw new Error('NAV timeout');
    return true;
  }

  // ─ NAV: send + wait for location change
  if (step.type === 'NAV') {
    console.log(`    ▶ NAV send → dest=${payload.dest}`);
    await sendGotoNav(robot.ip, payload.dest, 'SELF_POSITION', `${Date.now()}`);

    const ok = await waitUntil(async () => {
      const fresh = await Robot.findByPk(robot.id);
      return String(fresh.location) === String(payload.dest);
    }, STEP_TIMEOUT_MS, task.id);

    console.log(`    ◀ NAV ${ok ? 'DONE' : 'TIMEOUT'}`);
    if (!ok) throw new Error('NAV timeout');
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
      }
    } else {
      console.log('    ▶ JACK already sent, skipping send');
    }

    // now wait for Robot.status === '대기'
    const ok = await waitUntil(async () => {
      const fresh = await Robot.findByPk(robot.id);
      return fresh.status === '대기';
    }, STEP_TIMEOUT_MS, task.id);

    console.log(`    ◀ JACK ${ok ? 'DONE' : 'TIMEOUT'}`);
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
  
    const blocked = pathSts.some(ps =>
      otherRobots.some(r => String(r.location) === String(ps.id))
    );
    console.log(`    ▶ WAIT_FREE_PATH blocked=${blocked}`);
  
    if (blocked) {
      // 2) Only *then* if we're still sitting in an IC, redirect to 대기
      const currentSt = stations.find(s => String(s.id) === String(robot.location));
      if (currentSt && hasClass(currentSt, 'IC')) {
        const waitSt = stations.find(s =>
          hasClass(s, '대기') &&
          regionOf(s) === regionOf(currentSt)
        );
        if (waitSt) {
          console.log(
            `    ▶ WAIT_FREE_PATH: path blocked and at IC(${currentSt.name}) → ` +
            `redirecting to 대기(${waitSt.name})`
          );
          await sendGotoNav(robot.ip, waitSt.id, 'SELF_POSITION', `${Date.now()}`);
        }
      }
      // still busy, stay in this step
      return false;
    }
  
    // 3) path is clear → complete this step
    return true;
  }
  
    

  // ─ NAV_OR_BUFFER (dynamic buffer steps)
  if (step.type === 'NAV_OR_BUFFER') {
    const { primary } = payload;
    const mapRow      = await MapDB.findOne({ where: { is_current: true } });
    const stations    = JSON.parse(mapRow.stations||'{}').stations||[];
    const robots      = await Robot.findAll();

    const primarySt = stations.find(s=>s.name===primary);
    const region    = regionOf(primarySt);
    const occupied  = robots.some(r=>String(r.location)===String(primarySt.id));

    let targetSt = primarySt;
    if (occupied) {
      targetSt = stations.find(s=>
        regionOf(s)===region &&
        hasClass(s,'버퍼') &&
        !robots.some(r=>String(r.location)===String(s.id))
      );
      if (!targetSt) throw new Error('no empty buffer in region');
    }

    if (targetSt.id === primarySt.id) {
      await sendGotoNav(robot.ip,targetSt.id,'SELF_POSITION',`${Date.now()}`);
    } else {
      const pre = stations.find(s=>s.name===`${targetSt.name}_PRE`);
      if (!pre) throw new Error('no PRE station for buffer');
      await TaskStep.bulkCreate([
        { task_id:task.id, seq:step.seq+1, type:'NAV_PRE',
          payload:JSON.stringify({ dest:pre.id }) },
        { task_id:task.id, seq:step.seq+2, type:'JACK_UP',
          payload:JSON.stringify({ height:0.03 }) },
        { task_id:task.id, seq:step.seq+3, type:'NAV',
          payload:JSON.stringify({ dest:targetSt.id }) },
        { task_id:task.id, seq:step.seq+4, type:'JACK_DOWN',
          payload:JSON.stringify({ height:0.0 }) },
      ]);
      await step.update({ status:'DONE' });
    }
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

  try {
    // Lock & fetch one task for this robot
    let lockedTask = null;
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
      }
    });
    if (!lockedTask) return;

    // fetch the next step
    const task = await Task.findByPk(lockedTask.id);
    const step = await TaskStep.findOne({ where:{ task_id:task.id, seq:task.current_seq } });

    // handle DONE/FAILED/no-step cases...
    if (!step)              { await task.update({ status:'DONE' }); return; }
    if (step.status==='FAILED'){ await task.update({ status:'FAILED' }); return; }
    if (step.status==='DONE')  { await task.update({ current_seq: task.current_seq+1 }); return; }
    if (step.status==='PENDING'){ await step.update({ status:'RUNNING' }); }

    // actually run it
    const robot = await Robot.findByPk(robot_id);
    const finished = await runStep(task, robot, step);

    if (finished) {
      await sequelize.transaction(async tx => {
        await step.update({ status:'DONE' }, { transaction: tx });
        await task.update(
          { current_seq: task.current_seq + 1 },
          { transaction: tx }
        );
      });
    }
    // else if runStep returned false (WAIT_FREE_PATH) we leave it RUNNING
  } catch (err) {
    // retry logic...
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
