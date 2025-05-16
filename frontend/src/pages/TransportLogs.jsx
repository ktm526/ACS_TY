import React, { useMemo, useState } from "react";
import { Card, Table, DatePicker, Select, Button, Space, Spin } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useAtomValue } from "jotai";
import { robotsQueryAtom } from "@/state/atoms";
import { useLogs } from "@/hooks/useApiClient";
import { Resizable } from "react-resizable";
import "react-resizable/css/styles.css";

const { RangePicker } = DatePicker;

// Resizable header cell component using header divider for resize
const ResizableTitle = (props) => {
  const { onResize, width, ...restProps } = props;
  // non-resizable cell with divider
  if (!width) {
    return <th {...restProps} style={{ borderRight: "1px solid #f0f0f0" }} />;
  }
  return (
    <Resizable
      width={width}
      height={0}
      handle={
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: "5px",
            cursor: "col-resize",
            zIndex: 1,
          }}
        />
      }
      onResize={onResize}
      draggableOpts={{ enableUserSelectHack: false }}
    >
      <th
        {...restProps}
        style={{ position: "relative", borderRight: "1px solid #f0f0f0" }}
      />
    </Resizable>
  );
};

export default function TransportLogs() {
  const [range, setRange] = useState([null, null]);
  const [amrName, setAmrName] = useState();

  const robotsQ = useAtomValue(robotsQueryAtom);
  const robots = robotsQ.data || [];
  const { data: raw = [], isLoading } = useLogs();

  const data = useMemo(
    () =>
      raw.filter((row) => {
        if (range[0] && range[1]) {
          const t = dayjs(row.timestamp);
          if (
            t.isBefore(range[0].startOf("day")) ||
            t.isAfter(range[1].endOf("day"))
          )
            return false;
        }
        if (amrName && row.robot_name !== amrName) return false;
        return true;
      }),
    [raw, range, amrName]
  );

  const amrOpts = useMemo(
    () => robots.map((r) => ({ label: r.name, value: r.name })),
    [robots]
  );

  const [columns, setColumns] = useState([
    { title: "ID", dataIndex: "id", width: 80, sorter: (a, b) => a.id - b.id },
    {
      title: "시간",
      dataIndex: "timestamp",
      width: 160,
      render: (v) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
      sorter: (a, b) => dayjs(a.timestamp).unix() - dayjs(b.timestamp).unix(),
    },
    { title: "유형", dataIndex: "type", width: 120 },
    { title: "메시지", dataIndex: "message", ellipsis: true, width: 200 },
    {
      title: "AMR",
      dataIndex: "robot_name",
      width: 120,
      filters: amrOpts.map((o) => ({ text: o.label, value: o.value })),
      onFilter: (v, r) => r.robot_name === v,
    },
    { title: "상태", dataIndex: "status", width: 100 },
    { title: "출발지", dataIndex: "from", width: 120 },
    { title: "목적지", dataIndex: "to", width: 120 },
    { title: "세부", dataIndex: "detail", width: 150 },
  ]);

  const handleResize =
    (index) =>
    (e, { size }) => {
      setColumns((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], width: size.width };
        return next;
      });
    };

  const resizableColumns = columns.map((col, idx) => ({
    ...col,
    onHeaderCell: (column) => ({
      width: column.width,
      onResize: handleResize(idx),
    }),
    onCell: () => ({
      style: {
        borderRight: idx < columns.length - 1 ? "1px solid #f0f0f0" : undefined,
      },
    }),
  }));

  const components = { header: { cell: ResizableTitle } };

  function exportCSV(rows, fields, filename = "transport_logs.csv") {
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
        title="이송 지시 로그"
        bodyStyle={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
        style={{ flex: 1, minHeight: 0 }}
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <RangePicker value={range} onChange={setRange} allowClear />
          <Select
            allowClear
            placeholder="AMR 선택"
            options={amrOpts}
            style={{ minWidth: 120 }}
            value={amrName}
            onChange={setAmrName}
            loading={robotsQ.isLoading}
          />
          <Button
            icon={<DownloadOutlined />}
            disabled={!data.length}
            onClick={() =>
              exportCSV(data, {
                id: "ID",
                timestamp: "Timestamp",
                type: "Type",
                message: "Message",
                robot_name: "AMR",
                status: "Status",
                from: "From",
                to: "To",
                detail: "Detail",
              })
            }
          >
            CSV 다운로드
          </Button>
        </Space>
        {isLoading ? (
          <Spin style={{ marginTop: 32 }} />
        ) : (
          <Table
            components={components}
            columns={resizableColumns}
            dataSource={data}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ y: "100%" }}
          />
        )}
      </Card>
    </div>
  );
}
