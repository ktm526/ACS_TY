const express = require('express');
const c = require('../controllers/robotController');
const mapRt = require('./robotMapRoutes');
const router = express.Router();
const motionC = require('../controllers/motionController');
const jackC = require('../controllers/jackController');
const tc = require('../controllers/taskController');   // ★ 추가

router.get('/', c.getAll);
router.get('/:id', c.getById);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/', c.removeAll);
router.delete('/:id', c.remove);
router.post('/:id/move', c.moveToStation);
router.use('/:id', mapRt);
router.post('/:id/motion', motionC.openLoop);

router.post('/:id/jack/height', jackC.setHeight);
router.post('/:id/jack/load', jackC.load);
router.post('/:id/jack/unload', jackC.unload);
router.post('/:id/jack/stop', jackC.stop);

router.get('/:id/current-task', tc.currentOfRobot);           // <<<  추가


module.exports = router;
 