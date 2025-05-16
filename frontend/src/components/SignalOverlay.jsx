import React, { useState } from "react";
import { Button, Card, Space, Badge, Divider, Spin, Alert } from "antd";
import { InfoCircleOutlined, CloseOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";

const API = import.meta.env.VITE_CORE_BASE_URL;

export default function SignalOverlay() {
  const [visible, setVisible] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: ["signals"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/health/signals`);
      if (!res.ok) throw new Error("네트워크 오류");
      return res.json();
    },
    refetchInterval: visible ? 1000 : false,
    retry: false,
  });

  // 각 상태값에 맞춰 Ant Design의 Badge status로 매핑
  const renderBadge = (key, val, type) => {
    // door: 'disconnected' | 'open' | 'closed'
    if (type === "door") {
      let status;
      if (val === "disconnected") status = "default";
      else if (val === "open") status = "error";
      /* closed */ else status = "success";
      return <Badge key={key} status={status} text={key} />;
    }
    // 그 외 boolean: connectivity (rio/amr) -> 파랑/회색
    if (type === "connectivity") {
      return (
        <Badge key={key} status={val ? "processing" : "default"} text={key} />
      );
    }
    // alarm (boolean) -> 빨강/초록
    if (type === "alarm") {
      return (
        <Badge
          key={key}
          status={val ? "error" : "success"}
          text={val ? "활성" : "비활성"}
        />
      );
    }
    return null;
  };

  const renderBadges = (items, type) => (
    <Space split={<Divider type="vertical" />} wrap>
      {Object.entries(items).map(([key, val]) => renderBadge(key, val, type))}
    </Space>
  );

  const collapsedContainer = {
    position: "absolute",
    top: 16,
    left: 16,
    zIndex: 1000,
  };
  const overlayContainer = {
    position: "absolute",
    top: 16,
    left: 16,
    zIndex: 1000,
    overflow: "hidden",
    borderRadius: 8,
  };
  const buttonStyle = {
    backdropFilter: "blur(4px)",
    background: "rgba(255, 255, 255, 0.1)",
    border: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    width: 32,
    height: 32,
    padding: 0,
  };
  const cardStyle = {
    width: 280,
    background: "rgba(255,255,255,0.15)",
    backdropFilter: "blur(6px)",
    borderRadius: 8,
    padding: 8,
  };

  return (
    <div style={visible ? overlayContainer : collapsedContainer}>
      {!visible ? (
        <Button
          shape="circle"
          icon={<InfoCircleOutlined />}
          style={buttonStyle}
          size="small"
          onClick={() => setVisible(true)}
        />
      ) : (
        <Card
          size="small"
          title="신호 상태"
          extra={<CloseOutlined onClick={() => setVisible(false)} />}
          style={cardStyle}
        >
          {isLoading && <Spin tip="로딩 중..." style={{ width: "100%" }} />}
          {error && (
            <Alert
              type="error"
              message="불러오기 실패"
              description={error.message}
              showIcon
            />
          )}
          {data && (
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              <div>
                <strong>RIO:</strong> {renderBadges(data.rio, "connectivity")}
              </div>
              <div>
                <strong>AMR:</strong> {renderBadges(data.amr, "connectivity")}
              </div>
              <div>
                <strong>문 제어:</strong> {renderBadges(data.door, "door")}
              </div>
              <div>
                <strong>알람:</strong>{" "}
                {renderBadge("alarm", data.alarm, "alarm")}
              </div>
            </Space>
          )}
        </Card>
      )}
    </div>
  );
}
