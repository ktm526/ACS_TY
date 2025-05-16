const express = require('express');
const c = require('../controllers/robotMapController');
const router = express.Router({ mergeParams: true });

router.get('/maps', c.list);          // GET /api/robots/:id/maps
router.get('/maps/:mapName', c.download);      // GET /api/robots/:id/maps/:mapName

module.exports = router;
