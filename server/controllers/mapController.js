const Map = require('../models/Map');

exports.getAll = (_, res) => Map.findAll().then(r => res.json(r));
exports.getById = (req, res) => Map.findByPk(req.params.id).then(r => r ? res.json(r) : res.sendStatus(404));
exports.create = (req, res) => Map.create(req.body).then(r => res.status(201).json(r));
exports.update = (req, res) => Map.update(req.body, { where: { id: req.params.id } })
    .then(([n]) => n ? res.sendStatus(204) : res.sendStatus(404));
exports.remove = (req, res) => Map.destroy({ where: { id: req.params.id } })
    .then(n => n ? res.sendStatus(204) : res.sendStatus(404));
