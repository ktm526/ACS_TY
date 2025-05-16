/* services/mapImportService.js */
const  Map  = require('../models/Map');

/* ─── 공통 유틸 ──────────────────────────── */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* advancedPointList / advancedCurveList 파싱 */
async function parseAdvanced(mapJson) {
    if (!Array.isArray(mapJson.advancedPointList))
        throw new Error('advancedPointList missing');

    const stations = mapJson.advancedPointList.map(p => ({
        id: p.instanceName,
        name: p.instanceName,
        x: p.pos.x,
        y: p.pos.y,
        property: p.property || {},
    }));

    const paths = [];
    if (Array.isArray(mapJson.advancedCurveList)) {
        mapJson.advancedCurveList.forEach(curve => {
            const [a, b] = curve.instanceName.split('-');
            const s = stations.find(v => v.id === a);
            const e = stations.find(v => v.id === b);
            if (!s || !e) return;
            paths.push({
                start: a, end: b,
                coordinates: { start: { x: s.x, y: s.y }, end: { x: e.x, y: e.y } },
                property: curve.property || {},
            });
        });
    }

    return Map.create({
        name: mapJson.header?.mapName || 'Unnamed Map',
        stations: JSON.stringify({ stations }),
        paths: JSON.stringify({ paths }),
        last_updated: new Date(),
        additional_info: JSON.stringify({
            header: mapJson.header,
            normalPosList: mapJson.normalPosList,
        }),
    });
}

/* nodes / edges 파싱 */
async function parseNodesEdges(json) {
    if (!Array.isArray(json.nodes) || !Array.isArray(json.edges))
        throw new Error('nodes / edges missing');

    const paths = json.edges.map(e => {
        const s = json.nodes.find(n => n.id === e.start);
        const t = json.nodes.find(n => n.id === e.end);
        if (!s || !t) return null;
        return {
            start: e.start, end: e.end,
            coordinates: { start: { x: s.x, y: s.y }, end: { x: t.x, y: t.y } },
        };
    }).filter(Boolean);

    return Map.create({
        name: json.mapName || 'Unnamed Map',
        stations: JSON.stringify({ stations: json.nodes }),
        paths: JSON.stringify({ paths }),
        last_updated: new Date(),
        additional_info: JSON.stringify({}),
    });
}

/* ─── 외부 노출 진입점 ───────────────────── */
exports.importMapJSON = async (jsonObj) => {
    // ① advancedPointList가 있으면 우선 적용
    if (Array.isArray(jsonObj.advancedPointList))
        return parseAdvanced(jsonObj);

    // ② 없으면 nodes/edges 방식 시도
    if (Array.isArray(jsonObj.nodes) && Array.isArray(jsonObj.edges))
        return parseNodesEdges(jsonObj);

    throw new Error('Unknown JSON map schema');
};
