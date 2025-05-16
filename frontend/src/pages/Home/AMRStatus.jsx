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
  오류: "error",
  "연결 끊김": "warning",
  unknown: "default",
};
const STATUS_TAG_COLOR = {
  이동: "blue",
  대기: "green",
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
             {data?.paused ? (
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
      </Button>)}
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
                token[`color${STATUS_TAG_COLOR[amr.status]}`] ||
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
                    status={STATUS_BADGE[amr.status]}
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
                  <Tag size="small" color={STATUS_TAG_COLOR[amr.status]}>
                    {amr.status}
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
                  <Tag color={STATUS_TAG_COLOR[selectedAmr.status]}>
                    {selectedAmr.status}
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
                    {selectedAmr.additional_info || "없음"}
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
