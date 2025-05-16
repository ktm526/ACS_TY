const  Robot  = require('../models/Robot');
const mapSvc = require('../services/robotMapService');

exports.list = async (req, res) => {
    try {
        const robot = await Robot.findByPk(req.params.id);
        if (!robot) return res.sendStatus(404);
        const data = await mapSvc.queryMaps(robot.ip);
        res.json(data);
    } catch (e) { res.status(500).json({ msg: e.message }); }
};

exports.download = async (req, res) => {
    try {
        const robot = await Robot.findByPk(req.params.id);
        if (!robot) return res.sendStatus(404);
        const data = await mapSvc.downloadMap(robot.ip, req.params.mapName);
        if (data.err_msg) return res.status(400).json(data);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=${req.params.mapName}.json`);
        res.end(JSON.stringify(data));
    } catch (e) { res.status(500).json({ msg: e.message }); }
};
