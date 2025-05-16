import React from "react";
import { ConfigProvider } from "antd";
import AmrControlPanel from "./AmrControlPanel";
import GeneralSettings from "./GeneralSettings";

export default function MiscSettings() {
  return (
    <ConfigProvider
      theme={{
        components: {
          Card: { boxShadow: "0 4px 12px rgba(0,0,0,0.08)", borderRadius: 8 },
        },
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 24,
          padding: 24,
          height: "100%",
          boxSizing: "border-box",
        }}
      >
        {/* 상단: AMR 제어 */}
        <AmrControlPanel style={{ flex: "0 0 auto" }} />

        {/* 하단: 기타 설정 */}
        <GeneralSettings style={{ flex: "1 1 0%" }} />
      </div>
    </ConfigProvider>
  );
}
