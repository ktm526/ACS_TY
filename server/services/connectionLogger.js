/**
 * 통합 연결 상태 로거
 *  ───────────────────────────────
 *  key         : 'AMR:192.168.0.3' | 'AMR:ELLO-01' | 'RIO:192.168.0.5'
 *  connected   : boolean (true=conn, false=disconn)
 *  meta        : { robot_name, detail … }  // Log 모델 필드 그대로 전달 가능
 */
const Log = require('../models/Log');

const _prev = new Map();      // key → lastConnected(true/false)

async function logConnChange(key, connected, meta = {}) {
    const last = _prev.get(key);
    if (last === undefined) {                // 첫 호출이면 상태만 기억
        _prev.set(key, connected);
        return;
    }
    if (last !== connected) {                // 상태 변동 시에만 기록
        _prev.set(key, connected);
        const status = connected ? 'conn' : 'disconn';
        try {
            await Log.create({
                type: 'CONN',
                message: key,          // ex) 'AMR:ELLO-01'
                status,                // 'conn' | 'disconn'
                ...meta,               // 필요 시 robot_name 등 추가
            });
        } catch (e) {
            console.error('[ConnLog]', e.message);
        }
    }
}

module.exports = { logConnChange };
