// services/robotJackService.js
const net = require('net');

let serial = 0;
/**
 * Build a TCP packet for the jack API protocol:
 *  - 16-byte header:
 *      byte 0:  0x5A
 *      byte 1:  0x01
 *      bytes 2–3: 16-bit serial (incrementing, wraps at 0xffff)
 *      bytes 4–7: 32-bit big-endian body length
 *      bytes 8–9: 16-bit request code
 *      bytes 10–15: zeros
 *  - body: UTF-8 JSON text (double-quoted keys) if obj != null, else empty
 *
 * @param {number} code   16-bit API request code (e.g. 0x17B9)
 * @param {object|null} obj  payload object or null
 * @returns {Buffer}
 */
function buildPacket(code, obj = null) {
    // prepare JSON body (always stringify so keys are double-quoted)
    const body = obj !== null
      ? Buffer.from(JSON.stringify(obj), 'utf8')
      : Buffer.alloc(0);
  
    // header is always 16 bytes
    const head = Buffer.alloc(16);
    head.writeUInt8(0x5A, 0);                // sync byte
    head.writeUInt8(0x01, 1);                // version/flag
    head.writeUInt16BE(++serial & 0xffff, 2); // serial number
    head.writeUInt32BE(body.length, 4);      // body length
    head.writeUInt16BE(code, 8);             // API code
    // bytes 10–15 are left as zeros by Buffer.alloc
  
    return Buffer.concat([head, body]);
  }
  

/**
 * Send a jack command to robot
 * @param {string} ip
 * @param {number} apiReqCode 16-bit request code (e.g. 0x17B9)
 * @param {object|null} payload JSON body or null
 * @returns {Promise<object>} parsed response JSON
 */
function sendJackCommand(ip, apiReqCode, payload = null) {
    const PORT = 19210;
    return new Promise((resolve, reject) => {
        console.log(payload)
        const socket = net.createConnection(PORT, ip, () => {
            const pkt = buildPacket(apiReqCode, payload);
            socket.write(pkt);
        });

        let buf = Buffer.alloc(0);
        socket.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
        });

        socket.once('close', () => {
            if (buf.length <= 16) return reject(new Error('Empty response from robot'));
            try {
                const json = JSON.parse(buf.slice(16).toString());
                resolve(json);
            } catch (err) {
                reject(new Error('Invalid JSON response'));
            }
        });

        socket.on('error', err => reject(err));
        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error('TCP timeout'));
        });
    });
}

module.exports = { sendJackCommand };
