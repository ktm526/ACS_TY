const net = require('net');
const Log = require('../models/Log');

let serial = 0;
function buildPacket(code, bodyObj = null) {
    const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : Buffer.alloc(0);
    const head = Buffer.alloc(16);
    head.writeUInt8(0x5A, 0);               // sync
    head.writeUInt8(0x01, 1);               // ver
    head.writeUInt16BE(++serial & 0xffff, 2);
    head.writeUInt32BE(body.length, 4);
    head.writeUInt16BE(code, 8);
    return Buffer.concat([head, body]);
}

function tcpRequest(ip, code, bodyObj) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(19206, ip);
        const pkt = buildPacket(code, bodyObj);
        let buf = Buffer.alloc(0);

        sock.once('connect', () => sock.write(pkt));
        sock.on('data', c => (buf = Buffer.concat([buf, c])));
        sock.once('close', () => {
            // 16바이트 헤더 이후가 JSON
            if (buf.length <= 16) return reject(new Error('empty payload'));
            try { return resolve(JSON.parse(buf.slice(16).toString())); }
            catch (e) { return reject(new Error('invalid JSON')); }
        });
        sock.once('error', reject);
        sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
    });
}

/* 1300 → 맵 목록 */
exports.queryMaps = async (ip) => {
    const res = await tcpRequest(ip, 0x0514);
    console.log('queryMaps')
    await Log.create({ type: 'ROBOT_MAP_LIST', message: JSON.stringify(res) });
    return res;
};

/* 4011 → 개별 맵 다운로드 */
exports.downloadMap = async (ip, mapName) => {
    const res = await tcpRequest(ip, 0x0FAB, { map_name: mapName });
    // 성공 시 res 가 “전체 맵 JSON”, 실패 시 {err_msg,…}
    console.log('downloadMaps')

    await Log.create({ type: 'ROBOT_MAP_FETCH', message: JSON.stringify({ mapName, ok: !res.err_msg }) });
    return res;
};
