const Config = require('../models/Config');

/**
 * 관리자 패스워드 확인
 */
const verifyAdminPassword = async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ 
        success: false, 
        message: '패스워드를 입력해주세요.' 
      });
    }

    // DB에서 관리자 패스워드 조회
    const adminPasswordConfig = await Config.findOne({
      where: { key: 'adminPassword' }
    });

    const adminPassword = adminPasswordConfig 
      ? adminPasswordConfig.value 
      : 'admin123'; // 기본값

    if (password === adminPassword) {
      res.json({ 
        success: true, 
        message: '패스워드가 확인되었습니다.' 
      });
    } else {
      res.status(401).json({ 
        success: false, 
        message: '패스워드가 올바르지 않습니다.' 
      });
    }
  } catch (error) {
    console.error('패스워드 확인 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.' 
    });
  }
};

/**
 * 관리자 패스워드 변경
 */
const updateAdminPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: '현재 패스워드와 새 패스워드를 모두 입력해주세요.' 
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ 
        success: false, 
        message: '새 패스워드는 최소 6자 이상이어야 합니다.' 
      });
    }

    // 현재 패스워드 확인
    const adminPasswordConfig = await Config.findOne({
      where: { key: 'adminPassword' }
    });

    const currentAdminPassword = adminPasswordConfig 
      ? adminPasswordConfig.value 
      : 'admin123';

    if (currentPassword !== currentAdminPassword) {
      return res.status(401).json({ 
        success: false, 
        message: '현재 패스워드가 올바르지 않습니다.' 
      });
    }

    // 새 패스워드로 업데이트
    if (adminPasswordConfig) {
      await adminPasswordConfig.update({ value: newPassword });
    } else {
      await Config.create({
        key: 'adminPassword',
        value: newPassword,
        description: '관리자 패스워드',
        type: 'string'
      });
    }

    res.json({ 
      success: true, 
      message: '패스워드가 변경되었습니다.' 
    });
  } catch (error) {
    console.error('패스워드 변경 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.' 
    });
  }
};

/**
 * 설정 조회
 */
const getConfig = async (req, res) => {
  try {
    const { key } = req.params;
    
    const config = await Config.findOne({
      where: { key }
    });

    if (!config) {
      // 기본값 반환
      const defaultValues = {
        'adminPassword': 'admin123',
        'version': '1.0.0'
      };
      
      return res.json({ 
        success: true, 
        data: {
          key,
          value: defaultValues[key] || null,
          type: 'string'
        }
      });
    }

    // 패스워드는 값을 숨김
    if (key === 'adminPassword') {
      res.json({ 
        success: true, 
        data: {
          key: config.key,
          value: '*'.repeat(config.value.length),
          type: config.type,
          description: config.description
        }
      });
    } else {
      res.json({ 
        success: true, 
        data: config 
      });
    }
  } catch (error) {
    console.error('설정 조회 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.' 
    });
  }
};

/**
 * 모든 설정 조회 (패스워드 제외)
 */
const getAllConfigs = async (req, res) => {
  try {
    const configs = await Config.findAll({
      where: {
        key: { [require('sequelize').Op.ne]: 'adminPassword' }
      },
      order: [['key', 'ASC']]
    });

    res.json({ 
      success: true, 
      data: configs 
    });
  } catch (error) {
    console.error('설정 목록 조회 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.' 
    });
  }
};

/**
 * 시스템 정보 조회 (패스워드 없이)
 */
const getSystemInfo = async (req, res) => {
  try {
    const versionConfig = await Config.findOne({
      where: { key: 'version' }
    });

    res.json({
      success: true,
      data: {
        version: versionConfig ? versionConfig.value : '1.0.0',
        lastUpdated: new Date().toISOString(),
        hasPassword: true // 패스워드가 설정되어 있음을 알림
      }
    });
  } catch (error) {
    console.error('시스템 정보 조회 오류:', error);
    res.status(500).json({ 
      success: false, 
      message: '서버 오류가 발생했습니다.' 
    });
  }
};

module.exports = {
  verifyAdminPassword,
  updateAdminPassword,
  getConfig,
  getAllConfigs,
  getSystemInfo
}; 