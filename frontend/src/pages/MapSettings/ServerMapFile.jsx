// src/pages/MapSettings/ServerMapFile.jsx
import React, { useRef, useState } from "react";
import { Card, Button, List, Spin, Popconfirm, theme, Typography } from "antd";
import {
  UploadOutlined,
  FileOutlined,
  EyeOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
//import MapViewerModal from "./MapViewerModal";
import MapDetailModal from "./MapDetailModal";

const { Text } = Typography;

export default function ServerMapFile() {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const fileInputRef = useRef(null);

  const [hoveredId, setHoveredId] = useState(null);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [selectedMap, setSelectedMap] = useState(null);

  const CORE_API = import.meta.env.VITE_CORE_BASE_URL; //|| "http://localhost:4000";

  /* ───────── ① maps 조회 ───────── */
  const mapsQuery = useQuery({
    queryKey: ["serverMaps"],
    queryFn: async () => {
      const res = await fetch(`${CORE_API}/api/maps`);
      return await res.json(); // ← 배열 그대로
    },
  });

  /* ───────── ② 업로드 (.smap / .json) ───────── */
  const uploadMut = useMutation({
    mutationFn: async (files) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("mapFile", f));
      const res = await fetch(`${CORE_API}/api/maps/import`, {
        method: "POST",
        body: fd,
      });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["serverMaps"] }),
  });

  /* ───────── ③ 삭제 ───────── */
  const delMut = useMutation({
    mutationFn: (id) =>
      fetch(`${CORE_API}/api/maps/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["serverMaps"] }),
  });

  /* ───────── UI 핸들러 ───────── */
  const triggerFile = () => fileInputRef.current.click();
  const onFileChange = (e) => {
    const list = Array.from(e.target.files || []);
    if (list.length) uploadMut.mutate(list);
    e.target.value = "";
  };
  const openViewer = (m) => {
    setSelectedMap(m);
    setViewerVisible(true);
  };
  const [detailOpen, setDetailOpen] = useState(false);

  /* ───────── 컴포넌트 ───────── */
  return (
    <>
      <Card
        size="small"
        title="서버 맵 파일"
        style={{ height: "100%" }}
        bodyStyle={{
          display: "flex",
          flexDirection: "column",
          padding: token.padding,
        }}
      >
        {/* 업로드 버튼 */}
        <Button
          icon={<UploadOutlined />}
          onClick={triggerFile}
          style={{ marginBottom: token.paddingSM }}
          loading={uploadMut.isLoading}
        >
          업로드
        </Button>
        <input
          type="file"
          multiple
          accept=".smap,.json"
          ref={fileInputRef}
          hidden
          onChange={onFileChange}
        />

        {/* 리스트 */}
        {mapsQuery.isPending ? (
          <Spin style={{ marginTop: token.padding }} />
        ) : mapsQuery.isError ? (
          <Text type="danger">맵을 불러오는 중 오류가 발생했습니다.</Text>
        ) : (
          <List
            dataSource={mapsQuery.data}
            style={{ flex: 1, overflowY: "auto" }}
            renderItem={(map) => (
              <List.Item
                key={map.id}
                onMouseEnter={() => setHoveredId(map.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  cursor: "pointer",
                  borderRadius: token.borderRadius,
                  boxShadow:
                    hoveredId === map.id
                      ? "0 2px 8px rgba(0,0,0,0.15)"
                      : undefined,
                  margin: `0 0 ${token.paddingXS}px 0`,
                  padding: `${token.paddingXS}px ${token.padding}px`,
                }}
                actions={[
                  <Button
                    key="view"
                    icon={<EyeOutlined />}
                    size="small"
                    onClick={() => setDetailOpen(map)}
                  />,
                  <Popconfirm
                    key="del"
                    title="정말 삭제하시겠습니까?"
                    onConfirm={() => delMut.mutate(map.id)}
                  >
                    <Button
                      icon={<DeleteOutlined />}
                      danger
                      size="small"
                      loading={delMut.isLoading}
                    />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <FileOutlined
                      style={{
                        fontSize: token.fontSizeIcon,
                        color: token.colorTextSecondary,
                      }}
                    />
                  }
                  title={map.name}
                  description={
                    map.last_updated
                      ? new Date(map.last_updated).toLocaleString()
                      : "―"
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 미리보기 모달 */}
      {detailOpen && (
        <MapDetailModal
          open={!!detailOpen}
          onClose={() => setDetailOpen(false)}
          mapData={detailOpen}
          apiBase={CORE_API}
        />
      )}
    </>
  );
}
