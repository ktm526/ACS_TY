const net = require('net');
const { Op } = require('sequelize');
const Robot = require('../models/Robot');

// AMR Push Monitoring Service
// - Listens on TCP port for robot push data
// - Updates Robot table and tracks last received timestamp per robot

const PUSH_PORT = 19301;
const sockets = new Map();
const lastRecTime = new Map();

async function markDisconnectedByIp(ip) {
    try {
        await Robot.update(
            { status: '연결 안됨', timestamp: new Date() },
            { where: { ip } }
        );
    } catch (e) {
        console.error('[AMR] markDisconnectedByIp error:', e.message);
    }
}

async function markDisconnectedByName(name) {
    try {
        await Robot.update(
            { status: '연결 안됨', timestamp: new Date() },
            { where: { name } }
        );
    } catch (e) {
        console.error('[AMR] markDisconnectedByName error:', e.message);
    }
}

function handlePush(sock, ip) {
    let buf = Buffer.alloc(0);

    sock.on('data', async chunk => {
        buf = Buffer.concat([buf, chunk]);
        console.log('ip====',ip)

        while (buf.length >= 16) {
            if (buf.readUInt8(0) !== 0x5A) {
                buf = Buffer.alloc(0);
                break;
            }
            const len = buf.readUInt32BE(4);
            if (buf.length < 16 + len) break;

            const payload = buf.slice(16, 16 + len).toString();
            buf = buf.slice(16 + len);

            let json;
            try { json = JSON.parse(payload);
                console.log(ip, json.vehicle_id)
             }
            catch(err) { console.log('failed to json', ip, err, payload);continue; }

            const name = json.vehicle_id || json.robot_id;
            if (!name) continue;

            // Map task_status → Korean
            const tsRaw = typeof json.task_status === 'number'
                ? json.task_status
                : typeof json.taskStatus === 'number'
                    ? json.taskStatus
                    : null;
            let statusStr;
            if (tsRaw === 2) statusStr = '이동';
            else if ([0, 1, 4].includes(tsRaw)) statusStr = '대기';
            else if ([5, 6].includes(tsRaw)) statusStr = '오류';
            else statusStr = 'unknown';

            // extract other fields...
            const location = json.current_station || json.currentStation ||
                (Array.isArray(json.finished_path)
                    ? json.finished_path.slice(-1)[0]
                    : null
                );
            const battery = typeof json.battery_level === 'number'
                ? json.battery_level * 100 : null;
            const voltage = typeof json.voltage === 'number'
                ? json.voltage : null;
            const currentMap = json.current_map || null;
            const pos = {
                x: json.x ?? json.position?.x ?? 0,
                y: json.y ?? json.position?.y ?? 0,
                angle: json.angle ?? json.position?.yaw ?? 0,
            };

            const payloadForDb = {
                name,
                status: statusStr,
                location,
                next_location: json.next_station || json.nextStation || null,
                task_step: json.task_step || json.taskStep || null,
                battery, voltage, current_map: currentMap,
                position: JSON.stringify(pos),
                additional_info: JSON.stringify(json),
                timestamp: new Date(),
            };

            try {
                const existing = await Robot.findOne({ where: { ip } });
                if (existing) {
                    await existing.update(payloadForDb);
                }
                lastRecTime.set(name, Date.now());
            } catch (e) {
                console.error('[AMR Push] DB save error:', e.message);
            }
        }
    });

    sock.on('error', async err => {
        console.warn(`[AMR] socket error on ${ip}:`, err.message);
        sock.destroy();
        sockets.delete(ip);
        await markDisconnectedByIp(ip);
    });

    sock.on('close', () => {
        console.warn(`[AMR] connection closed ${ip}`);
        sockets.delete(ip);
        markDisconnectedByIp(ip);
    });
}

async function connect(ip) {
    if (sockets.has(ip)) return;
    const sock = net.createConnection({ port: PUSH_PORT, host: ip });
    sock.setTimeout(2000);

    sock.on('error', async err => {
        console.warn(`[AMR] connect error ${ip}:`, err.message);
        sock.destroy();
        sockets.delete(ip);
        await markDisconnectedByIp(ip);
    });

    sock.on('connect', () => {
        console.log(`[AMR] connected to ${ip}`);
        sockets.set(ip, sock);
        sock.setTimeout(0);
        handlePush(sock, ip);
    });

    sock.on('timeout', async () => {
        console.warn(`[AMR] timeout on ${ip}`);
        sock.destroy();
        sockets.delete(ip);
        await markDisconnectedByIp(ip);
    });
}

// reconnect loop
let connecting = false;
setInterval(async () => {
    if (connecting) return;
    connecting = true;
    try {
        const rows = await Robot.findAll({
            where: { ip: { [Op.not]: null } },
            attributes: ['ip'],
            raw: true,
        });
        for (const { ip } of rows) {
            await connect(ip);
        }
    } catch (e) {
        console.error('[AMR] connect loop error:', e.message);
    } finally {
        connecting = false;
    }
}, 2000);

// stale‐entry cleanup
setInterval(async () => {
    const now = Date.now();
    for (const [name, ts] of lastRecTime.entries()) {
        if (now - ts > 2000) {
            console.warn(`[AMR] stale entry expired for ${name}`);
            lastRecTime.delete(name);
            // DB 상태 업데이트
            await markDisconnectedByName(name);

            // 해당 로봇의 IP로 소켓도 강제 종료 → 재접속 유도
            try {
                const robot = await Robot.findOne({ where: { name } });
                if (robot && robot.ip && sockets.has(robot.ip)) {
                    sockets.get(robot.ip).destroy();
                    sockets.delete(robot.ip);
                    console.log(`[AMR] socket destroyed for ${name} (${robot.ip})`);
                }
            } catch (e) {
                console.error(`[AMR] error destroying socket for ${name}:`, e.message);
            }
        }
    }
}, 1000);

async function reconnectAmr(name) {
    const robot = await Robot.findOne({ where: { name } });
    if (!robot || !robot.ip) throw new Error('AMR not found');
    const ip = robot.ip;
    if (sockets.has(ip)) {
        sockets.get(ip).destroy();
        sockets.delete(ip);
    }
    await connect(ip);
}

console.log('🔧 AMR Monitor Service started');
module.exports = {
    lastRecTime, sockets,
    reconnectAmr,
};
