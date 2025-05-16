import React from "react";
import { Modal, Tabs, Table, Descriptions, Progress, Badge, Tag } from "antd";

export default function AmrDetailModal({ open, onClose, amrInfo, token }) {
  if (!amrInfo) return null;

  const di = amrInfo.DI ?? [],
    doArr = amrInfo.DO ?? [];
  const errs = [
    ...(amrInfo.errors ?? []).map((e) => ({ ...e, level: "ERROR" })),
    ...(amrInfo.warnings ?? []).map((e) => ({ ...e, level: "WARNING" })),
    ...(amrInfo.fatals ?? []).map((e) => ({ ...e, level: "FATAL" })),
  ];
  const battery = {
    lvl: amrInfo.battery_level,
    v: amrInfo.voltage,
    a: amrInfo.current,
    t: amrInfo.battery_temp,
  };
  const imu = {
    acc_x: amrInfo.acc_x,
    acc_y: amrInfo.acc_y,
    acc_z: amrInfo.acc_z,
    roll: amrInfo.roll,
    pitch: amrInfo.pitch,
    yaw: amrInfo.yaw,
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="80%"
      destroyOnClose
      title="AMR 상세 정보"
    >
      <Tabs
        defaultActiveKey="io"
        items={[
          {
            key: "io",
            label: `IO (${di.length} DI / ${doArr.length} DO)`,
            children: (
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                scroll={{ y: 260 }}
                dataSource={[
                  ...di.map((x) => ({ ...x, type: "DI" })),
                  ...doArr.map((x) => ({ ...x, type: "DO" })),
                ]}
                columns={[
                  { title: "Type", dataIndex: "type", width: 70 },
                  { title: "ID", dataIndex: "id", width: 60 },
                  {
                    title: "State",
                    dataIndex: "status",
                    width: 90,
                    render: (v) => (
                      <Badge
                        color={v ? token.colorSuccess : token.colorError}
                        text={v ? "ON" : "OFF"}
                      />
                    ),
                  },
                  {
                    title: "Valid",
                    dataIndex: "valid",
                    width: 80,
                    render: (v) =>
                      v ? (
                        <Tag color="green">OK</Tag>
                      ) : (
                        <Tag color="red">ERR</Tag>
                      ),
                  },
                ]}
              />
            ),
          },
          {
            key: "battery",
            label: "Battery & Power",
            children: (
              <Descriptions size="small" bordered column={2}>
                <Descriptions.Item label="SOC">
                  {battery.lvl != null ? (
                    <Progress
                      percent={Math.round(battery.lvl * 100)}
                      size="small"
                      format={(p) => `${p}%`}
                    />
                  ) : (
                    "—"
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="Temperature">
                  {battery.t ?? "—"} {battery.t && "°C"}
                </Descriptions.Item>
                <Descriptions.Item label="Voltage">
                  {battery.v ?? "—"} {battery.v && "V"}
                </Descriptions.Item>
                <Descriptions.Item label="Current">
                  {battery.a ?? "—"} {battery.a && "A"}
                </Descriptions.Item>
              </Descriptions>
            ),
          },
          {
            key: "imu",
            label: "IMU / Pose",
            children: (
              <Descriptions size="small" bordered column={3}>
                {Object.entries(imu).map(([k, v]) => (
                  <Descriptions.Item label={k} key={k}>
                    {v != null ? v.toFixed(3) : "—"}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            ),
          },
          {
            key: "errors",
            label: `Errors (${errs.length})`,
            children: (
              <Table
                size="small"
                rowKey={(r, i) => `${r.level}-${i}`}
                pagination={false}
                scroll={{ y: 260 }}
                dataSource={errs}
                columns={[
                  {
                    title: "Level",
                    dataIndex: "level",
                    width: 90,
                    render: (v) => (
                      <Tag
                        color={
                          v === "FATAL"
                            ? "red"
                            : v === "ERROR"
                            ? "volcano"
                            : "orange"
                        }
                      >
                        {v}
                      </Tag>
                    ),
                  },
                  { title: "Code", dataIndex: "code", width: 80 },
                  { title: "Desc", dataIndex: "desc", ellipsis: true },
                  {
                    title: "Time",
                    dataIndex: "dateTime",
                    width: 180,
                    render: (v) => v ?? "—",
                  },
                  { title: "Times", dataIndex: "times", width: 80 },
                ]}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}
