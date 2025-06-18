import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Card,
  Space,
  Button,
  Badge,
  Tag,
  Typography,
  message,
  Divider,
  Collapse,
  Progress,
  Alert,
  Spin,
  FloatButton,
  Drawer,
} from "antd";
import { 
  ReloadOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  BellOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  PlusOutlined,
  MinusOutlined,
  AimOutlined,
  EnvironmentOutlined,
  CarOutlined,
  MenuOutlined,
} from "@ant-design/icons";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAtomValue, useAtom } from "jotai";
import { robotsQueryAtom, mapsQueryAtom, selectedMapAtom } from "@/state/atoms";
import arrowIcon from "@/assets/arrow.png";

const { Text, Title } = Typography;
const { Panel } = Collapse;
const API = import.meta.env.VITE_CORE_BASE_URL;
const ICON_MM = { width: 800, height: 1200 };

// 상태 매핑
const STATUS_BADGE = {
  이동: "processing",
  대기: "success", 
  충전: "warning",
  수동: "default",
  오류: "error",
  "연결 끊김": "error",
  unknown: "default",
};

const STATUS_TAG_COLOR = {
  이동: "blue",
  대기: "green",
  충전: "orange", 
  수동: "purple",
  오류: "red",
  "연결 끊김": "gray",
  unknown: "default",
};

const STATUS_BORDER_COLOR = {
  이동: "#007AFF", // 애플 시스템 블루
  대기: "#34C759", // 애플 시스템 그린
  충전: "#FF9500", // 애플 시스템 오렌지
  수동: "#AF52DE", // 애플 시스템 퍼플
  오류: "#FF3B30", // 애플 시스템 레드
  "연결 끊김": "#8E8E93", // 애플 시스템 그레이
  unknown: "#C7C7CC",
};

// 안전한 JSON 파싱 - 메모이제이션
const parseCache = new Map();
const MAX_CACHE_SIZE = 100; // 캐시 최대 크기 제한

function safeParse(raw, fallback = {}) {
  if (raw == null) return fallback;
  
  // 캐시 체크
  if (parseCache.has(raw)) {
    return parseCache.get(raw);
  }
  
  let v = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    // 캐시 크기 제한
    if (parseCache.size >= MAX_CACHE_SIZE) {
      const firstKey = parseCache.keys().next().value;
      parseCache.delete(firstKey);
    }
    parseCache.set(raw, fallback);
    return fallback;
  }
  
  const result = v ?? fallback;
  // 캐시 크기 제한
  if (parseCache.size >= MAX_CACHE_SIZE) {
    const firstKey = parseCache.keys().next().value;
    parseCache.delete(firstKey);
  }
  parseCache.set(raw, result);
  return result;
}

export default function MobileStatus() {
  const [messageApi, contextHolder] = message.useMessage();
  const [pulseTime, setPulseTime] = useState(0);
  const [followingRobot, setFollowingRobot] = useState(null);
  const [robotListVisible, setRobotListVisible] = useState(false);
  const [robotsExpanded, setRobotsExpanded] = useState({});
  
  // 지도 관련 상태
  const mapsQ = useAtomValue(mapsQueryAtom);
  const robotsQ = useAtomValue(robotsQueryAtom);
  const [selMap, setSelMap] = useAtom(selectedMapAtom);
  const maps = mapsQ.data ?? [];
  const robots = robotsQ.data ?? [];
  
  // 캔버스 관련
  const contRef = useRef(null);
  const canvRef = useRef(null);
  const animationRef = useRef(null);
  const lastDrawTime = useRef(0);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [sf, setSf] = useState(1);
  const [robotImg, setRobotImg] = useState(null);
  
  // 터치 상태
  const [drag, setDrag] = useState(false);
  const [last, setLast] = useState({ x: 0, y: 0 });
  const [lastTouchDistance, setLastTouchDistance] = useState(0);
  
  // 신호 상태 데이터 - 폴링 간격 증가
  const { data: signalData, error: signalError, isLoading: signalLoading } = useQuery({
    queryKey: ["signals"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/health/signals`);
      if (!res.ok) throw new Error("네트워크 오류");
      return res.json();
    },
    refetchInterval: 5000, // 2초 → 5초로 증가
    retry: false,
    staleTime: 3000, // 캐시 시간 추가
  });

  // 알람 끄기 뮤테이션
  const alarmOffMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/dispatch/rio-register17`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: 0 }),
      });
      if (!res.ok) {
        throw new Error("알람 끄기 실패");
      }
      return res.json();
    },
    onSuccess: () => {
      messageApi.success("알람이 꺼졌습니다");
    },
    onError: (error) => {
      messageApi.error(`알람 끄기 실패: ${error.message}`);
    },
  });

  // AMR 상태 판단 함수 - 메모이제이션
  const getAmrStatus = useCallback((amr) => {
    if (amr.status === '연결 끊김') {
      return '연결 끊김';
    }
    
    let additionalInfo = {};
    try {
      additionalInfo = typeof amr.additional_info === 'string' 
        ? JSON.parse(amr.additional_info) 
        : amr.additional_info || {};
    } catch (e) {}
    
    const diSensors = additionalInfo.diSensors || [];
    const sensor11 = diSensors.find(s => s.id === 11);
    if (sensor11?.status === true) {
      return '수동';
    }
    
    if (additionalInfo.charging === true) {
      return '충전';
    }
    
    return amr.status || 'unknown';
  }, []);

  // 로봇 이미지 로드
  useEffect(() => {
    const img = new Image();
    img.src = arrowIcon;
    img.onload = () => setRobotImg(img);
    img.onerror = () => console.error("🚨 arrow.png 로드 실패:", arrowIcon);
  }, []);

  // 캔버스 DPI 대응 - 디바운스 추가
  const fitCanvas = useCallback(() => {
    if (!contRef.current || !canvRef.current) return;
    const rect = contRef.current.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // DPR 제한
    const c = canvRef.current;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = `${rect.width}px`;
    c.style.height = `${rect.height}px`;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  useEffect(() => {
    fitCanvas();
    let timeoutId;
    const debouncedFitCanvas = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(fitCanvas, 100); // 디바운스 100ms
    };
    window.addEventListener("resize", debouncedFitCanvas);
    return () => {
      window.removeEventListener("resize", debouncedFitCanvas);
      clearTimeout(timeoutId);
    };
  }, [fitCanvas]);

  // 지도 변경 시 뷰 초기화
  useEffect(() => {
    if (!contRef.current || !selMap) return;
    const hdr = safeParse(selMap.additional_info).header || {};
    const { minPos, maxPos, resolution } = hdr;
    if (!minPos || !maxPos) return;
    const midX = (minPos.x + maxPos.x) / 2;
    const midY = (minPos.y + maxPos.y) / 2;
    const rect = contRef.current.getBoundingClientRect();
    const nSf = resolution ? 1 / resolution : 1;
    setSf(nSf);
    setScale(1);
    setOffset({
      x: rect.width / 2 - midX * nSf,
      y: rect.height / 2 - midY * nSf,
    });
  }, [selMap]);

  // 좌표 변환 - 메모이제이션
  const transform = useCallback((x, y) => {
    const h = contRef.current?.getBoundingClientRect().height || 0;
    return {
      x: x * sf * scale + offset.x,
      y: h - (y * sf * scale + offset.y),
    };
  }, [sf, scale, offset]);

  // 지도 데이터 메모이제이션
  const mapData = useMemo(() => {
    if (!selMap) return { stations: [], paths: [], normalPoints: [], normals: [] };
    
    const stations = safeParse(selMap.stations).stations ?? [];
    const paths = safeParse(selMap.paths).paths ?? [];
    const normalPoints = safeParse(selMap.additional_info).normalPointList ?? [];
    const normals = safeParse(selMap.additional_info).normalPosList ?? [];
    
    return { stations, paths, normalPoints, normals };
  }, [selMap]);

  // 펄스 애니메이션 최적화 - 필요할 때만 실행
  const needsAnimation = useMemo(() => {
    return robots.some(robot => {
      const status = getAmrStatus(robot);
      return ['연결 끊김', '오류', '충전', '이동'].includes(status);
    });
  }, [robots, getAmrStatus]);

  useEffect(() => {
    if (!needsAnimation) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return;
    }

    let lastTime = 0;
    const frameInterval = 1000 / 15; // 30fps → 15fps로 줄임
    
    const animate = (currentTime) => {
      if (currentTime - lastTime >= frameInterval) {
        setPulseTime(currentTime);
        lastTime = currentTime;
      }
      animationRef.current = requestAnimationFrame(animate);
    };
    
    animationRef.current = requestAnimationFrame(animate);
    
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [needsAnimation]);

  // 펄스 효과 결정 - 메모이제이션
  const getPulseEffect = useCallback((robot) => {
    const status = getAmrStatus(robot);
    
    if (status === '연결 끊김') {
      return { color: '#ff4d4f', shouldPulse: true };
    }
    if (status === '오류') {
      return { color: '#ff4d4f', shouldPulse: true };
    }
    if (status === '충전') {
      return { color: '#faad14', shouldPulse: true };
    }
    if (status === '이동') {
      return { color: '#1890ff', shouldPulse: true };
    }
    
    return { shouldPulse: false };
  }, [getAmrStatus]);

  // 캔버스 그리기 최적화 - 프레임 제한
  const draw = useCallback(() => {
    const now = Date.now();
    if (now - lastDrawTime.current < 33) return; // 30fps 제한
    lastDrawTime.current = now;

    const c = canvRef.current;
    if (!c || !selMap) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    const { stations, paths, normalPoints, normals } = mapData;
    
    // normalPointList 그리기
    if (normalPoints.length > 0) {
      ctx.fillStyle = "#007AFF";
      ctx.beginPath();
      normalPoints.forEach((pt) => {
        const p = transform(pt.x, pt.y);
        ctx.moveTo(p.x + 2, p.y);
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      });
      ctx.fill();
    }

    // 기존 normalPosList 그리기
    if (normals.length > 0) {
      ctx.fillStyle = "#000";
      normals.forEach((pt) => {
        const q = transform(pt.x, pt.y);
        ctx.fillRect(q.x, q.y, 1, 1);
      });
    }
    
    // 경로 그리기
    if (paths.length > 0) {
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 2;
      ctx.beginPath();
      paths.forEach((p) => {
        let s = p.coordinates?.start;
        let e = p.coordinates?.end;
        if (!s || !e) {
          s = stations.find((st) => String(st.id) === String(p.start));
          e = stations.find((st) => String(st.id) === String(p.end));
        }
        if (!s || !e) return;
        const sp = transform(s.x, s.y);
        const ep = transform(e.x, e.y);
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(ep.x, ep.y);
      });
      ctx.stroke();
    }

    // 스테이션 그리기
    const rPix = Math.max(8, (ICON_MM.width / 1000) * sf * scale / 6);
    if (stations.length > 0) {
      ctx.fillStyle = "#ffa500";
      ctx.font = `${Math.max(10, 12 * scale)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      
      ctx.beginPath();
      stations.forEach((st) => {
        const p = transform(st.x, st.y);
        ctx.moveTo(p.x + rPix, p.y);
        ctx.arc(p.x, p.y, rPix, 0, Math.PI * 2);
      });
      ctx.fill();
      
      ctx.fillStyle = "#333";
      stations.forEach((st) => {
        const p = transform(st.x, st.y);
        ctx.fillText(st.name || st.id, p.x, p.y + rPix + 2);
      });
    }

    // 로봇 그리기
    if (robotImg) {
      robots.forEach((r) => {
        const pos = safeParse(r.position, { x: 0, y: 0 });
        const p = transform(pos.x, pos.y);
        const sizePx = Math.max(20, (ICON_MM.width / 1000) * sf * scale);
        
        // 펄스 효과
        const pulseEffect = getPulseEffect(r);
        if (pulseEffect.shouldPulse && needsAnimation) {
          const pulsePhase = (pulseTime % 2000) / 2000;
          const pulseRadius = sizePx * 0.8 * (1 + Math.sin(pulsePhase * Math.PI * 2) * 0.3);
          const pulseOpacity = 0.6 * (1 - pulsePhase);
          
          ctx.save();
          ctx.globalAlpha = pulseOpacity;
          ctx.strokeStyle = pulseEffect.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, pulseRadius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        
        // 로봇 이미지
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(-pos.angle + Math.PI / 2);
        ctx.drawImage(robotImg, -sizePx / 2, -sizePx / 2, sizePx, sizePx);
        ctx.restore();
      });
    }
  }, [selMap, scale, offset, sf, robots, robotImg, pulseTime, getPulseEffect, transform, mapData, needsAnimation]);

  // 그리기 최적화 - 의존성 변경 시에만 실행
  useEffect(() => {
    const timeoutId = setTimeout(draw, 16); // 다음 프레임에 실행
    return () => clearTimeout(timeoutId);
  }, [draw]);

  // 터치 이벤트 처리 - 메모이제이션
  const getPos = useCallback((e) => {
    const r = canvRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
    }
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const getTouchDistance = useCallback((e) => {
    if (!e.touches || e.touches.length !== 2) return 0;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }, []);

  const onStart = useCallback((e) => {
    e.preventDefault();
    
    if (e.touches?.length === 2) {
      setLastTouchDistance(getTouchDistance(e));
    } else {
      setDrag(true);
      setLast(getPos(e));
    }
  }, [getPos, getTouchDistance]);

  const onMove = useCallback((e) => {
    e.preventDefault();
    
    if (e.touches?.length === 2) {
      // 핀치 줌
      const distance = getTouchDistance(e);
      if (lastTouchDistance > 0) {
        const scaleFactor = distance / lastTouchDistance;
        const newScale = Math.max(0.1, Math.min(scale * scaleFactor, 10));
        setScale(newScale);
      }
      setLastTouchDistance(distance);
    } else if (drag) {
      // 패닝
      const p = getPos(e);
      setOffset((o) => ({
        x: o.x + p.x - last.x,
        y: o.y - p.y + last.y,
      }));
      setLast(p);
    }
  }, [drag, last, scale, lastTouchDistance, getPos, getTouchDistance]);

  const onEnd = useCallback((e) => {
    setDrag(false);
    setLastTouchDistance(0);
  }, []);

  // 로봇 중앙 이동 및 추적
  const centerOnRobot = useCallback((robot) => {
    const pos = safeParse(robot.position, { x: 0, y: 0, angle: 0 });
    const rect = contRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    setOffset({
      x: rect.width / 2 - pos.x * sf * scale,
      y: rect.height / 2 - pos.y * sf * scale,
    });
  }, [sf, scale]);

  const toggleFollowRobot = useCallback((robot) => {
    if (followingRobot?.id === robot.id) {
      setFollowingRobot(null);
    } else {
      setFollowingRobot(robot);
      centerOnRobot(robot);
    }
  }, [followingRobot, centerOnRobot]);

  // 추적 중인 로봇이 있으면 계속 따라가기 - 디바운스 추가
  useEffect(() => {
    if (!followingRobot) return;
    
    const timeoutId = setTimeout(() => {
      const currentRobot = robots.find(r => r.id === followingRobot.id);
      if (currentRobot) {
        centerOnRobot(currentRobot);
      }
    }, 100); // 100ms 디바운스
    
    return () => clearTimeout(timeoutId);
  }, [robots, followingRobot, centerOnRobot]);

  // 줌 컨트롤
  const zoomIn = useCallback(() => {
    setScale(prev => Math.min(prev * 1.2, 10));
  }, []);
  
  const zoomOut = useCallback(() => {
    setScale(prev => Math.max(prev / 1.2, 0.1));
  }, []);

  // 신호 상태 렌더링 함수들
  const renderSignalBadge = useCallback((key, val, type) => {
    if (type === "door") {
      let status;
      if (val === "disconnected") status = "default";
      else if (val === "open") status = "error";
      else status = "success";
      return <Badge key={key} status={status} text={key} />;
    }
    if (type === "connectivity") {
      return <Badge key={key} status={val ? "processing" : "default"} text={key} />;
    }
    if (type === "alarm") {
      return <Badge key={key} status={val ? "error" : "success"} text={val ? "활성" : "비활성"} />;
    }
    return null;
  }, []);

  const renderSignalBadges = useCallback((items, type) => (
    <Space split={<Divider type="vertical" />} wrap>
      {Object.entries(items).map(([key, val]) => renderSignalBadge(key, val, type))}
    </Space>
  ), [renderSignalBadge]);

  return (
    <>
      {contextHolder}
      <div style={{ 
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        backgroundColor: '#F2F2F7' // 애플 시스템 그레이 6
      }}>
        {/* 지도 캔버스 */}
        <div
          ref={contRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: '#F8F8F8', // 애플 스타일 캔버스 배경
          }}
        >
          <canvas
            ref={canvRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              touchAction: 'none',
            }}
            onTouchStart={onStart}
            onTouchMove={onMove}
            onTouchEnd={onEnd}
            onMouseDown={onStart}
            onMouseMove={onMove}
            onMouseUp={onEnd}
            onMouseLeave={onEnd}
          />
        </div>

        {/* SignalOverlay 스타일의 오버레이 컨테이너 */}
        <div style={{
          position: 'absolute',
          top: 16,
          left: 16,
          right: robotListVisible ? 16 : 'auto',
          zIndex: 1000,
        }}>
          {/* 통합된 햄버거 버튼 + 리스트 컨테이너 */}
          <div style={{
            background: "rgba(255, 255, 255, 0.15)",
            backdropFilter: "blur(8px)",
            borderRadius: robotListVisible ? 12 : 22,
            boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            border: "1px solid rgba(255,255,255,0.3)",
            overflow: 'hidden',
            transition: 'all 0.3s ease',
            width: robotListVisible ? '100%' : 44,
            minHeight: 44,
            userSelect: 'none',
            WebkitUserSelect: 'none',
            MozUserSelect: 'none',
            msUserSelect: 'none',
            WebkitTouchCallout: 'none',
            WebkitTapHighlightColor: 'transparent',
          }}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseMove={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          >
            {/* 햄버거 버튼 헤더 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              cursor: 'pointer',
              color: '#007AFF',
              fontSize: 18,
              fontWeight: 500,
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
            }}
            onClick={(e) => {
              e.stopPropagation();
              setRobotListVisible(!robotListVisible);
            }}
            onTouchStart={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            >
              <MenuOutlined />
            </div>
            
            {/* 로봇 리스트 영역 */}
            {robotListVisible && (
              <div style={{
                padding: '0 12px 12px 12px',
                maxHeight: 'calc(100vh - 140px)',
                overflowY: 'auto',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                WebkitTouchCallout: 'none',
                WebkitTapHighlightColor: 'transparent',
              }}>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}>
                  {robots.map((robot) => {
                    const status = getAmrStatus(robot);
                    const isExpanded = robotsExpanded[robot.id] || false;
                    const isFollowing = followingRobot?.id === robot.id;
                    
                    return (
                      <div key={robot.id}>
                        {/* 데스크톱 스타일 버튼 */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 16px',
                            border: `1px solid ${STATUS_BORDER_COLOR[status]}`,
                            borderRadius: '8px',
                            backgroundColor: '#ffffff',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease',
                            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
                            userSelect: 'none',
                            WebkitUserSelect: 'none',
                            MozUserSelect: 'none',
                            msUserSelect: 'none',
                            WebkitTouchCallout: 'none',
                            WebkitTapHighlightColor: 'transparent',
                            touchAction: 'manipulation',
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setRobotsExpanded(prev => ({
                              ...prev,
                              [robot.id]: !isExpanded
                            }));
                          }}
                          onTouchStart={(e) => {
                            e.stopPropagation();
                          }}
                          onTouchMove={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                          onTouchEnd={(e) => {
                            e.stopPropagation();
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.currentTarget.style.transform = 'scale(0.98)';
                          }}
                          onMouseUp={(e) => {
                            e.stopPropagation();
                            e.currentTarget.style.transform = 'scale(1)';
                          }}
                          onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{
                              width: '8px',
                              height: '8px',
                              borderRadius: '50%',
                              backgroundColor: STATUS_BORDER_COLOR[status]
                            }} />
                            <span style={{ 
                              fontWeight: 600, 
                              fontSize: 16,
                              color: '#000000'
                            }}>
                              {robot.name}
                            </span>
                            <div style={{
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: 12,
                              fontWeight: 500,
                              backgroundColor: `${STATUS_BORDER_COLOR[status]}20`,
                              color: STATUS_BORDER_COLOR[status],
                            }}>
                              {status}
                            </div>
                          </div>
                          
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Button
                              size="small"
                              icon={<AimOutlined />}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFollowRobot(robot);
                              }}
                              style={{ 
                                width: 28,
                                height: 28,
                                borderRadius: '6px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                backgroundColor: isFollowing ? STATUS_BORDER_COLOR[status] : '#F2F2F7',
                                color: isFollowing ? '#FFFFFF' : '#3C3C43',
                                border: 'none',
                                fontSize: 12,
                                userSelect: 'none',
                                WebkitUserSelect: 'none',
                                WebkitTouchCallout: 'none',
                                WebkitTapHighlightColor: 'transparent',
                                touchAction: 'manipulation',
                              }}
                            />
                            <span style={{ 
                              fontSize: 14, 
                              color: '#C7C7CC',
                              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                              transition: 'transform 0.3s ease',
                              userSelect: 'none',
                              WebkitUserSelect: 'none',
                              pointerEvents: 'none',
                            }}>
                              ❯
                            </span>
                          </div>
                        </div>
                        
                        {/* 확장된 상세 정보 */}
                        {isExpanded && (
                          <div style={{ 
                            margin: '8px 0 0 0',
                            padding: '16px',
                            backgroundColor: '#F2F2F7',
                            borderRadius: '8px',
                            border: '1px solid rgba(0, 0, 0, 0.05)'
                          }}>
                            <div style={{ 
                              display: 'grid', 
                              gridTemplateColumns: '1fr auto 1fr',
                              gap: '12px', 
                              fontSize: 14,
                              alignItems: 'start'
                            }}>
                              {/* 왼쪽 컬럼: 위치, 배터리 */}
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                  <Text style={{ color: '#3C3C4399', fontWeight: 400 }}>위치</Text>
                                  <Text style={{ color: '#000000', fontWeight: 500 }}>{robot.location || "—"}</Text>
                                </div>
                                
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <Text style={{ color: '#3C3C4399', fontWeight: 400 }}>배터리</Text>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Progress 
                                      type="circle" 
                                      percent={Math.max(0, Math.min(100, robot.battery || 0))} 
                                      width={24}
                                      status={(robot.battery || 0) < 20 ? "exception" : "normal"}
                                      format={() => `${robot.battery || 0}%`}
                                      strokeWidth={6}
                                      strokeColor={{
                                        '0%': (robot.battery || 0) < 20 ? '#FF3B30' : '#34C759',
                                        '100%': (robot.battery || 0) < 20 ? '#FF3B30' : '#34C759',
                                      }}
                                      trailColor="#F2F2F7"
                                    />
                                    {(() => {
                                      let additionalInfo = {};
                                      try {
                                        additionalInfo = typeof robot.additional_info === 'string' 
                                          ? JSON.parse(robot.additional_info) 
                                          : robot.additional_info || {};
                                      } catch (e) {}
                                      
                                      if (additionalInfo.charging === true) {
                                        return (
                                          <span style={{
                                            fontSize: 12,
                                            color: '#FF9500',
                                            fontWeight: 500
                                          }}>⚡</span>
                                        );
                                      }
                                      return null;
                                    })()}
                                  </div>
                                </div>
                              </div>
                              
                              {/* 세로 디바이더 */}
                              <Divider type="vertical" style={{ 
                                height: '100%', 
                                margin: 0,
                                borderColor: 'rgba(0, 0, 0, 0.1)'
                              }} />
                              
                              {/* 오른쪽 컬럼: 목적지, 화물 */}
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                  <Text style={{ color: '#3C3C4399', fontWeight: 400 }}>목적지</Text>
                                  <Text style={{ color: '#000000', fontWeight: 500 }}>{robot.destination || "—"}</Text>
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <Text style={{ color: '#3C3C4399', fontWeight: 400 }}>화물</Text>
                                  {(() => {
                                    let additionalInfo = {};
                                    try {
                                      additionalInfo = typeof robot.additional_info === 'string' 
                                        ? JSON.parse(robot.additional_info) 
                                        : robot.additional_info || {};
                                    } catch (e) {
                                      return (
                                        <span style={{
                                          fontSize: 12,
                                          color: '#8E8E93',
                                          fontWeight: 500
                                        }}>📭 없음</span>
                                      );
                                    }
                                    
                                    const diSensors = additionalInfo.diSensors || [];
                                    const sensor4 = diSensors.find(s => s.id === 4);
                                    const sensor5 = diSensors.find(s => s.id === 5);
                                    const hasCargo = sensor4?.status === true && sensor5?.status === true;
                                    
                                    return (
                                      <span style={{
                                        fontSize: 12,
                                        color: hasCargo ? '#34C759' : '#8E8E93',
                                        fontWeight: 500
                                      }}>
                                        {hasCargo ? "📦 있음" : "📭 없음"}
                                      </span>
                                    );
                                  })()}
                                </div>
                              </div>
                            </div>
                            
                            <div style={{ 
                              marginTop: 12, 
                              paddingTop: 12, 
                              borderTop: '1px solid rgba(0, 0, 0, 0.1)',
                              display: 'flex', 
                              justifyContent: 'space-between',
                              fontSize: 12 
                            }}>
                              <Text style={{ color: '#3C3C4399', fontWeight: 400 }}>업데이트</Text>
                              <Text style={{ color: '#3C3C434D', fontWeight: 400 }}>
                                {new Date(robot.timestamp).toLocaleTimeString()}
                              </Text>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 확대/축소 버튼 - 애플 스타일 */}
        <div style={{
          position: 'absolute',
          bottom: 100,
          right: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          zIndex: 1001,
        }}>
          <Button
            shape="circle"
            size="large"
            icon={<PlusOutlined />}
            onClick={zoomIn}
            style={{
              backgroundColor: '#ffffff',
              border: 'none',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
              width: 44,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#007AFF',
              fontSize: 18,
              fontWeight: 500
            }}
          />
          <Button
            shape="circle"
            size="large"
            icon={<MinusOutlined />}
            onClick={zoomOut}
            style={{
              backgroundColor: '#ffffff',
              border: 'none',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
              width: 44,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#007AFF',
              fontSize: 18,
              fontWeight: 500
            }}
          />
        </div>

        {/* 새로고침 버튼 - 애플 스타일 */}
        <Button
          shape="circle"
          size="large"
          icon={<ReloadOutlined />}
          onClick={() => window.location.reload()}
          style={{ 
            position: 'absolute',
            right: 16, 
            bottom: 24,
            width: 44,
            height: 44,
            backgroundColor: '#ffffff',
            border: 'none',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#007AFF',
            fontSize: 18,
            fontWeight: 500,
            zIndex: 1001
          }}
        />
      </div>
    </>
  );
} 