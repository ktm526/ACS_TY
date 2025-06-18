// 설정 관리 유틸리티 - API 기반
const API_BASE_URL = import.meta.env.VITE_CORE_BASE_URL || 'http://localhost:4000';
const CONFIG_API = `${API_BASE_URL}/api/config`;

let configCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5분

/**
 * API에서 시스템 정보를 가져옵니다
 */
export const fetchSystemInfo = async () => {
  const now = Date.now();
  
  // 캐시가 유효한 경우 캐시된 값 반환
  if (configCache && (now - lastFetchTime) < CACHE_DURATION) {
    return configCache;
  }

  try {
    const response = await fetch(`${CONFIG_API}/system/info`);
    if (!response.ok) {
      throw new Error(`System info fetch failed: ${response.status}`);
    }
    
    const result = await response.json();
    if (!result.success) {
      throw new Error(result.message || 'API 응답 실패');
    }
    
    // 캐시 업데이트
    configCache = result.data;
    lastFetchTime = now;
    
    return result.data;
  } catch (error) {
    console.warn('시스템 정보 조회 실패:', error);
    
    // 실패 시 기본값 반환
    return {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      hasPassword: true
    };
  }
};

/**
 * 관리자 패스워드를 확인합니다
 */
export const verifyAdminPassword = async (password) => {
  try {
    const response = await fetch(`${CONFIG_API}/verify-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password })
    });
    
    const result = await response.json();
    return {
      success: result.success,
      message: result.message
    };
  } catch (error) {
    console.error('패스워드 확인 실패:', error);
    return {
      success: false,
      message: '서버 연결에 실패했습니다.'
    };
  }
};

/**
 * 관리자 패스워드를 변경합니다
 */
export const updateAdminPassword = async (currentPassword, newPassword) => {
  try {
    const response = await fetch(`${CONFIG_API}/admin-password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        currentPassword, 
        newPassword 
      })
    });
    
    const result = await response.json();
    
    // 성공 시 캐시 무효화
    if (result.success) {
      configCache = null;
      lastFetchTime = 0;
    }
    
    return {
      success: result.success,
      message: result.message
    };
  } catch (error) {
    console.error('패스워드 변경 실패:', error);
    return {
      success: false,
      message: '서버 연결에 실패했습니다.'
    };
  }
};

/**
 * 특정 설정값을 조회합니다
 */
export const getConfig = async (key) => {
  try {
    const response = await fetch(`${CONFIG_API}/${key}`);
    if (!response.ok) {
      throw new Error(`Config fetch failed: ${response.status}`);
    }
    
    const result = await response.json();
    return result.success ? result.data : null;
  } catch (error) {
    console.warn(`설정 조회 실패 (${key}):`, error);
    return null;
  }
};

/**
 * 모든 설정을 조회합니다 (패스워드 제외)
 */
export const getAllConfigs = async () => {
  try {
    const response = await fetch(`${CONFIG_API}/`);
    if (!response.ok) {
      throw new Error(`Configs fetch failed: ${response.status}`);
    }
    
    const result = await response.json();
    return result.success ? result.data : [];
  } catch (error) {
    console.warn('설정 목록 조회 실패:', error);
    return [];
  }
};

/**
 * 설정을 강제로 새로고침합니다
 */
export const refreshConfig = () => {
  configCache = null;
  lastFetchTime = 0;
  return fetchSystemInfo();
};

/**
 * 캐시된 설정이 있는지 확인합니다
 */
export const hasCachedConfig = () => {
  return configCache !== null;
};

// 하위 호환성을 위한 래퍼 함수들
export const fetchConfig = fetchSystemInfo;
export const getAdminPassword = async () => {
  // 이 함수는 보안상 실제 패스워드를 반환하지 않습니다
  // verifyAdminPassword를 사용하세요
  console.warn('getAdminPassword는 보안상 더 이상 지원되지 않습니다. verifyAdminPassword를 사용하세요.');
  return null;
}; 