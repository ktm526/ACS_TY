// services/navService.js
const net = require('net');
let _serial = 0;

function _buildPkt(code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt8(0x5A, 0);
  head.writeUInt8(0x01, 1);
  head.writeUInt16BE(++_serial & 0xffff, 2);
  head.writeUInt32BE(body.length, 4);
  head.writeUInt16BE(code, 8);
  return Buffer.concat([head, body]);
}

function sendGotoNav(ip, dest, src, taskId) {
  return new Promise((ok, ng) => {
    const sock = net.createConnection(19206, ip);
    const bye  = () => sock.destroy();

    sock.once('connect', () => {
      sock.write(_buildPkt(0x0BEB, { id: String(dest), source_id: String(src), task_id: taskId }), () => {
        bye(); ok();
      });
    });
    sock.once('error', e   => { bye(); ng(e); });
    sock.setTimeout(5000, () => { bye(); ng(new Error('timeout')); });
  });
}

module.exports = { sendGotoNav };
