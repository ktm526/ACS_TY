/* routes/mapUploadRoutes.js */
const express = require('express');
const multer = require('multer');
const { importMapJSON } = require('../services/mapImportService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/*  POST /api/maps/import
    - FormData field: mapFile ( .smap | .json )  */
router.post(
    '/import',
    upload.single('mapFile'),
    async (req, res) => {
        try {
            /* 0️⃣ 파일 체크 */
            if (!req.file) {
                console.warn('🛑 0: mapFile 미포함');
                return res.status(400).json({ success: false, msg: 'mapFile is required' });
            }

            /* 1️⃣ 기본 정보 */
            const { originalname, size } = req.file;
            console.log(`📥 1: 업로드 수신  →  ${originalname}  (${size} bytes)`);

            /* 2️⃣ JSON 파싱 */
            let jsonObj;
            try {
                jsonObj = JSON.parse(req.file.buffer.toString('utf8'));
                console.log('✅ 2: JSON 파싱 성공');
            } catch (e) {
                console.error('🛑 2: JSON 파싱 실패', e.message);
                return res.status(400).json({ success: false, msg: 'invalid JSON' });
            }

            /* 3️⃣ 스키마 감지 & DB 저장 */
            let created;
            try {
                created = await importMapJSON(jsonObj);
                console.log(`✅ 3: DB 저장 완료  [id=${created.id}]`);
            } catch (e) {
                console.error('🛑 3: transform 실패', e.message);
                return res.status(400).json({ success: false, msg: e.message });
            }

            /* 4️⃣ 완료 */
            console.log('🎉 4: 업로드 프로세스 정상 종료');
            res.status(201).json({ success: true, data: created });

        } catch (e) {
            console.error('💥 5: 예기치 못한 오류', e);
            res.status(500).json({ success: false, msg: e.message });
        }
    }
);

module.exports = router;
