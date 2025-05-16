// src/components/SideNav.jsx
import React from "react";
import { Menu } from "antd";
import {
  HomeOutlined,
  ToolOutlined,
  DatabaseOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { useNavigate, useLocation } from "react-router-dom";

const items = [
  { key: "/", icon: <HomeOutlined />, label: "메인" },
  { key: "/map", icon: <ToolOutlined />, label: "맵 설정" },
  { key: "/logs", icon: <DatabaseOutlined />, label: "이송 로그" },
  { key: "/settings", icon: <SettingOutlined />, label: "기타 설정" },
];

export default function SideNav({ collapsed }) {
  const nav = useNavigate();
  const { pathname } = useLocation();

  return (
    <Menu
      mode="inline"
      theme="light"
      items={items}
      selectedKeys={[pathname]}
      onClick={({ key }) => nav(key)}
      inlineCollapsed={collapsed} // ← 아이콘만 남도록
      className="menu-vertical-center" // ← 세로 중앙
      style={{ borderInlineEnd: 0 }}
    />
  );
}
