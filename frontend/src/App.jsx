// src/App.jsx
import React, { useState, useEffect } from "react";
import { Layout } from "antd";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import SideNav from "@/components/SideNav";
// ─── Home.jsx 파일이 src/pages/Home 폴더 안에 있다면 이렇게 import ───
import Home from "@/pages/Home";
import MapSettings from "@/pages/MapSettings";
import TransportLogs from "@/pages/TransportLogs";
import MiscSettings from "@/pages/MiscSettings";
import MobileStatus from "@/pages/Mobile/MobileStatus";
import logo from "@/assets/logo.png";

const { Sider, Content } = Layout;

export default function App() {
  const location = useLocation();
  const isMobile = location.pathname.startsWith('/mobile');

  // ① localStorage 에서 불러오기, 기본값 false
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("siderCollapsed")) ?? false;
    } catch {
      return false;
    }
  });

  // ② collapsed 변경 시 localStorage 에 저장
  useEffect(() => {
    localStorage.setItem("siderCollapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  // 바깥(메뉴 아이템 아닌) 클릭 시 토글
  const handleSiderClick = (e) => {
    if (!e.target.closest(".ant-menu-item")) {
      setCollapsed((prev) => !prev);
    }
  };

  // 모바일 전용 레이아웃
  if (isMobile) {
    return (
      <Layout style={{ minHeight: "100vh" }}>
        <Content style={{ padding: 0 }}>
          <Routes>
            <Route path="/mobile" element={<MobileStatus />} />
          </Routes>
        </Content>
      </Layout>
    );
  }

  // 데스크톱 레이아웃
  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        className="ello-sider"
        width={200}
        collapsed={collapsed}
        collapsedWidth={64}
        trigger={null}
        theme="light"
        style={{ background: "#fff", display: "flex", flexDirection: "column" }}
        onClick={handleSiderClick}
      >
        {/* ─── 로고 영역 (접히면 숨김) ─── */}
        {!collapsed && (
          <div className="ello-logo-box">
            <img src={logo} alt="ELLO" style={{ height: 32 }} />
          </div>
        )}

        {/* ─── 메뉴 (항상 세로 가운데) ─── */}
        <div className="menu-wrapper">
          <SideNav collapsed={collapsed} />
        </div>
      </Sider>

      <Layout>
        <Content style={{ padding: 0 }}>
          <Routes>
            <Route path="/" element={<Home />}  />
            {/* <Route path="/" element={<Navigate to="/home" replace />} /> */}
            {/* <Route path="/home" element={<Home />} /> */}
            <Route path="/map" element={<MapSettings />} />
            <Route path="/logs" element={<TransportLogs />} />
            <Route path="/settings" element={<MiscSettings />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
