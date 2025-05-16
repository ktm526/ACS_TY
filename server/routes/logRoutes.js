//logroutes
const express = require('express');
const c = require('../controllers/logController');
const router = express.Router();

router.get('/', c.getAll);
router.get('/:id', c.getById);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
