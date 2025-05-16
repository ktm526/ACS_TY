// src/components/AmrLiftSection.jsx
import React, { useRef } from "react";
import axios from "axios";
import { Space, Button, InputNumber, theme, message } from "antd";
import {
  VerticalAlignTopOutlined,
  VerticalAlignBottomOutlined,
  PauseCircleOutlined,
  SendOutlined,
} from "@ant-design/icons";

const API = import.meta.env.VITE_CORE_BASE_URL;

// Jack API codes mapping
const JACK_ENDPOINTS = {
  up: "load", // jack load
  down: "unload", // jack unload
  stop: "stop", // jack stop
  set: "height", // jack set height
};

export default function AmrLiftSection({
  robotId,
  disabled,
  btnStyle,
  elevate,
  depress,
}) {
  const { token } = theme.useToken();
  const SIZE = 64,
    ICON = 24;
  const heightRef = useRef(null);

  // 단일 명령 전송
  const sendJack = async (action, payload = {}) => {
    if (!robotId) return;
    const ep = JACK_ENDPOINTS[action];
    if (!ep) return;
    try {
      await axios.post(`${API}/api/robots/${robotId}/jack/${ep}`, payload);
      message.success(`Jack ${ep} 요청 성공`);
    } catch (err) {
      message.error(`Jack ${ep} 오류: ${err.message}`);
    }
  };

  const mkBtn = (action, Icon) => (
    <Button
      shape="circle"
      disabled={disabled}
      icon={<Icon style={{ fontSize: ICON }} />}
      style={{
        ...btnStyle,
        width: SIZE,
        height: SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${token.colorFillSecondary}`,
        color: token.colorTextDisabled,
      }}
      onMouseEnter={(e) => elevate(e)}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = btnStyle.boxShadow || "none";
        e.currentTarget.style.color = token.colorTextDisabled;
      }}
      onMouseDown={(e) => {
        depress(e);
        sendJack(action);
      }}
      onMouseUp={(e) => {
        elevate(e);
      }}
    />
  );

  return (
    <div
      style={{
        flex: 1,
        minWidth: 260,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: token.colorTextSecondary,
          marginBottom: 6,
        }}
      >
        리프트
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          marginTop: 40,
          marginBottom: 20,
        }}
      >
        <Space direction="vertical" size="small">
          {mkBtn("up", VerticalAlignTopOutlined)}
          {mkBtn("stop", PauseCircleOutlined)}
          {mkBtn("down", VerticalAlignBottomOutlined)}
        </Space>

        <Space direction="vertical" size="small">
          <InputNumber
            placeholder="m"
            step={0.1}
            ref={heightRef}
            disabled={disabled}
            style={{ width: 120 }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={disabled || heightRef.current == null}
            onClick={() => sendJack("set", { height: heightRef.current.value })}
          >
            전송
          </Button>
        </Space>
      </div>
    </div>
  );
}
