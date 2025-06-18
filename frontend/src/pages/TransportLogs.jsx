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
import { useLogs, useTaskExecutionLogs } from "@/hooks/useApiClient";
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

  /* --- 태스크 실행 로그 데이터 --- */
  const { data: taskExecutionRaw = [], isLoading: isTaskExecutionLoading } = useTaskExecutionLogs();

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

  /* --- 태스크 실행 로그 필터링 --- */
  const displayTaskExecution = useMemo(() => {
    return taskExecutionRaw.filter((row) => {
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
  }, [taskExecutionRaw, range, amrName]);

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

  /* --- 태스크 실행 로그 컬럼 --- */
  const taskExecutionColsInit = [
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
    {
      title: "이벤트",
      dataIndex: "event_type",
      width: 140,
      filters: [
        { text: "버튼 눌림", value: "BUTTON_PRESSED" },
        { text: "태스크 할당", value: "TASK_ASSIGNED" },
        { text: "태스크 시작", value: "TASK_STARTED" },
        { text: "스텝 시작", value: "STEP_STARTED" },
        { text: "스텝 완료", value: "STEP_COMPLETED" },
        { text: "스텝 실패", value: "STEP_FAILED" },
        { text: "태스크 일시정지", value: "TASK_PAUSED" },
        { text: "태스크 재개", value: "TASK_RESUMED" },
        { text: "태스크 취소", value: "TASK_CANCELED" },
        { text: "태스크 완료", value: "TASK_COMPLETED" },
        { text: "태스크 실패", value: "TASK_FAILED" },
      ],
      onFilter: (v, r) => r.event_type === v,
      render: (value) => {
        const eventMap = {
          BUTTON_PRESSED: "버튼 눌림",
          TASK_ASSIGNED: "태스크 할당",
          TASK_STARTED: "태스크 시작",
          STEP_STARTED: "스텝 시작",
          STEP_COMPLETED: "스텝 완료",
          STEP_FAILED: "스텝 실패",
          TASK_PAUSED: "태스크 일시정지",
          TASK_RESUMED: "태스크 재개",
          TASK_CANCELED: "태스크 취소",
          TASK_COMPLETED: "태스크 완료",
          TASK_FAILED: "태스크 실패",
        };
        return eventMap[value] || value;
      },
    },
    { title: "태스크 ID", dataIndex: "task_id", width: 100 },
    { title: "스텝 순서", dataIndex: "step_seq", width: 100 },
    { title: "스텝 타입", dataIndex: "step_type", width: 120 },
    {
      title: "소요 시간",
      dataIndex: "duration_ms",
      width: 120,
      render: (value) => {
        if (!value) return "-";
        if (value < 1000) return `${value}ms`;
        return `${(value / 1000).toFixed(1)}s`;
      },
    },
    { title: "출발지", dataIndex: "from_location", width: 120 },
    { title: "목적지", dataIndex: "to_location", width: 120 },
    {
      title: "상세 정보",
      dataIndex: "details",
      width: 200,
      ellipsis: true,
      render: (value, record) => {
        if (!value) return "-";
        try {
          const parsed = JSON.parse(value);
          
          // NAV/NAV_PRE 스텝인 경우 출발지와 목적지 정보 포함
          if ((record.step_type === 'NAV' || record.step_type === 'NAV_PRE') && 
              record.from_location && record.to_location) {
            return `${parsed.description} (${record.from_location} → ${record.to_location})`;
          }
          
          return parsed.description || value;
        } catch {
          return value;
        }
      },
    },
    { title: "오류 메시지", dataIndex: "error_message", width: 200, ellipsis: true },
  ];

  const [transCols, setTransCols] = useState(transportColsInit);
  const [connCols, setConnCols] = useState(connColsInit);
  const [taskExecutionCols, setTaskExecutionCols] = useState(taskExecutionColsInit);

  /* ── Resizable 래퍼: onHeaderCell 은 '함수' 여야 함 ── */
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
        {isLoading || isTaskExecutionLoading ? (
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

            <Tabs.TabPane tab="태스크 실행 로그" key="taskExecution">
              {csvBtn(
                displayTaskExecution,
                {
                  id: "ID",
                  timestamp: "Timestamp",
                  robot_name: "AMR",
                  event_type: "Event Type",
                  task_id: "Task ID",
                  step_seq: "Step Seq",
                  step_type: "Step Type",
                  duration_ms: "Duration (ms)",
                  from_location: "From",
                  to_location: "To",
                  details: "Details",
                  error_message: "Error",
                },
                "task_execution_logs.csv"
              )}
              <Table
                components={components}
                columns={wrapResizable(taskExecutionCols, setTaskExecutionCols)}
                dataSource={displayTaskExecution}
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
