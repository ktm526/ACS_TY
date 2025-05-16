/************************************************************************
 *  taskExecutorService.js  (2025-05-09)
 *  ────────────────────────────────────────────────────────────────────
 *  ▸ “로봇별 1 Task 동시 실행” 보장 (skip-locked select)
 *  ▸ NAV / JACK 실행, 도착 확인은 간단 폴링 waitUntil 예시 포함
 ************************************************************************/
require('dotenv').config();

const { Op, Sequelize } = require('sequelize');
const sequelize         = require('../config/db');
const { Task, TaskStep } = require('../models');     // models/index.js – Task.hasMany(TaskStep, { as:'steps' })
const Robot             = require('../models/Robot');
const MapDB             = require('../models/Map');

const { sendGotoNav }     = require('./dispatcherService');
const { sendJackCommand } = require('./robotJackService');
const JACK_CODES          = require('../controllers/jackController').CODES;
const { hasClass, regionOf } = require('./dispatcherService');

/* ───────────────────────────── 상수 ─────────────────────────────── */
const TICK_MS         = 500;          // 0.5 s ticker
const MAX_RETRY       = 3;            // step fail → retry 횟수
const STEP_TIMEOUT_MS = 1800000;       // NAV / JACK 최대 대기 1800 s

/* ───────────────────── waitUntil helper (500 ms poll) ───────────── */
const waitUntil = (cond, ms) => new Promise(resolve => {
  const start = Date.now();
  const t = setInterval(async () => {
    if (await cond()) { clearInterval(t); return resolve(true); }
    if (Date.now() - start > ms) { clearInterval(t); return resolve(false); }
  }, 500);
});

/* ───────────────────────── enqueue helper ───────────────────────── */
async function enqueueTask (robotId, steps) {
  return sequelize.transaction(async tx => {
    const task = await Task.create({ robot_id: robotId }, { transaction: tx });
    await TaskStep.bulkCreate(steps.map((s, i) => ({
      task_id : task.id,
      seq     : i,
      type    : s.type,
      payload : JSON.stringify(s.payload ?? {}),
      status  : 'PENDING',
    })), { transaction: tx });
    return task;
  });
}
exports.enqueueTask = enqueueTask;

/* ──────────────────────────── step 실행 ─────────────────────────── */
async function runStep (task, robot, step) {
  const payload = typeof step.payload === 'string'
    ? JSON.parse(step.payload) : (step.payload ?? {});

  /* ── NAV / NAV_PRE ────────────────────────────────────────────── */
  if (step.type === 'NAV' || step.type === 'NAV_PRE') {
    await sendGotoNav(robot.ip, payload.dest, 'SELF_POSITION', Date.now());

    const ok = await waitUntil(async () => {
      const fresh = await Robot.findByPk(robot.id);
      return String(fresh.location) === String(payload.dest);
    }, STEP_TIMEOUT_MS);

    if (!ok) throw new Error('NAV timeout');
  }

  /* ── JACK (generic) ───────────────────────────────────────────── */
  else if (step.type === 'JACK' || step.type === 'JACK_UP' || step.type === 'JACK_DOWN') {
    const height = step.type === 'JACK_UP'  ? 0.03
                : step.type === 'JACK_DOWN'? 0.0
                : payload.height;
    await sendJackCommand(robot.ip, JACK_CODES.setHeight, { height });

    const ok = await waitUntil(async () => {
        const fresh = await Robot.findByPk(robot.id);
        console.log(fresh)
        return String(fresh.status) === "대기"
    })
    if (!ok) throw new Error('JACK error');

    // 실제 센서 확인이 필요하면 waitUntil 추가
  }

  /* ── 경로 대기 ─────────────────────────────────────────────────── */
  else if (step.type === 'WAIT_FREE_PATH') {
    const mapRow   = await MapDB.findOne({ where: { is_current: true } });
    const stations = JSON.parse(mapRow.stations || '{}').stations || [];
    const pathSts  = stations.filter(s => hasClass(s, '경로'));
    const robots   = await Robot.findAll();

    const blocked = pathSts.some(ps =>
      robots.some(r => String(r.location) === String(ps.id)));

    if (blocked) return;      // 아직 막혀있음 → 다음 tick 재시도

    await sequelize.transaction(tx => Promise.all([
      step.update({ status: 'DONE' }, { transaction: tx }),
      //task.update({ current_seq: task.current_seq + 1 }, { transaction: tx }),
    ]));
    return;
  }

  /* ── NAV_OR_BUFFER (동적 step 삽입) ────────────────────────────── */
  else if (step.type === 'NAV_OR_BUFFER') {
    const { primary } = payload;            // 예: 'A4'
    const mapRow      = await MapDB.findOne({ where: { is_current: true } });
    const stations    = JSON.parse(mapRow.stations || '{}').stations || [];
    const robots      = await Robot.findAll();

    const primarySt   = stations.find(s => s.name === primary);
    const region      = regionOf(primarySt);

    const occupied    = robots.some(r => String(r.location) === String(primarySt.id));

    /* 빈 버퍼 찾기 */
    let targetSt = primarySt;
    if (occupied) {
      targetSt = stations.find(s =>
        regionOf(s) === region &&
        hasClass(s, '버퍼') &&
        !robots.some(r => String(r.location) === String(s.id))
      );
      if (!targetSt) throw new Error('no empty buffer in region');
    }

    /* ── primary 로 곧장 ───────────────────────────────────────── */
    if (targetSt.id === primarySt.id) {
      await sendGotoNav(robot.ip, targetSt.id, 'SELF_POSITION', Date.now());
    }

    /* ── buffer 사용 (동적 step 4 개 삽입) ─────────────────────── */
    else {
      const pre = stations.find(s => s.name === `${targetSt.name}_PRE`);
      if (!pre) throw new Error('no PRE station for buffer');

      await TaskStep.bulkCreate([
        { task_id: task.id, seq: step.seq + 1, type: 'NAV_PRE',
          payload: JSON.stringify({ dest: pre.id }) },
        { task_id: task.id, seq: step.seq + 2, type: 'JACK_UP',
          payload: JSON.stringify({ height: 0.03 }) },
        { task_id: task.id, seq: step.seq + 3, type: 'NAV',
          payload: JSON.stringify({ dest: targetSt.id }) },
        { task_id: task.id, seq: step.seq + 4, type: 'JACK_DOWN',
          payload: JSON.stringify({ height: 0.0 }) },
      ]);

      await step.update({ status: 'DONE' });
      //await task.update({ current_seq: task.current_seq + 1 });
    }
  }

  else { throw new Error(`unknown step type: ${step.type}`); }
}

/* ───────────────────────────── worker tick ───────────────────────── */
async function tick () {
  /* 1) 로봇 id 컬럼만 group-by 추출 (skip-locked 지원) */
  const robots = await Task.findAll({
    where      : { status: { [Op.in]: ['PENDING', 'RUNNING'] } },
    attributes : ['robot_id'],
    group      : ['robot_id'],
    raw        : true,
  });

  for (const { robot_id } of robots) {

    /* ── 트랜잭션 안에서 1건 lock & 상태 전환 ──────────────── */
    await sequelize.transaction(
      { isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async tx => {
        let task = await Task.findOne({
          where : { robot_id,
            status: { [Op.in]: ['RUNNING', 'PENDING'] } },
          order : [['id', 'ASC']],
          lock  : tx.LOCK.UPDATE, skipLocked: true,
          transaction: tx,
        });
        if (!task) return;

        if (task.status === 'PENDING')
          await task.update({ status: 'RUNNING' }, { transaction: tx });
        else if (['PAUSED', 'CANCELED'].includes(task.status)) return;

        /* 현재 스텝 lock */
        const step = await TaskStep.findOne({
          where : { task_id: task.id, seq: task.current_seq },
          lock  : tx.LOCK.UPDATE, transaction: tx,
        });

        if (!step) {                      // 모든 step 완료
          await task.update({ status: 'DONE' }, { transaction: tx });
          return;
        }

        if (step.status === 'DONE') {
          await task.update({ current_seq: task.current_seq + 1 }, { transaction: tx });
          return;
        }
        if (step.status === 'FAILED') {
          await task.update({ status: 'FAILED' }, { transaction: tx });
          return;
        }

        if (step.status === 'PENDING')
          await step.update({ status: 'RUNNING' }, { transaction: tx });
      }
    ); /* ─ 트랜잭션 끝 (lock 해제) ─ */

    /* ── 트랜잭션 밖에서 실제 오래 걸리는 작업 수행 ───────── */
    const task = await Task.findOne({ where: { robot_id } });
    if (!task || task.status !== 'RUNNING') continue;

    const step = await TaskStep.findOne({
      where: { task_id: task.id, seq: task.current_seq },
    });
    if (!step || step.status !== 'RUNNING') continue;

    const robot = await Robot.findByPk(robot_id);

    try {
      await runStep(task, robot, step);
      await step.update({ status: 'DONE' });
      await task.update({ current_seq: task.current_seq + 1 });
    } catch (err) {
      console.error('[TaskStep]', err.message);
      const retry = (step.retry ?? 0) + 1;

      if (retry >= MAX_RETRY) {
        await step.update({ status: 'FAILED', retry });
        await task.update({ status: 'FAILED' });
      } else {
        await step.update({ status: 'PENDING', retry });
      }
    }
  }
}

/* ─────────────────── service lifecycle helpers ──────────────────── */
let timer = null;

function start () {
  if (!timer) timer = setInterval(tick, TICK_MS);
  console.log('▶ taskExecutorService started');
}

function stop () {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, enqueueTask };
