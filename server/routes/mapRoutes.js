// server/routes/mapRoutes.js
const express = require('express');
const Map = require('../models/Map');

const router = express.Router();

/* ───────── 기본 CRUD ───────────────────── */
router.get('/', async (_, res) => {
    try {
        const rows = await Map.findAll();
        res.json(rows);                       // 배열 반환
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

router.get('/:id', async (req, res) => {
    const row = await Map.findByPk(req.params.id);
    row ? res.json(row) : res.sendStatus(404);
});

router.post('/', async (req, res) => {
    try {
        const row = await Map.create(req.body);
        res.status(201).json(row);
    } catch (e) {
        res.status(400).json({ msg: e.message });
    }
});

/* PUT /api/maps/current   { mapId:number } */
router.put('/current', async (req, res) => {
    const { mapId } = req.body;
    if (!mapId) return res.sendStatus(400);
    await Map.update({ is_current: false }, { where: {} });
    await Map.update({ is_current: true }, { where: { id: mapId } });
    res.json({ success: true });
});

router.put('/:id', async (req, res) => {
    const n = await Map.update(req.body, { where: { id: req.params.id } });
    n[0] ? res.sendStatus(204) : res.sendStatus(404);
});

router.delete('/:id', async (req, res) => {
    const n = await Map.destroy({ where: { id: req.params.id } });
    n ? res.sendStatus(204) : res.sendStatus(404);
});

/* ───────── 스테이션/클래스 수정 ────────────
   PUT /api/maps/:id/stations
   body: { stations: [...] }                                          */
router.put('/:id/stations', async (req, res) => {
    try {
        const map = await Map.findByPk(req.params.id);
        if (!map) return res.sendStatus(404);

        await map.update({
            stations: JSON.stringify({ stations: req.body.stations }),
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ msg: e.message });
    }
});




module.exports = router;
