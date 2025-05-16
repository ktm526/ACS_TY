// src/pages/MapSettings/MapDetailModal.jsx
import React, { useMemo, useState } from "react";
import {
  Modal,
  Tabs,
  List,
  Collapse,
  Input,
  Select,
  Button,
  theme,
  message,
} from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";

const { Panel } = Collapse;
const CLASS_OPTIONS = [
  "충전",
  "A",
  "B",
  "버퍼",
  "적하",
  "경로",
  "대기",
  "door",
  "IC",
];

export default function MapDetailModal({ open, onClose, mapData, apiBase }) {
  const { token } = theme.useToken();
  const qc = useQueryClient();

  /* 파싱 & 로컬 상태 */
  const [stations, setStations] = useState(() => {
    try {
      return JSON.parse(mapData?.stations || "{}").stations || [];
    } catch {
      return [];
    }
  });
  const paths = useMemo(() => {
    try {
      return JSON.parse(mapData?.paths || "{}").paths || [];
    } catch {
      return [];
    }
  }, [mapData]);

  /* name / class 편집 핸들러 */
  const updateStation = (idx, patch) =>
    setStations((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s))
    );

  /* 저장 mutation */
  const saveMut = useMutation({
    mutationFn: async () => {
      await fetch(`${apiBase}/api/maps/${mapData.id}/stations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stations }),
      });
    },
    onSuccess: () => {
      message.success("저장되었습니다.");
      qc.invalidateQueries({ queryKey: ["serverMaps"] });
      onClose();
    },
    onError: () => message.error("저장 실패"),
  });

  return (
    <Modal
      open={open}
      title={`맵 상세 – ${mapData?.name}`}
      onCancel={onClose}
      width={800}
      footer={[
        <Button key="cancel" onClick={onClose}>
          닫기
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saveMut.isLoading}
          onClick={() => saveMut.mutate()}
        >
          저장
        </Button>,
      ]}
      destroyOnClose
    >
      <Tabs
        defaultActiveKey="stations"
        items={[
          {
            key: "stations",
            label: `스테이션 (${stations.length})`,
            children: (
              <Collapse accordion>
                {stations.map((st, idx) => (
                  <Panel
                    key={st.id}
                    header={`${st.id}  (${st.class?.join(", ") || ""})`}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: token.marginSM,
                      }}
                    >
                      <div>
                        <strong>ID: </strong>
                        {st.id}
                      </div>
                      <div>
                        <strong>Name:</strong>{" "}
                        <Input
                          value={st.name ?? st.id}
                          onChange={(e) =>
                            updateStation(idx, { name: e.target.value })
                          }
                          style={{ maxWidth: 200 }}
                        />
                      </div>
                      <div>
                        <strong>Class:</strong>{" "}
                        <Select
                          mode="tags"
                          placeholder="클래스 선택"
                          options={CLASS_OPTIONS.map((c) => ({
                            value: c,
                            label: c,
                          }))}
                          value={st.class || []}
                          onChange={(vals) =>
                            updateStation(idx, { class: vals })
                          }
                          style={{ minWidth: 200 }}
                        />
                      </div>
                    </div>
                  </Panel>
                ))}
              </Collapse>
            ),
          },
          {
            key: "paths",
            label: `패스 (${paths.length})`,
            children: (
              <List
                size="small"
                bordered
                dataSource={paths}
                renderItem={(p) => (
                  <List.Item>{`${p.start} → ${p.end}`}</List.Item>
                )}
                style={{ maxHeight: 400, overflowY: "auto" }}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}
