// src/components/AmrControlPanel.jsx
import React, { useState } from "react";
import { Card, Divider, message, theme } from "antd";
import { useAtomValue } from "jotai";
import { robotsQueryAtom } from "@/state/atoms";
import { useQuery, useMutation } from "@tanstack/react-query";
import AmrStatusSection from "./AmrStatusSection";
import AmrMotionPad from "./AmrMotionPad";
import AmrLiftSection from "./AmrLiftSection";
import AmrDetailModal from "./AmrDetailModal";

const API = import.meta.env.VITE_CORE_BASE_URL;

export default function AmrControlPanel({ style }) {
  const { token } = theme.useToken();
  const robotsQ = useAtomValue(robotsQueryAtom);
  const robots = robotsQ.data ?? [];
  const [amrId, setAmrId] = useState(null);

  const {
    data: amrInfo,
    isFetching,
    refetch,
  } = useQuery({
    enabled: !!amrId,
    queryKey: ["amr", amrId],
    queryFn: async () => {
      const res = await fetch(`${API}/api/robots/${amrId}`);
      if (!res.ok) throw new Error("로봇 정보를 가져오지 못했습니다");
      return res.json();
    },
    refetchInterval: 2000,
  });

  // rotate 만 기존 sendMut 사용
  const sendMut = useMutation({
    mutationFn: ({ path, body }) =>
      fetch(`${API}/api/robots/${amrId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => message.success("명령 전송 성공"),
    onError: () => message.error("명령 전송 실패"),
  });
  const rotate = (dir) =>
    sendMut.mutate({ path: "rotate", body: { direction: dir } });

  const [detailOpen, setDetailOpen] = useState(false);

  const btnBase = {
    transition: "all .15s",
    boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
  };
  const elevate = (e) =>
    (e.currentTarget.style.boxShadow = token.boxShadowSecondary) ||
    (e.currentTarget.style.color = token.colorPrimary);
  const depress = (e) =>
    (e.currentTarget.style.boxShadow = "inset 0 2px 4px rgba(0,0,0,0.18)");

  return (
    <>
      <Card
        size="small"
        title="AMR 제어"
        style={style}
        bodyStyle={{
          padding: token.padding,
          display: "flex",
          gap: token.paddingLG,
          alignItems: "stretch",
        }}
      >
        <AmrStatusSection
          robots={robots}
          robotsLoading={robotsQ.isLoading}
          amrId={amrId}
          setAmrId={(v) => {
            setAmrId(v);
            refetch();
          }}
          amrInfo={amrInfo}
          isFetching={isFetching}
          onDetail={() => setDetailOpen(true)}
        />

        <Divider type="vertical" style={{ height: "auto" }} />

        <AmrMotionPad
          robotId={amrId}
          disabled={!amrId}
          btnStyle={btnBase}
          elevate={elevate}
          depress={depress}
        />

        <Divider type="vertical" style={{ height: "auto" }} />

        <AmrLiftSection
          robotId={amrId} /* ← robotId 넘겨주기 */
          disabled={!amrId}
          btnStyle={btnBase}
          elevate={elevate}
          depress={depress}
        />
      </Card>

      <AmrDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        amrInfo={amrInfo}
        token={token}
      />
    </>
  );
}
