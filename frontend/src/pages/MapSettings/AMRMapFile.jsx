import React, { useRef, useState } from "react";
import { atom, useAtomValue } from "jotai";
import { robotsQueryAtom, robotMapsAtomFamily } from "@/state/atoms";
import { Card, Collapse, List, Button, theme, Spin } from "antd";
import {
  UploadOutlined,
  DownloadOutlined,
  CheckCircleFilled,
} from "@ant-design/icons";

const { Panel } = Collapse;

/* 비어-있는 쿼리 결과용 dummy atom (useAtomValue 가 atom 필요) */
const emptyMapsAtom = atom({ data: [], isLoading: false });

export default function AMRMapFile() {
  const { token } = theme.useToken();

  /* AMR 목록 */
  const robotsQ = useAtomValue(robotsQueryAtom);
  const robots = robotsQ.data ?? [];

  /* 패널 열릴 때 로봇별 맵 목록 로딩 */
  const [activeId, setActiveId] = useState(null);
  const mapsAtom = activeId ? robotMapsAtomFamily(activeId) : emptyMapsAtom;
  const mapsQ = useAtomValue(mapsAtom);

  const handleDownload = (rid, name) => {
    window.open(
      `/api/robots/${rid}/maps/${encodeURIComponent(name)}`,
      "_blank"
    );
  };

  return (
    <Card
      size="small"
      title="AMR 맵 파일"
      bodyStyle={{ padding: token.padding, overflowY: "auto", height: "100%" }}
    >
      <Collapse
        bordered={false}
        expandIconPosition="right"
        activeKey={activeId ? [activeId] : []}
        onChange={(keys) => setActiveId(keys[0])}
        style={{ background: "transparent" }}
      >
        {robots.map((r) => (
          <Panel key={r.id} header={r.name}>
            {activeId === r.id && mapsQ.isLoading && <Spin />}

            {activeId === r.id && !mapsQ.isLoading && (
              <List
                size="small"
                dataSource={mapsQ.data}
                renderItem={(f) => (
                  <List.Item
                    actions={[
                      <Button
                        key="dl"
                        icon={<DownloadOutlined />}
                        size="small"
                        onClick={() => handleDownload(r.id, f.name)}
                      />,
                    ]}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      {/* 현재 로드된 맵 */}
                      {f.name === mapsQ.current_map && (
                        <CheckCircleFilled
                          style={{ color: token.colorPrimary }}
                        />
                      )}
                      <span>{f.name}</span>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Panel>
        ))}
      </Collapse>
    </Card>
  );
}
