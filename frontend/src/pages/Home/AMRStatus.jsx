// src/pages/Home/AMRStatus.jsx
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Card,
  Space,
  Divider,
  Button,
  Modal,
  Form,
  Input,
  Badge,
  Tag,
  Typography,
  Descriptions,
  Collapse,
  theme,
  message,
  Empty,
  Progress,
} from "antd";
import { 
  PlusOutlined, 
  DeleteOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  CarOutlined,
  ToolOutlined,
  HourglassOutlined,
  AimOutlined,
  SearchOutlined
} from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { robotsQueryAtom } from "@/state/atoms";

const { Text, Paragraph } = Typography;
const { Panel } = Collapse;
const API = import.meta.env.VITE_CORE_BASE_URL;

// 상태 문자열 ↔ Badge.status, Tag.color 매핑
const STATUS_BADGE = {
  이동: "processing",
  대기: "success",
  충전: "warning",
  수동: "default",
  오류: "error",
  "연결 끊김": "default",
  unknown: "default",
};
const STATUS_TAG_COLOR = {
  이동: "blue",
  대기: "green",
  충전: "orange",
  수동: "purple",
  오류: "red",
  "연결 끊김": "default",
  unknown: "default",
};

export default function AMRStatus() {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [addVisible, setAddVisible] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [selectedAmr, setSelectedAmr] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [form] = Form.useForm();

  // AMR 상태 결정 함수 (메모이제이션)
  const getAmrStatus = useCallback((amr) => {
    // 연결 끊김 상태를 최우선으로 확인
    if (amr.status === '연결 끊김') {
      return '연결 끊김';
    }
    
    // additional_info에서 charging 상태 확인
    let additionalInfo = {};
    try {
      additionalInfo = typeof amr.additional_info === 'string' 
        ? JSON.parse(amr.additional_info) 
        : amr.additional_info || {};
    } catch (e) {
      // JSON 파싱 실패 시 빈 객체 사용
    }
    
    // DI 센서 11번이 true이면 '수동' 상태로 표시
    const diSensors = additionalInfo.diSensors || [];
    const sensor11 = diSensors.find(s => s.id === 11);
    if (sensor11?.status === true) {
      return '수동';
    }
    
    // charging이 true이면 '충전' 상태로 표시
    if (additionalInfo.charging === true) {
      return '충전';
    }
    
    // 기존 상태 반환
    return amr.status || 'unknown';
  }, []);

  // AMR 리스트 (robotsQueryAtom 사용)
  const robotsQuery = useAtomValue(robotsQueryAtom);
  const amrs = robotsQuery.data ?? [];
  const isLoading = robotsQuery.isLoading;

  // 모달이 열려있을 때 selectedAmr 실시간 업데이트
  useEffect(() => {
    if (detailVisible && selectedAmr && amrs.length > 0) {
      const updatedAmr = amrs.find(amr => amr.id === selectedAmr.id);
      if (updatedAmr) {
        setSelectedAmr(updatedAmr);
        
        // AMR 상태가 '대기'로 변경되었다면 현재 태스크 쿼리 캐시를 null로 설정하고 무효화
        const currentStatus = getAmrStatus(updatedAmr);
        const previousStatus = getAmrStatus(selectedAmr);
        if (previousStatus !== '대기' && currentStatus === '대기') {
          console.log(`[AMRStatus] ${updatedAmr.name}: 상태가 '대기'로 변경됨, 태스크 캐시 초기화`);
          // 즉시 캐시를 null로 설정
          qc.setQueryData(["currentTask", updatedAmr.id], null);
          qc.invalidateQueries(["currentTask", updatedAmr.id]);
          // 연속으로 무효화하여 확실히 처리
          setTimeout(() => {
            qc.setQueryData(["currentTask", updatedAmr.id], null);
            qc.invalidateQueries(["currentTask", updatedAmr.id]);
          }, 200);
          setTimeout(() => {
            qc.invalidateQueries(["currentTask", updatedAmr.id]);
          }, 500);
        }
      }
    }
  }, [amrs, detailVisible, selectedAmr?.id, getAmrStatus, qc]);

  // 2) AMR 추가
  const addMut = useMutation({
    mutationFn: async (body) => {
      const r = await fetch(`${API}/api/robots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("추가 실패");
    },
    onSuccess: () => {
      messageApi.success("추가 완료");
      qc.invalidateQueries(["robots"]);
      setAddVisible(false);
    },
    onError: () => messageApi.error("추가 실패"),
  });

  // 3) AMR 삭제
  const deleteMut = useMutation({
    mutationFn: async (id) => {
      const r = await fetch(`${API}/api/robots/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("삭제 실패");
    },
    onSuccess: () => {
      messageApi.success("삭제 완료");
      qc.invalidateQueries(["robots"]);
    },
    onError: () => messageApi.error("삭제 실패"),
  });

  const showAdd = () => {
    form.resetFields();
    setAddVisible(true);
  };
  const handleAdd = () =>
    form.validateFields().then((vals) =>
      addMut.mutate({
        name: vals.id,
        ip: vals.ip,
        battery: 100,
        status: "대기",
        additional_info: "",
      })
    );
  const showDetail = (amr) => {
    setSelectedAmr(amr);
    setDetailVisible(true);
  };

  const handleDetailClose = () => {
    setDetailVisible(false);
    setSelectedAmr(null);
  };

  // 화물 상태 확인 함수 (메모이제이션)
  const getCargoStatus = useCallback((amr) => {
    let additionalInfo = {};
    try {
      additionalInfo = typeof amr.additional_info === 'string' 
        ? JSON.parse(amr.additional_info) 
        : amr.additional_info || {};
    } catch (e) {
      return { hasCargo: false, sensors: [] };
    }
    
    const diSensors = additionalInfo.diSensors || [];
    const sensor4 = diSensors.find(s => s.id === 4);
    const sensor5 = diSensors.find(s => s.id === 5);
    
    const hasCargo = sensor4?.status === true && sensor5?.status === true;
    
    return {
      hasCargo,
      sensors: diSensors,
      sensor4Status: sensor4?.status || false,
      sensor5Status: sensor5?.status || false
    };
  }, []);

  // JSON 포맷팅 함수
  const formatJsonForDisplay = useCallback((jsonString) => {
    try {
      const parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
      return jsonString || "없음";
    }
  }, []);

  // ──────────────────────────────────────────────────────────────
  // TaskSteps 컴포넌트 (pause/resume/cancel 버튼) - 메모이제이션 적용
  const CurrentTaskSteps = useCallback(({ amr }) => {
    // 스크롤 컨테이너 ref
    const stepsContainerRef = useRef(null);
    // 태스크 완료/취소 상태를 추적하는 로컬 상태
    const [isTaskCancelled, setIsTaskCancelled] = useState(false);
    
    // AMR이 변경될 때마다 취소 상태 초기화
    useEffect(() => {
      setIsTaskCancelled(false);
    }, [amr?.id]);
    
    const { data, error, isLoading, isFetching, refetch } = useQuery({
      enabled: !!amr && !isTaskCancelled, // isTaskCancelled가 true면 쿼리 비활성화
      queryKey: ["currentTask", amr?.id],
      queryFn: async () => {
        try {
          const r = await fetch(`${API}/api/robots/${amr.id}/current-task`);
          
          // 204 No Content 또는 404 - 태스크 없음
          if (r.status === 204 || r.status === 404) {
            console.log(`[CurrentTaskSteps] ${amr.name}: 태스크 없음 (${r.status})`);
            setIsTaskCancelled(true);
            return null;
          }
          
          if (!r.ok) {
            throw new Error(`Failed to fetch task, status: ${r.status}`);
          }
          
          const taskData = await r.json();
          
          // 태스크 데이터가 유효하지 않으면 태스크 취소 상태로 설정
          if (!taskData || !taskData.steps || taskData.steps.length === 0) {
            console.log(`[CurrentTaskSteps] ${amr.name}: 유효하지 않은 태스크 데이터`);
            setIsTaskCancelled(true);
            return null;
          }
          
          // 유효한 태스크 데이터가 있으면 취소 상태 해제
          setIsTaskCancelled(false);
          console.log(`[CurrentTaskSteps] ${amr.name}: 유효한 태스크 발견 (${taskData.task_id})`);
          return taskData;
        } catch (error) {
          console.error(`[CurrentTaskSteps] ${amr.name}: 에러 - ${error.message}`);
          // 네트워크 오류나 특정 상태코드는 태스크 없음으로 처리
          if (error.message.includes('204') || 
              error.message.includes('404') || 
              error.message.includes('Failed to fetch')) {
            setIsTaskCancelled(true);
            return null;
          }
          throw error;
        }
      },
      refetchInterval: (data) => {
        // 태스크가 취소되었거나 데이터가 null이면 새로고침 중단
        if (isTaskCancelled || data === null) {
          console.log(`[CurrentTaskSteps] ${amr?.name}: 새로고침 중단 (isTaskCancelled: ${isTaskCancelled}, data: ${data})`);
          return false;
        }
        return 3000;
      },
      refetchIntervalInBackground: false,
      refetchOnMount: true,
      refetchOnWindowFocus: false, // 창 포커스 시 새로고침 비활성화
      refetchOnReconnect: false, // 재연결 시 새로고침 비활성화
      staleTime: 1000, // 1초로 설정하여 빠른 업데이트
      gcTime: 5000, // 5초로 줄여서 캐시 빨리 정리
      retry: (failureCount, error) => {
        // 204, 404나 네트워크 오류는 재시도하지 않음
        if (error?.message?.includes('204') || 
            error?.message?.includes('404') || 
            error?.message?.includes('Failed to fetch')) {
          return false;
        }
        return failureCount < 1;
      },
      // 에러 발생 시 null로 폴백하고 쿼리 비활성화
      onError: (error) => {
        console.log(`[CurrentTaskSteps] ${amr?.name}: onError - ${error.message}`);
        if (error?.message?.includes('204') || error?.message?.includes('404')) {
          setIsTaskCancelled(true);
          qc.setQueryData(["currentTask", amr?.id], null);
        }
      },
      // 성공 시에도 데이터 확인
      onSuccess: (data) => {
        if (data === null) {
          console.log(`[CurrentTaskSteps] ${amr?.name}: onSuccess with null data`);
          setIsTaskCancelled(true);
        }
      },
    });

    // pause/restart/cancel API 호출
    const pauseMut = useMutation({
      mutationFn: () =>
        fetch(`${API}/api/tasks/${data?.task_id}/pause`, { method: "PUT" }),
      onSuccess: () => {
        message.success("일시정지");
        qc.invalidateQueries(["currentTask", amr?.id]);
      },
      onError: () => message.error("일시정지 실패"),
    });

    const restartMut = useMutation({
      mutationFn: () =>
        fetch(`${API}/api/tasks/${data?.task_id}/restart`, { method: "PUT" }),
      onSuccess: () => {
        message.success("재시작");
        qc.invalidateQueries(["currentTask", amr?.id]);
      },
      onError: () => message.error("재시작 실패"),
    });

    const cancelMut = useMutation({
      mutationFn: () =>
        fetch(`${API}/api/tasks/${data?.task_id}`, { method: "DELETE" }),
      onSuccess: () => {
        message.success("취소");
        console.log(`[CurrentTaskSteps] ${amr?.name}: 태스크 취소 완료`);
        // 태스크 취소 상태로 설정하여 추가 API 호출 방지
        setIsTaskCancelled(true);
        // 캐시를 즉시 null로 설정하여 UI 즉시 업데이트
        qc.setQueryData(["currentTask", amr?.id], null);
        // 추가로 invalidate도 호출 (혹시 모를 상황 대비)
        qc.invalidateQueries(["currentTask", amr?.id]);
        // 강제로 쿼리 비활성화를 위해 잠깐 기다린 후 다시 무효화
        setTimeout(() => {
          qc.invalidateQueries(["currentTask", amr?.id]);
        }, 100);
      },
      onError: () => message.error("취소 실패"),
    });

    // 스텝 타입별 아이콘 반환 (메모이제이션)
    const getStepIcon = useCallback((stepType) => {
      switch (stepType) {
        case 'NAV':
        case 'NAV_PRE':
          return <CarOutlined />;
        case 'JACK_UP':
        case 'JACK_DOWN':
        case 'JACK':
          return <ToolOutlined />;
        case 'WAIT_FREE_PATH':
          return <HourglassOutlined />;
        case 'NAV_OR_BUFFER':
          return <AimOutlined />;
        case 'CHECK_BUFFER_BEFORE_NAV':
        case 'CHECK_BUFFER_WITHOUT_CHARGING':
          return <SearchOutlined />;
        default:
          return <ClockCircleOutlined />;
      }
    }, []);

    // 스텝 상태별 아이콘과 상태 결정 (메모이제이션)
    const getStepStatusInfo = useCallback((step, currentSeq) => {
      if (step.seq < currentSeq) {
        return { 
          status: 'finish', 
          icon: <CheckCircleOutlined style={{ color: '#096dd9' }} />
        };
      } else if (step.seq === currentSeq) {
        switch (step.status) {
          case 'RUNNING':
            return { 
              status: 'process', 
              icon: <LoadingOutlined style={{ color: '#1890ff' }} />
            };
          case 'PAUSED':
            return { 
              status: 'error', 
              icon: <PauseCircleOutlined style={{ color: '#faad14' }} />
            };
          case 'FAILED':
            return { 
              status: 'error', 
              icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
            };
          default:
            return { 
              status: 'process', 
              icon: <LoadingOutlined style={{ color: '#1890ff' }} />
            };
        }
      } else {
        return { 
          status: 'wait', 
          icon: <ClockCircleOutlined style={{ color: '#d9d9d9' }} />
        };
      }
    }, []);

    // 스텝 요약 정보 (메모이제이션)
    const getStepSummary = useCallback((step) => {
      const p = typeof step.payload === "string" ? JSON.parse(step.payload) : step.payload || {};
      switch (step.type) {
        case 'NAV':
        case 'NAV_PRE':
          return `→ ${p.dest}`;
        case 'JACK_UP':
          return "잭 올리기";
        case 'JACK_DOWN':
          return "잭 내리기";
        case 'WAIT_FREE_PATH':
          return "경로 대기";
        case 'NAV_OR_BUFFER':
          return `→ ${p.primary || p.dest || '목적지'}`;
        case 'CHECK_BUFFER_BEFORE_NAV':
        case 'CHECK_BUFFER_WITHOUT_CHARGING':
          return `버퍼 확인 (${p.target || '대상'})`;
        case 'FIND_EMPTY_B_BUFFER':
          return "빈 B 버퍼 찾기";
        case 'CHECK_BATTERY_AFTER_BUFFER':
          return "배터리 체크";
        default:
          return step.type;
      }
    }, []);

    // 디버깅을 위한 로그 (개발 중에만)
    if (import.meta.env.DEV) {
      console.log(`[CurrentTaskSteps] ${amr?.name} - data: ${data === null ? 'null' : data ? `exists(task_id:${data.task_id})` : 'undefined'}, isLoading: ${isLoading}, error: ${error?.message || 'none'}, isTaskCancelled: ${isTaskCancelled}, enabled: ${!!amr && !isTaskCancelled}`);
      if (data && data.steps) {
        console.log(`[CurrentTaskSteps] ${amr?.name} - steps: ${data.steps.length}, current_seq: ${data.current_seq}, paused: ${data.paused}`);
      }
    }

    // 항상 같은 구조를 유지하되 내용만 변경
    return (
      <Card
        size="small"
        bordered
        bodyStyle={{ padding: 16, height: 700, display: 'flex', flexDirection: 'column' }}
        style={{ width: '100%', maxWidth: 350 }}
      >
        {data && data.steps && data.steps.length > 0 ? (
          // 태스크 데이터가 있는 경우
          <>
            {/* 헤더 */}
            <div style={{ marginBottom: 12, flexShrink: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text strong style={{ fontSize: 15 }}>
                  Task #{data.task_id}
                </Text>
                <Tag 
                  color={data.paused ? 'orange' : 'blue'} 
                  icon={data.paused ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  style={{ fontSize: '11px' }}
                >
                  {data.paused ? '일시정지' : '실행중'}
                </Tag>
              </div>
              
              <Progress 
                percent={Math.round((data.current_seq / data.steps.length) * 100)} 
                size="small" 
                status={data.paused ? 'exception' : 'active'}
                format={() => `${data.current_seq}/${data.steps.length}`}
              />
            </div>

            {/* Steps */}
            <div style={{ marginBottom: 12, flex: 1, overflow: 'hidden', minHeight: 0 }}>
              <div 
                ref={stepsContainerRef}
                style={{ 
                  height: '100%',
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  paddingRight: '4px',
                }}
              >
                <div style={{ padding: '8px 0' }}>
                  {data.steps.map((step, index) => {
                    const isCurrentStep = step.seq === data.current_seq;
                    const isCompleted = step.seq < data.current_seq;
                    const summary = getStepSummary(step);
                    
                    return (
                      <div 
                        key={step.seq}
                        style={{ 
                          display: 'flex',
                          marginBottom: index === data.steps.length - 1 ? 0 : '16px',
                          position: 'relative'
                        }}
                      >
                        {/* 연결선 */}
                        {index < data.steps.length - 1 && (
                          <div
                            style={{
                              position: 'absolute',
                              left: '11px',
                              top: '24px',
                              width: '2px',
                              height: '16px',
                              backgroundColor: isCompleted ? '#096dd9' : '#d9d9d9',
                              zIndex: 1
                            }}
                          />
                        )}
                        {/* 아이콘 영역 */}
                        <div
                          style={{
                            width: '24px',
                            height: '24px',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 
                              isCompleted ? '#096dd9' :
                              isCurrentStep ? '#1890ff' : '#d9d9d9',
                            color: 'white',
                            fontSize: '12px',
                            marginRight: '12px',
                            flexShrink: 0,
                            zIndex: 2,
                            position: 'relative'
                          }}
                        >
                          {isCompleted ? <CheckCircleOutlined style={{ fontSize: '14px' }} /> :
                           isCurrentStep ? <LoadingOutlined style={{ fontSize: '14px' }} /> :
                           <span style={{ fontSize: '10px', fontWeight: 'bold' }}>{step.seq}</span>}
                        </div>
                        {/* 내용 영역 */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: 6,
                            backgroundColor: isCurrentStep ? 'rgba(24, 144, 255, 0.1)' : 'transparent',
                            padding: isCurrentStep ? '4px 6px' : '2px 0',
                            borderRadius: isCurrentStep ? '4px' : '0',
                            margin: isCurrentStep ? '-2px -6px' : '0',
                            maxWidth: '100%',
                            overflow: 'hidden'
                          }}>
                            <div style={{ flexShrink: 0 }}>
                              {getStepIcon(step.type)}
                            </div>
                            <span style={{ 
                              fontWeight: isCurrentStep ? 600 : 400,
                              color: isCurrentStep ? '#1890ff' : 'inherit',
                              fontSize: '13px',
                              lineHeight: '1.2',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: 1
                            }}>
                              {step.seq}. {summary}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                            <Tag size="small" style={{ fontSize: '10px', lineHeight: '14px', padding: '0 4px' }} color={
                              step.status === 'DONE' ? 'blue' :
                              step.status === 'RUNNING' ? 'green' :
                              step.status === 'PAUSED' ? 'orange' :
                              step.status === 'FAILED' ? 'red' : 'default'
                            }>
                              {step.status}
                            </Tag>
                            <span style={{ marginLeft: 4, fontSize: '10px' }}>{step.type}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 제어 버튼 */}
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {data.paused ? (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => restartMut.mutate()}
                  loading={restartMut.isLoading}
                  icon={<ReloadOutlined />}
                  style={{ flex: 1, fontSize: '12px' }}
                >
                  재시작
                </Button>
              ) : (
                <Button
                  size="small"
                  onClick={() => pauseMut.mutate()}
                  loading={pauseMut.isLoading}
                  icon={<PauseCircleOutlined />}
                  style={{ flex: 1, fontSize: '12px' }}
                >
                  일시정지
                </Button>
              )}
              <Button
                danger
                size="small"
                onClick={() => cancelMut.mutate()}
                loading={cancelMut.isLoading}
                icon={<StopOutlined />}
                style={{ flex: 1, fontSize: '12px' }}
              >
                취소
              </Button>
            </div>
          </>
        ) : (
          // 태스크 데이터가 없는 경우
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description="현재 Task 없음" size="small" />
          </div>
        )}
      </Card>
    );
  }, []); // 빈 의존성 배열로 컴포넌트 안정화

  // ──────────────────────────────────────────────────────────────
  // 메인 렌더
  return (
    <>
      {contextHolder}

      <Card
        size="small"
        bordered={false}
        bodyStyle={{ padding: token.padding, overflowX: "auto" }}
      >
        {isLoading ? (
          <Text type="danger">AMR 목록 조회 중...</Text>
        ) : (
          <Space
            wrap
            size={token.paddingSM}
            split={<Divider type="vertical" />}
          >
            {amrs.map((amr) => {
              // 상태별 테두리 색상 매핑
              const status = getAmrStatus(amr);
              let borderColor;
              switch(status) {
                case '이동':
                  borderColor = token.colorInfo;
                  break;
                case '대기':
                  borderColor = token.colorSuccess;
                  break;
                case '충전':
                  borderColor = token.colorWarning;
                  break;
                case '수동':
                  borderColor = token.colorTextSecondary;
                  break;
                case '오류':
                  borderColor = token.colorError;
                  break;
                case '연결 끊김':
                  borderColor = token.colorTextSecondary;
                  break;
                default:
                  borderColor = token.colorBorder;
              }
              
              const hover = hoveredId === amr.id;
              return (
                <Button
                  key={amr.id}
                  type="text"
                  ghost
                  onClick={() => showDetail(amr)}
                  onMouseEnter={() => setHoveredId(amr.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{
                    border: `1px solid ${borderColor}`,
                    boxShadow: token.boxShadowSecondary,
                    height: token.controlHeightSM,
                    borderRadius: token.borderRadius,
                    padding: `${token.padding}px ${token.paddingSM}px`,
                    transform: hover ? "scale(1.05)" : undefined,
                    transition: "transform 0.2s",
                  }}
                >
                  <Badge
                    status={STATUS_BADGE[status]}
                    style={{ marginRight: token.marginXXS }}
                  />
                  <span
                    style={{
                      fontWeight: token.fontWeightStrong,
                      marginRight: token.marginXXS,
                    }}
                  >
                    {amr.name}
                  </span>
                  <Tag size="small" color={STATUS_TAG_COLOR[status]}>
                    {status}
                  </Tag>
                </Button>
              );
            })}
            <Button
              type="dashed"
              size="small"
              icon={<PlusOutlined />}
              onClick={showAdd}
              style={{ boxShadow: token.boxShadowSecondary }}
            ></Button>
          </Space>
        )}
      </Card>

      {/* 추가 모달 */}
      <Modal
        title="새 AMR 추가"
        open={addVisible}
        onOk={handleAdd}
        okButtonProps={{ loading: addMut.isLoading }}
        onCancel={() => setAddVisible(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="id"
            label="AMR ID"
            rules={[{ required: true, message: "ID를 입력하세요" }]}
          >
            <Input placeholder="AMR1" />
          </Form.Item>
          <Form.Item
            name="ip"
            label="IP 주소"
            rules={[{ required: true, message: "IP를 입력하세요" }]}
          >
            <Input placeholder="192.168.0.10" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 상세 모달 - 고정 높이 적용 */}
      <Modal
        title={`AMR 상세 – ${selectedAmr?.name}`}
        open={detailVisible}
        onCancel={handleDetailClose}
        width={900}
        style={{ top: 20 }} // 상단 여백 추가
        bodyStyle={{ 
          maxHeight: 'calc(100vh - 200px)', 
          overflowY: 'auto',
          padding: 24
        }}
        footer={[
          <Button
            key="del"
            danger
            icon={<DeleteOutlined />}
            loading={deleteMut.isLoading}
            onClick={() => deleteMut.mutate(selectedAmr.id)}
          >
            삭제
          </Button>,
          <Button key="close" onClick={handleDetailClose}>
            닫기
          </Button>,
        ]}
      >
        {selectedAmr && (
          <div style={{ display: "flex", gap: 24, minHeight: 500 }}>
            <div style={{ flex: 1 }}>
              <Descriptions
                bordered
                size="small"
                column={1}
                labelStyle={{ width: 120 }}
              >
                <Descriptions.Item label="ID">
                  {selectedAmr.id}
                </Descriptions.Item>
                <Descriptions.Item label="이름">
                  {selectedAmr.name}
                </Descriptions.Item>
                <Descriptions.Item label="IP">
                  {selectedAmr.ip}
                </Descriptions.Item>
                <Descriptions.Item label="상태">
                  <Tag color={STATUS_TAG_COLOR[getAmrStatus(selectedAmr)]}>
                    {getAmrStatus(selectedAmr)}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="모드">
                  {selectedAmr.mode}
                </Descriptions.Item>
                <Descriptions.Item label="타임스탬프">
                  {new Date(selectedAmr.timestamp).toLocaleString()}
                </Descriptions.Item>
                <Descriptions.Item label="위치">
                  {selectedAmr.location || "-"}
                </Descriptions.Item>
                <Descriptions.Item label="다음 위치">
                  {selectedAmr.next_location || "-"}
                </Descriptions.Item>
                <Descriptions.Item label="목적지">
                  {selectedAmr.destination || "-"}
                </Descriptions.Item>
                <Descriptions.Item label="작업 단계">
                  {selectedAmr.task_step || "-"}
                </Descriptions.Item>
                <Descriptions.Item label="배터리">
                  <Space>
                    <Progress 
                      type="circle" 
                      percent={selectedAmr.battery-10} 
                      width={40}
                      status={selectedAmr.battery-10 < 20 ? "exception" : "normal"}
                    />
                    <Text>{selectedAmr.battery-10}%</Text>
                    {(() => {
                      // additional_info에서 charging 상태 확인
                      let additionalInfo = {};
                      try {
                        additionalInfo = typeof selectedAmr.additional_info === 'string' 
                          ? JSON.parse(selectedAmr.additional_info) 
                          : selectedAmr.additional_info || {};
                      } catch (e) {
                        // JSON 파싱 실패 시 빈 객체 사용
                      }
                      
                      if (additionalInfo.charging === true) {
                        return (
                          <Tag color="orange" size="small">
                            ⚡ 충전중
                          </Tag>
                        );
                      }
                      return null;
                    })()}
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="화물 상태">
                  {(() => {
                    const cargoStatus = getCargoStatus(selectedAmr);
                    return (
                      <Space>
                        <Tag 
                          color={cargoStatus.hasCargo ? "green" : "default"}
                          icon={cargoStatus.hasCargo ? "📦" : "📭"}
                        >
                          {cargoStatus.hasCargo ? "화물 있음" : "화물 없음"}
                        </Tag>
                        <Text type="secondary" style={{ fontSize: '12px' }}>
                          (DI4: {cargoStatus.sensor4Status ? 'ON' : 'OFF'}, 
                           DI5: {cargoStatus.sensor5Status ? 'ON' : 'OFF'})
                        </Text>
                      </Space>
                    );
                  })()}
                </Descriptions.Item>
                <Descriptions.Item label="좌표">
                  <Paragraph code copyable>
                    {selectedAmr.position}
                  </Paragraph>
                </Descriptions.Item>
              </Descriptions>
              <Collapse style={{ marginTop: token.padding }}>
                <Panel header="추가 정보 (JSON)" key="1">
                  <Paragraph
                    code
                    copyable
                    style={{
                      whiteSpace: "pre-wrap",
                      maxHeight: 200,
                      overflow: "auto",
                    }}
                  >
                    {formatJsonForDisplay(selectedAmr.additional_info)}
                  </Paragraph>
                </Panel>
              </Collapse>
            </div>
            <div style={{ width: 350, flexShrink: 0 }}>
              <CurrentTaskSteps amr={selectedAmr} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
