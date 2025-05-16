// src/components/SignalMonitor.jsx
import React, { useState } from "react";
import {
  Card,
  Descriptions,
  Badge,
  Spin,
  Alert,
  Space,
  Divider,
  Button,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API = import.meta.env.VITE_CORE_BASE_URL;
const THRESHOLD = 5000; // 5초

// Badge.status → {연결없음, 연결, 살아있음, 끊김} 매핑
const getStatus = (type, info) => {
  if (type === "rio" || type === "amr") {
    const { connected, alive } = info;
    if (!connected) return "default"; // 회색
    if (!alive) return "processing"; // 파랑
    return "success"; // 녹색
  }
  if (type === "door") {
    const { timestamp, open } = info;
    if (Date.now() - timestamp > THRESHOLD) return "default";
    return open ? "success" : "error"; // 녹/적
  }
  if (type === "alarm") {
    return info.active ? "success" : "error";
  }
};

export default function SignalMonitor() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState({ type: null, key: null });

  // 요약
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["signals"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/health/signals`);
      if (!res.ok) throw new Error("네트워크 오류");
      return res.json();
    },
    refetchInterval: 2000,
  });

  // 상세
  const detail = useQuery({
    queryKey: ["signalDetail", selected],
    queryFn: async () => {
      const { type, key } = selected;
      const res = await fetch(`${API}/api/health/signals/${type}/${key}`);
      if (!res.ok) throw new Error("상세 조회 오류");
      return res.json();
    },
    enabled: !!selected.type && !!selected.key,
    refetchInterval: 2000,
  });

  // 재연결 뮤테이션
  const reconnectM = useMutation({
    mutationFn: async () => {
      const { type, key } = selected;
      await fetch(`${API}/api/health/signals/${type}/${key}/reconnect`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      refetch();
      detail.refetch();
    },
  });

  const renderBadges = (items, type) => (
    <Space split={<Divider type="vertical" />}>
      {Object.entries(items).map(([key, info]) => (
        <Space key={key}>
          <Badge
            status={getStatus(type, info)}
            text={key}
            onClick={() => setSelected({ type, key })}
            style={{ cursor: "pointer" }}
          />
          <Button
            type="text"
            icon={<ReloadOutlined />}
            size="small"
            onClick={() => {
              setSelected({ type, key });
              reconnectM.mutate();
            }}
          />
        </Space>
      ))}
    </Space>
  );

  return (
    <Card title="신호 상태 모니터" bordered>
      {isLoading && <Spin tip="로딩 중..." />}
      {error && (
        <Alert
          type="error"
          message="신호 로드 실패"
          description={error.message}
        />
      )}
      {data && (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Descriptions
            bordered
            size="small"
            column={1}
            labelStyle={{ width: 120 }}
          >
            <Descriptions.Item label="RIO">
              {renderBadges(data.rio, "rio")}
            </Descriptions.Item>
            <Descriptions.Item label="AMR">
              {renderBadges(data.amr, "amr")}
            </Descriptions.Item>
            <Descriptions.Item label="문 제어">
              {renderBadges(data.door, "door")}
            </Descriptions.Item>
            <Descriptions.Item label="알람">
              {renderBadges({ 알람: data.alarm }, "alarm")}
            </Descriptions.Item>
          </Descriptions>
          <Card title="상세 정보" size="small">
            {!selected.type && (
              <Alert message="항목을 클릭하세요" type="info" />
            )}
            {detail.isLoading && <Spin tip="조회 중..." />}
            {detail.error && (
              <Alert
                type="error"
                message="상세 조회 실패"
                description={detail.error.message}
              />
            )}
            {detail.data && (
              <pre style={{ margin: 0 }}>
                {JSON.stringify(detail.data, null, 2)}
              </pre>
            )}
          </Card>
        </Space>
      )}
    </Card>
  );
}
