import React, { useMemo, useState } from "react";
import {
  Card,
  Table,
  DatePicker,
  Select,
  Button,
  Space,
  Spin,
  Tabs,
} from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useAtomValue } from "jotai";
import { robotsQueryAtom } from "@/state/atoms";
import { useLogs } from "@/hooks/useApiClient";
import { Resizable } from "react-resizable";
import "react-resizable/css/styles.css";

const { RangePicker } = DatePicker;

/* ────────── Resizable 헤더 셀 ────────── */
const ResizableTitle = (props) => {
  const { onResize, width, ...rest } = props;
  if (!width) return <th {...rest} />;
  return (
    <Resizable
      width={width}
      height={0}
      handle={
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: "5px",
            cursor: "col-resize",
          }}
        />
      }
      onResize={onResize}
      draggableOpts={{ enableUserSelectHack: false }}
    >
      <th
        {...rest}
        style={{ position: "relative", borderRight: "1px solid #f0f0f0" }}
      />
    </Resizable>
  );
};

/* ────────── CSV 내보내기 헬퍼 ────────── */
function exportCSV(rows, fields, filename) {
  if (!rows.length) return;
  const header = Object.values(fields).join(",") + "\n";
  const body = rows
    .map((r) =>
      Object.keys(fields)
        .map((k) => JSON.stringify(r[k] ?? ""))
        .join(",")
    )
    .join("\n");
  const blob = new Blob(["\uFEFF" + header + body], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ────────── 메인 컴포넌트 ────────── */
export default function LogDashboard() {
  const robotsQ = useAtomValue(robotsQueryAtom);
  const robots = robotsQ.data ?? [];

  const [range, setRange] = useState([null, null]);
  const [amrName, setAmrName] = useState();

  const { data: raw = [], isLoading } = useLogs();

  /* --- 타입별 분리 --- */
  const transportRows = useMemo(
    () => raw.filter((r) => r.type !== "CONN"),
    [raw]
  );
  const connRows = useMemo(() => raw.filter((r) => r.type === "CONN"), [raw]);

  /* --- 공통 필터 적용 --- */
  const applyFilters = (rows) =>
    rows.filter((row) => {
      if (range[0] && range[1]) {
        const t = dayjs(row.timestamp);
        if (
          t.isBefore(dayjs(range[0]).startOf("day")) ||
          t.isAfter(dayjs(range[1]).endOf("day"))
        )
          return false;
      }
      if (amrName && row.robot_name !== amrName) return false;
      return true;
    });

  const displayTransport = useMemo(
    () => applyFilters(transportRows),
    [transportRows, range, amrName]
  );
  const displayConn = useMemo(
    () => applyFilters(connRows),
    [connRows, range, amrName]
  );

  /* --- 열 정의 --- */
  const baseCols = [
    { title: "ID", dataIndex: "id", width: 80, sorter: (a, b) => a.id - b.id },
    {
      title: "시간",
      dataIndex: "timestamp",
      width: 160,
      render: (v) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
      sorter: (a, b) =>
        dayjs(a.timestamp).valueOf() - dayjs(b.timestamp).valueOf(),
    },
    {
      title: "AMR",
      dataIndex: "robot_name",
      width: 120,
      filters: robots.map((r) => ({ text: r.name, value: r.name })),
      onFilter: (v, r) => r.robot_name === v,
    },
  ];

  const transportColsInit = [
    ...baseCols,
    { title: "유형", dataIndex: "type", width: 120 },
    { title: "메시지", dataIndex: "message", width: 200, ellipsis: true },
    { title: "상태", dataIndex: "status", width: 100 },
    { title: "출발지", dataIndex: "from", width: 120 },
    { title: "목적지", dataIndex: "to", width: 120 },
    { title: "세부", dataIndex: "detail", width: 150, ellipsis: true },
  ];

  const connColsInit = [
    ...baseCols,
    {
      title: "상태",
      dataIndex: "status",
      width: 120,
      filters: [
        { text: "conn", value: "conn" },
        { text: "disconn", value: "disconn" },
      ],
      onFilter: (v, r) => r.status === v,
    },
    { title: "메시지", dataIndex: "message", width: 200, ellipsis: true },
  ];

  const [transCols, setTransCols] = useState(transportColsInit);
  const [connCols, setConnCols] = useState(connColsInit);

  /* ── Resizable 래퍼: onHeaderCell 은 ‘함수’ 여야 함 ── */
  const wrapResizable = (cols, setCols) =>
    cols.map((col, idx) =>
      col.width
        ? {
            ...col,
            onHeaderCell: (column) => ({
              width: column.width,
              onResize: (e, { size }) => {
                setCols((prev) => {
                  const next = [...prev];
                  next[idx] = { ...next[idx], width: size.width };
                  return next;
                });
              },
            }),
          }
        : col
    );

  const components = { header: { cell: ResizableTitle } };

  /* --- 공통 컨트롤 --- */
  const filters = (
    <Space wrap style={{ marginBottom: 16 }}>
      <RangePicker value={range} onChange={setRange} allowClear />
      <Select
        allowClear
        placeholder="AMR 선택"
        options={robots.map((r) => ({ label: r.name, value: r.name }))}
        style={{ minWidth: 120 }}
        value={amrName}
        onChange={setAmrName}
        loading={robotsQ.isLoading}
      />
    </Space>
  );

  const csvBtn = (rows, fields, name) => (
    <Button
      icon={<DownloadOutlined />}
      disabled={!rows.length}
      onClick={() => exportCSV(rows, fields, name)}
    >
      CSV 다운로드
    </Button>
  );

  /* ────────── 렌더 ────────── */
  return (
    <div
      style={{
        padding: 24,
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Card
        size="small"
        title="로그 대시보드"
        style={{ flex: 1, minHeight: 0 }}
        bodyStyle={{ padding: 16, display: "flex", flexDirection: "column" }}
      >
        {filters}
        {isLoading ? (
          <Spin style={{ marginTop: 32 }} />
        ) : (
          <Tabs defaultActiveKey="transport" style={{ flex: 1, minHeight: 0 }}>
            <Tabs.TabPane tab="이송 지시 로그" key="transport">
              {csvBtn(
                displayTransport,
                {
                  id: "ID",
                  timestamp: "Timestamp",
                  type: "Type",
                  message: "Message",
                  robot_name: "AMR",
                  status: "Status",
                  from: "From",
                  to: "To",
                  detail: "Detail",
                },
                "transport_logs.csv"
              )}
              <Table
                components={components}
                columns={wrapResizable(transCols, setTransCols)}
                dataSource={displayTransport}
                rowKey="id"
                size="small"
                pagination={{ pageSize: 20, showSizeChanger: false }}
                scroll={{ y: 480 }}
                style={{ marginTop: 12 }}
              />
            </Tabs.TabPane>

            <Tabs.TabPane tab="연결 로그" key="conn">
              {csvBtn(
                displayConn,
                {
                  id: "ID",
                  timestamp: "Timestamp",
                  robot_name: "AMR",
                  status: "Status",
                  message: "Message",
                },
                "connection_logs.csv"
              )}
              <Table
                components={components}
                columns={wrapResizable(connCols, setConnCols)}
                dataSource={displayConn}
                rowKey="id"
                size="small"
                pagination={{ pageSize: 20, showSizeChanger: false }}
                scroll={{ y: 480 }}
                style={{ marginTop: 12 }}
              />
            </Tabs.TabPane>
          </Tabs>
        )}
      </Card>
    </div>
  );
}
