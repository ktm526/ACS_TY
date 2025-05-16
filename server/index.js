// server/index.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const sequelize = require('./config/db');
const app = express();

/* ── ① 공통 미들웨어 ─────────────────────────────── */
app.use(cors({ origin: '*' }));
app.use(express.json());

/* ── ② API 라우트 ───────────────────────────────── */
app.use('/api/maps', require('./routes/mapRoutes'));
app.use('/api/maps', require('./routes/mapUploadRoutes'));
app.use('/api/robots', require('./routes/robotRoutes'));
app.use('/api/logs', require('./routes/logRoutes'));
app.use('/api/dispatch', require('./routes/dispatchRoutes'));
app.use('/api/tasks', require('./routes/taskRoutes'));
app.use('/api/health', require('./routes/healthRoutes'));

/* ── ③ 정적 파일 (프런트) ───────────────────────── */
app.use(express.static(path.join(__dirname, 'dist')));
app.get('/', (_, res) =>
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
);

/* ── ④ Bootstrap ───────────────────────────────── */
(async () => {
  try {
    /* 0) 혹시 남아 있을 임시 backup 테이블 정리 ------------ */
    const qi = sequelize.getQueryInterface();
    const backupTables = [
      'Robots_backup', 'Logs_backup',
      'Tasks_backup', 'TaskSteps_backup',
    ];
    for (const t of backupTables) {
      /* 존재하지 않으면 DROP 시 에러가 나므로 try/catch */
      await qi.dropTable(t).catch(() => { });
    }

    /* 1) 실제 테이블 자동 생성/변경 ----------------------- */
    //await sequelize.sync({ force: true });
    await sequelize.sync();

    console.log('✅ DB synced');

    /* 2) 서비스 모듈 로드 ------------------------------- */
    require('./services/amrMonitorService');
    require('./services/taskExecutorService').start();
    require('./services/dispatcherService');

    /* 3) HTTP 서버 리스닝 ------------------------------- */
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => console.log(`🚀 API ready on :${PORT}`));
  } catch (err) {
    console.error('❌ bootstrap failed:', err);
    process.exit(1);
  }
})();

/* ── graceful shutdown ─────────────────────────── */
process.on('SIGINT', () => { console.log('\nSIGINT'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nSIGTERM'); process.exit(0); });
