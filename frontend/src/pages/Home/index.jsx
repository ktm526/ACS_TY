import React from "react";
import { ConfigProvider } from "antd";
import Canvas from "./Canvas";
import AMRStatus from "./AMRStatus";

export default function Home() {
  return (
    <ConfigProvider
      theme={{
        components: {
          Card: {
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            borderRadius: 8,
          },
        },
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateRows: "auto 1fr",
          rowGap: 24,
          height: "100vh", // 1) 100% 높이 유지
          padding: 24,
          boxSizing: "border-box", // 2) 패딩을 높이에 포함
          overflowY: "hidden",
        }}
      >
        {/* 상단: AMR 상태 */}
        <AMRStatus />

        {/* 하단: 모니터링 캔버스 */}
        <div style={{ height: "100%", minheight: 0, minWidth: 0 }}>
          <Canvas />
        </div>
      </div>
    </ConfigProvider>
  );
}
