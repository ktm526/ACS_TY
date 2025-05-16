// routes/healthRoutes.js
const router = require('express').Router();
const hc = require('../controllers/healthController');

router.get('/signals', hc.getSignals);
router.get('/signals/:type/:key', hc.getSignalDetail);
router.post('/signals/:type/:key/reconnect', hc.reconnectSignal);

module.exports = router;

