import React from "react";
import { ConfigProvider } from "antd";
import ServerMapFile from "./ServerMapFile";
import AMRMapFile from "./AMRMapFile";

export default function MapSettings() {
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
          gridTemplateColumns: "2fr 1fr", // 2:1 비율
          gap: 24,
          height: "100%",
          padding: 24,
          overflowY: "hidden",
        }}
      >
        <ServerMapFile />
        <AMRMapFile />
      </div>
    </ConfigProvider>
  );
}
