// services/robotMotionService.js
const net = require('net');

let serial = 0;
function buildPacket(code, obj = {}) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(16);
    head.writeUInt8(0x5A, 0);                     // sync
    head.writeUInt8(0x01, 1);                     // version
    head.writeUInt16BE(++serial & 0xffff, 2);     // serial
    head.writeUInt32BE(body.length, 4);           // body length
    head.writeUInt16BE(code, 8);                  // API number
    // bytes 10–15 left as 0
    return Buffer.concat([head, body]);
}

/**
 * Open Loop Motion 요청을 로봇에 TCP로 전송하고,
 * 응답(JSON) 을 Promise로 반환합니다.
 *
 * @param {string} ip 로봇 IP
 * @param {{vx:number,vy:number,w:number,duration:number}} params
 */
function sendOpenLoopMotion(ip, { vx, vy, w, duration }) {
    return new Promise((resolve, reject) => {
        const PORT = 19205;
        const socket = net.createConnection(PORT, ip, () => {
            // API number 0x07DA == 2010
            const packet = buildPacket(0x07DA, { vx, vy, w, duration });
            socket.write(packet);
        });

        let buf = Buffer.alloc(0);
        socket.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
        });

        socket.once('close', () => {
            // 헤더(16바이트) 이후가 JSON
            if (buf.length <= 16) {
                return reject(new Error('Empty response from robot'));
            }
            try {
                const json = JSON.parse(buf.slice(16).toString());
                resolve(json);
            } catch (e) {
                reject(new Error('Invalid JSON from robot'));
            }
        });

        socket.on('error', err => {
            reject(err);
        });

        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error('TCP timeout'));
        });
    });
}

module.exports = { sendOpenLoopMotion };
