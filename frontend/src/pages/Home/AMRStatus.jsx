// src/pages/Home/AMRStatus.jsx
import React, { useState } from "react";
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
  Steps,
  Empty,
  Progress,
} from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const { Text, Paragraph } = Typography;
const { Panel } = Collapse;
const API = import.meta.env.VITE_CORE_BASE_URL;

// 상태 문자열 ↔ Badge.status, Tag.color 매핑
const STATUS_BADGE = {
  이동: "processing",
  대기: "success",
  충전: "warning",
  오류: "error",
  "연결 끊김": "warning",
  unknown: "default",
};
const STATUS_TAG_COLOR = {
  이동: "blue",
  대기: "green",
  충전: "orange",
  오류: "red",
  "연결 끊김": "orange",
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

  // AMR 상태 결정 함수
  const getAmrStatus = (amr) => {
    // additional_info에서 charging 상태 확인
    let additionalInfo = {};
    try {
      additionalInfo = typeof amr.additional_info === 'string' 
        ? JSON.parse(amr.additional_info) 
        : amr.additional_info || {};
    } catch (e) {
      // JSON 파싱 실패 시 빈 객체 사용
    }
    
    // charging이 true이면 '충전' 상태로 표시
    if (additionalInfo.charging === true) {
      return '충전';
    }
    
    // 기존 상태 반환
    return amr.status || 'unknown';
  };

  // 1) AMR 리스트
  const amrQuery = useQuery({
    queryKey: ["amrs"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/robots`);
      if (!r.ok) throw new Error("AMR fetch 실패");
      return r.json();
    },
    refetchInterval: 1000,
  });

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
      qc.invalidateQueries(["amrs"]);
      setAddVisible(false);
    },
    onError: () => messageApi.error("추가 실패"),
  });

  // 3) AMR 삭제
  const delMut = useMutation({
    mutationFn: async (id) => {
      const r = await fetch(`${API}/api/robots/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("삭제 실패");
    },
    onSuccess: () => {
      messageApi.success("삭제 완료");
      qc.invalidateQueries(["amrs"]);
      setDetailVisible(false);
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

  // 화물 상태 확인 함수
  const getCargoStatus = (amr) => {
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
  };

  // JSON 포맷팅 함수
  const formatJsonForDisplay = (jsonString) => {
    try {
      const parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
      return jsonString || "없음";
    }
  };

  // ──────────────────────────────────────────────────────────────
  // TaskSteps 컴포넌트 (pause/resume/cancel 버튼)
  function CurrentTaskSteps({ amr }) {
    const { data, error, refetch } = useQuery({
      enabled: !!amr,
      queryKey: ["currentTask", amr?.id, amr?.timestamp],
      queryFn: async () => {
        const r = await fetch(`${API}/api/robots/${amr.id}/current-task`);
        if (!r.ok) throw new Error("fetch task");
        return r.json();
      },
      refetchInterval: 1000,
    });

    // pause/resume/cancel 을 모두 객체 시그니처로 변경
    const pauseMut = useMutation({
      mutationFn: () =>
        fetch(`${API}/api/tasks/${data.task_id}/pause`, { method: "PUT" }),
      onSuccess: () => {
        message.success("일시정지");
        refetch();
      },
      onError: () => message.error("일시정지 실패"),
    });

    const resumeMut = useMutation({
      mutationFn: () =>
        fetch(`${API}/api/tasks/${data.task_id}/resume`, { method: "PUT" }),
      onSuccess: () => {
        message.success("재개");
        refetch();
      },
      onError: () => message.error("재개 실패"),
    });

    const cancelMut = useMutation({
      mutationFn: () =>
        fetch(`${API}/api/tasks/${data.task_id}`, { method: "DELETE" }),
      onSuccess: () => {
        message.success("취소");
        refetch();
      },
      onError: () => message.error("취소 실패"),
    });

    if (error || !data?.steps?.length) {
      return <Empty description="현재 Task 없음" />;
    }

    const items = data.steps.map((s) => {
      const p =
        typeof s.payload === "string" ? JSON.parse(s.payload) : s.payload || {};
      const desc = s.type.startsWith("NAV")
        ? `→ ${p.dest}`
        : s.type.startsWith("JACK")
        ? `h=${p.height}`
        : "";
      const status =
        s.status === "DONE"
          ? "finish"
          : s.status === "RUNNING"
          ? "process"
          : s.status === "FAILED"
          ? "error"
          : "wait";
      return {
        key: s.seq,
        title: `${s.seq}. ${s.type}`,
        description: desc,
        status,
      };
    });

    return (
      <Card
        size="small"
        title={`Task #${data.task_id}`}
        extra={
          <Space size="small">
             {/* {data?.paused ? (
     <Button
       size="small"
       onClick={() => resumeMut.mutate()}
       loading={resumeMut.isLoading}
     >
       재개
     </Button>
   ) : (
      <Button
        size="small"
        onClick={() => pauseMut.mutate()}
        loading={pauseMut.isLoading}
      >
        일시정지
      </Button>)} */}
            <Button
              danger
              size="small"
              onClick={() => cancelMut.mutate()}
              loading={cancelMut.isLoading}
            >
              취소
            </Button>
          </Space>
        }
        bodyStyle={{ padding: 12 }}
        bordered
      >
        <Steps
          direction="vertical"
          size="small"
          items={items}
          current={data.current_seq}
        />
      </Card>
    );
  }

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
        {amrQuery.error ? (
          <Text type="danger">AMR 목록 조회 실패</Text>
        ) : (
          <Space
            wrap
            size={token.paddingSM}
            split={<Divider type="vertical" />}
          >
            {amrQuery.data?.map((amr) => {
              const border =
                token[`color${STATUS_TAG_COLOR[getAmrStatus(amr)]}`] ||
                token.colorBorder;
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
                    border: `1px solid ${border}`,
                    boxShadow: token.boxShadowSecondary,
                    height: token.controlHeightSM,
                    borderRadius: token.borderRadius,
                    padding: `${token.padding}px ${token.paddingSM}px`,
                    transform: hover ? "scale(1.05)" : undefined,
                    transition: "transform 0.2s",
                  }}
                >
                  <Badge
                    status={STATUS_BADGE[getAmrStatus(amr)]}
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
                  <Tag size="small" color={STATUS_TAG_COLOR[getAmrStatus(amr)]}>
                    {getAmrStatus(amr)}
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

      {/* 상세 모달 */}
      <Modal
        title={`AMR 상세 – ${selectedAmr?.name}`}
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        width={820}
        footer={[
          <Button
            key="del"
            danger
            icon={<DeleteOutlined />}
            loading={delMut.isLoading}
            onClick={() => delMut.mutate(selectedAmr.id)}
          >
            삭제
          </Button>,
          <Button key="close" onClick={() => setDetailVisible(false)}>
            닫기
          </Button>,
        ]}
      >
        {selectedAmr && (
          <div style={{ display: "flex", gap: 24 }}>
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
                      percent={selectedAmr.battery} 
                      width={40}
                      status={selectedAmr.battery < 20 ? "exception" : "normal"}
                    />
                    <Text>{selectedAmr.battery}%</Text>
                    {selectedAmr.voltage && (
                      <Text type="secondary">({selectedAmr.voltage}V)</Text>
                    )}
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
            <div style={{ width: 240 }}>
              <CurrentTaskSteps amr={selectedAmr} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
