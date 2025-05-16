import React, { useRef } from "react";
import axios from "axios";
import { Button, theme, message } from "antd";
import {
  UpCircleOutlined,
  DownCircleOutlined,
  LeftCircleOutlined,
  RightCircleOutlined,
} from "@ant-design/icons";

const API = import.meta.env.VITE_CORE_BASE_URL;

export default function AmrMotionPad({
  robotId,
  speed = 0.3,
  angularSpeed = 1.0,
  disabled = false,
  btnStyle = {},
}) {
  const { token } = theme.useToken();
  const SIZE = 80;
  const ICON = 28;
  const intervalRef = useRef(null);

  const motionParams = {
    up: { vx: speed, vy: 0, w: 0 },
    down: { vx: -speed, vy: 0, w: 0 },
    left: { vx: 0, vy: 0, w: angularSpeed },
    right: { vx: 0, vy: 0, w: -angularSpeed },
    stop: { vx: 0, vy: 0, w: 0 },
  };

  const sendOnce = async (dir) => {
    if (!robotId) return;
    const { vx, vy, w } = motionParams[dir];
    try {
      await axios.post(`${API}/api/robots/${robotId}/motion`, {
        vx,
        vy,
        w,
        duration: 500,
      });
    } catch (err) {
      message.error(`Motion error: ${err.message}`);
    }
  };

  const startContinuous = (dir) => {
    sendOnce(dir);
    intervalRef.current = setInterval(() => sendOnce(dir), 100);
  };

  const stopContinuous = () => {
    clearInterval(intervalRef.current);
    sendOnce("stop");
  };

  const mkBtn = (dir, Icon) => (
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
        transition: "all .2s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = `0 0 8px ${token.colorPrimary}66`;
        e.currentTarget.style.borderColor = token.colorPrimary;
        e.currentTarget.style.color = token.colorPrimary;
      }}
      onMouseLeave={(e) => {
        stopContinuous();
        e.currentTarget.style.boxShadow = btnStyle.boxShadow || "";
        e.currentTarget.style.borderColor = token.colorFillSecondary;
        e.currentTarget.style.color = token.colorTextDisabled;
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.boxShadow = `inset 0 0 6px ${token.colorPrimary}`;
        e.currentTarget.style.borderColor = token.colorPrimary;
        e.currentTarget.style.color = token.colorPrimary;
        startContinuous(dir);
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.boxShadow = `0 0 8px ${token.colorPrimary}66`;
        e.currentTarget.style.borderColor = token.colorPrimary;
        e.currentTarget.style.color = token.colorPrimary;
        stopContinuous();
      }}
    />
  );

  return (
    <div
      style={{
        flex: 1,
        minWidth: SIZE * 3 + 64,
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
        수동 제어
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(3, ${SIZE}px)`,
          gridTemplateRows: `repeat(3, ${SIZE}px)`,
          gap: 6,
          marginTop: 20,
          marginBottom: 20,
        }}
      >
        <span />
        {mkBtn("up", UpCircleOutlined)}
        <span />
        {mkBtn("left", LeftCircleOutlined)}
        <span />
        {mkBtn("right", RightCircleOutlined)}
        <span />
        {mkBtn("down", DownCircleOutlined)}
        <span />
      </div>
    </div>
  );
}
