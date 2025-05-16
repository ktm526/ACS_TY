// src/components/AmrStatusSection.jsx
import React from "react";
import { Select, Skeleton, Descriptions, Badge, Tag, Button } from "antd";
import { FileSearchOutlined } from "@ant-design/icons";

const STATUS_BADGE = {
  이동: "processing",
  대기: "success",
  오류: "error",
  "연결 끊김": "warning",
  unknown: "default",
};
const STATUS_TAG = {
  이동: "blue",
  대기: "green",
  오류: "red",
  "연결 끊김": "orange",
  unknown: "default",
};

export default function AmrStatusSection({
  robots,
  robotsLoading,
  amrId,
  setAmrId,
  amrInfo,
  onDetail,
}) {
  const hasInfo = amrId && !!amrInfo;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 260,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Select
        placeholder="AMR 선택"
        options={robots.map(({ id, name }) => ({
          value: id,
          label: name,
        }))}
        value={amrId}
        onChange={setAmrId}
        allowClear
        loading={robotsLoading}
      />

      <Descriptions size="small" bordered column={1} labelStyle={{ width: 90 }}>
        <Descriptions.Item label="이름">
          {hasInfo ? (
            amrInfo.name
          ) : (
            <Skeleton.Input size="small" style={{ width: 120 }} />
          )}
        </Descriptions.Item>
        <Descriptions.Item label="IP">
          {hasInfo ? (
            amrInfo.ip
          ) : (
            <Skeleton.Input size="small" style={{ width: 120 }} />
          )}
        </Descriptions.Item>
        <Descriptions.Item label="상태">
          {hasInfo ? (
            <>
              <Badge
                status={STATUS_BADGE[amrInfo.status] || "default"}
                style={{ marginRight: 6 }}
              />
              <Tag color={STATUS_TAG[amrInfo.status] || "default"}>
                {amrInfo.status}
              </Tag>
            </>
          ) : (
            <Skeleton.Input size="small" style={{ width: 80 }} />
          )}
        </Descriptions.Item>
        <Descriptions.Item label="좌표">
          {hasInfo ? (
            amrInfo.position
          ) : (
            <Skeleton.Input size="small" style={{ width: 100 }} />
          )}
        </Descriptions.Item>
        <Descriptions.Item label="위치">
          {hasInfo ? (
            amrInfo.location ?? "-"
          ) : (
            <Skeleton.Input size="small" style={{ width: 100 }} />
          )}
        </Descriptions.Item>
      </Descriptions>

      <div style={{ textAlign: "right" }}>
        <Button
          type="link"
          icon={<FileSearchOutlined />}
          disabled={!hasInfo}
          onClick={onDetail}
        >
          상세 보기
        </Button>
      </div>
    </div>
  );
}
