// src/pages/Home/Canvas.jsx
import React, { useEffect, useRef, useCallback, useState } from "react";
import {
  Card,
  Button,
  Spin,
  Alert,
  Modal,
  Radio,
  Tag,
  message,
  theme,
} from "antd";
import { SettingOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { useAtomValue, useAtom } from "jotai";
import { mapsQueryAtom, robotsQueryAtom, selectedMapAtom } from "@/state/atoms";
import arrowIcon from "@/assets/arrow.png";
import SignalOverlay from "@/components/SignalOverlay";

// 안전한 JSON 파싱
function safeParse(raw, fallback = {}) {
  if (raw == null) return fallback;
  let v = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return fallback;
  }
  return v ?? fallback;
}

const CORE = import.meta.env.VITE_CORE_BASE_URL;
const ICON_MM = { width: 800, height: 1200 };

export default function Canvas() {
  // jotai
  const mapsQ = useAtomValue(mapsQueryAtom);
  const robotsQ = useAtomValue(robotsQueryAtom);
  const [selMap, setSelMap] = useAtom(selectedMapAtom);

  const maps = mapsQ.data ?? [];
  const robots = robotsQ.data ?? [];

  const { token } = theme.useToken();

  // station tooltip state
  const [hoveredStationClasses, setHoveredStationClasses] = useState(null);
  const [stationTooltipPos, setStationTooltipPos] = useState({ x: 0, y: 0 });

  // 지도 변경 API
  const saveCurrent = useMutation({
    mutationFn: (id) =>
      fetch(`${CORE}/api/maps/current`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapId: id }),
      }),
  });

  // 모달 상태
  const [modalOpen, setModalOpen] = useState(false);
  const [tempId, setTempId] = useState(selMap?.id);

  // 캔버스 refs
  const contRef = useRef(null);
  const canvRef = useRef(null);

  // 뷰 상태
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [sf, setSf] = useState(1);

  // station 원 반지름
  const rPix = ((ICON_MM.width / 1000) * sf * scale) / 6;

  // 로봇 아이콘 로드
  const [robotImg, setRobotImg] = useState(null);
  useEffect(() => {
    const img = new Image();
    img.src = arrowIcon;
    img.onload = () => setRobotImg(img);
    img.onerror = () => console.error("🚨 arrow.png 로드 실패:", arrowIcon);
  }, []);

  // DPI 대응
  const fitCanvas = useCallback(() => {
    if (!contRef.current || !canvRef.current) return;
    const rect = contRef.current.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const c = canvRef.current;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = `${rect.width}px`;
    c.style.height = `${rect.height}px`;
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);
  useEffect(() => {
    fitCanvas();
    window.addEventListener("resize", fitCanvas);
    return () => window.removeEventListener("resize", fitCanvas);
  }, [fitCanvas]);

  // 지도 변경 시 뷰 초기화
  useEffect(() => {
    if (!contRef.current || !selMap) return;
    const hdr = safeParse(selMap.additional_info).header || {};
    const { minPos, maxPos, resolution } = hdr;
    if (!minPos || !maxPos) return;
    const midX = (minPos.x + maxPos.x) / 2;
    const midY = (minPos.y + maxPos.y) / 2;
    const rect = contRef.current.getBoundingClientRect();
    const nSf = resolution ? 1 / resolution : 1;
    setSf(nSf);
    setScale(1);
    setOffset({
      x: rect.width / 2 - midX * nSf,
      y: rect.height / 2 - midY * nSf,
    });
  }, [selMap]);

  // 좌표 변환
  const transform = (x, y) => {
    const h = contRef.current?.getBoundingClientRect().height || 0;
    return {
      x: x * sf * scale + offset.x,
      y: h - (y * sf * scale + offset.y),
    };
  };

  // 그리기
  const draw = () => {
    const c = canvRef.current;
    if (!c || !selMap) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    // normalPointList 그리기 (새로운 포인트 리스트)
    const normalPoints =
      safeParse(selMap.additional_info).normalPointList ?? [];
    ctx.fillStyle = token.colorInfo;
    normalPoints.forEach((pt) => {
      const { x, y } = transform(pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    });

    // 기존 normals(legacy) 그리기
    const normals = safeParse(selMap.additional_info).normalPosList ?? [];
    ctx.fillStyle = "#000";
    normals.forEach((pt) => {
      const q = transform(pt.x, pt.y);
      ctx.fillRect(q.x, q.y, 1, 1);
    });

    // 경로 그리기
    ctx.strokeStyle = "#f00";
    const paths = safeParse(selMap.paths).paths ?? [];
    const stations = safeParse(selMap.stations).stations ?? [];
    paths.forEach((p) => {
      let s = p.coordinates?.start;
      let e = p.coordinates?.end;
      if (!s || !e) {
        s = stations.find((st) => String(st.id) === String(p.start));
        e = stations.find((st) => String(st.id) === String(p.end));
      }
      if (!s || !e) return;
      const sp = transform(s.x, s.y);
      const ep = transform(e.x, e.y);
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(ep.x, ep.y);
      ctx.stroke();
    });

    // Stations 그리기 (로봇 위에)
    ctx.fillStyle = "#ffa500";
    ctx.font = `${12 * scale}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    stations.forEach((st) => {
      const p = transform(st.x, st.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rPix, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#333";
      ctx.fillText(st.name || st.id, p.x, p.y + rPix + 2);
      ctx.fillStyle = "#ffa500";
    });

    // Robots 그리기
    if (robotImg) {
      robots.forEach((r) => {
        const pos = safeParse(r.position, {
          x: 0,
          y: 0,
          angle: 0,
        });
        const p = transform(pos.x, pos.y);
        const sizePx = (ICON_MM.width / 1000) * sf * scale;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(-pos.angle + Math.PI / 2);
        ctx.drawImage(robotImg, -sizePx / 2, -sizePx / 2, sizePx, sizePx);
        ctx.restore();
      });
    }
  };
  useEffect(draw, [
    selMap,
    scale,
    offset,
    sf,
    robots,
    robotImg,
    token.colorInfo,
  ]);

  // 패닝 & 줌
  const [drag, setDrag] = useState(false);
  const [last, setLast] = useState({ x: 0, y: 0 });

  const getPos = (e) => {
    const r = canvRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e) => {
    if (e.button !== 0) return;
    setDrag(true);
    setLast(getPos(e));
  };
  const onMove = (e) => {
    if (drag) {
      const p = getPos(e);
      setOffset((o) => ({
        x: o.x + p.x - last.x,
        y: o.y - p.y + last.y,
      }));
      setLast(p);
    }
    handleHover(e);
    handleStationHover(e);
  };
  const onUp = () => setDrag(false);

  const onWheel = (e) => {
    e.preventDefault();
    const p = getPos(e);
    const fac = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const ns = Math.max(0.1, Math.min(scale * fac, 80));
    const ratio = ns / scale;
    const rect = contRef.current.getBoundingClientRect();
    setScale(ns);
    setOffset((o) => ({
      x: o.x * ratio + p.x * (1 - ratio),
      y: o.y * ratio + (rect.height - p.y) * (1 - ratio),
    }));
  };

  // 로봇 툴팁 상태
  const [hoveredRobotName, setHoveredRobotName] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const handleHover = (e) => {
    const pos = getPos(e);
    let found = null;
    robots.forEach((r) => {
      const rp = safeParse(r.position, {
        x: 0,
        y: 0,
        angle: 0,
      });
      const pScr = transform(rp.x, rp.y);
      const dx = pScr.x - pos.x;
      const dy = pScr.y - pos.y;
      if (dx * dx + dy * dy <= (rPix + 5) ** 2) {
        found = r;
      }
    });
    if (found) {
      setHoveredRobotName(found.name);
      setTooltipPos({ x: e.clientX, y: e.clientY });
    } else {
      setHoveredRobotName(null);
    }
  };

  const handleStationHover = (e) => {
    const pos = getPos(e);
    // re-parse the stations here
    const stations = safeParse(selMap?.stations).stations ?? [];
    let found = null;
    stations.forEach((st) => {
      const p = transform(st.x, st.y);
      const dx = p.x - pos.x,
        dy = p.y - pos.y;
      if (dx * dx + dy * dy <= rPix * rPix) {
        found = st;
        console.log(st);
      }
    });
    if (found) {
      const classes = Array.isArray(found.class)
        ? found.class
        : Array.isArray(found.classList)
        ? found.classList
        : found.class
        ? [found.class]
        : [];
      setHoveredStationClasses(classes);
      console.log(classes);
      setStationTooltipPos({ x: e.clientX, y: e.clientY });
    } else {
      setHoveredStationClasses(null);
    }
  };

  // 우클릭 메뉴 상태
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [menuStation, setMenuStation] = useState(null);

  const onCanvasContextMenu = (e) => {
    e.preventDefault();
    if (!selMap) return;
    const stations = safeParse(selMap.stations).stations ?? [];
    const click = getPos(e);
    const clicked = stations.find((st) => {
      const p = transform(st.x, st.y);
      const dx = p.x - click.x,
        dy = p.y - click.y;
      return dx * dx + dy * dy <= rPix * rPix;
    });
    if (clicked) {
      setMenuStation(clicked);
      setMenuPos({ x: e.clientX, y: e.clientY });
      setMenuVisible(true);
    }
  };

  const dispatchRobot = async (robotId) => {
    if (!menuStation) return;
    try {
      await fetch(`${CORE}/api/robots/${robotId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          station: menuStation.name ?? menuStation.id,
        }),
      });
      message.success(`로봇 ${robotId} → ${menuStation.name} 이동 명령 보냄`);
    } catch {
      message.error("이동 명령 실패");
    } finally {
      setMenuVisible(false);
    }
  };

  return (
    <>
      <Card
        size="small"
        title={`${selMap?.name ?? "―"}`}
        extra={
          <Button
            size="small"
            icon={<SettingOutlined />}
            onClick={() => {
              setTempId(selMap?.id);
              setModalOpen(true);
            }}
          />
        }
        style={{ height: "calc(100%)" }}
        bodyStyle={{ height: "calc(100%)" }}
      >
        <div
          ref={contRef}
          style={{
            position: "relative",
            width: "100%",
            height: "calc(100% - 40px)",
            backgroundColor: token.colorBgContainer,
            boxShadow: "inset 0 2px 8px rgba(0,0,0,0.1)",
            borderRadius: token.borderRadius,
            overflow: "hidden",
            padding: token.padding,
            boxSizing: "border-box",
          }}
        >
          <SignalOverlay />

          <canvas
            ref={canvRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              height: "100%",
              cursor: drag ? "grabbing" : "grab",
            }}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            onWheel={onWheel}
            onContextMenu={onCanvasContextMenu}
          />

          {menuVisible && menuStation && (
            <div
              style={{
                position: "fixed",
                top: menuPos.y,
                left: menuPos.x,
                background: "#fff",
                border: "1px solid rgba(0,0,0,0.15)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                zIndex: 1000,
              }}
              onMouseLeave={() => setMenuVisible(false)}
            >
              {robots.map((r) => (
                <div
                  key={r.id}
                  style={{ padding: "4px 12px", cursor: "pointer" }}
                  onClick={() => dispatchRobot(r.id)}
                >
                  {r.name}
                </div>
              ))}
            </div>
          )}

          {hoveredRobotName && (
            <div
              style={{
                position: "fixed",
                top: tooltipPos.y + 10,
                left: tooltipPos.x + 10,
                background: "rgba(0,0,0,0.75)",
                color: "#fff",
                padding: "4px 8px",
                borderRadius: 4,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                fontSize: 12,
              }}
            >
              {hoveredRobotName}
            </div>
          )}
          {hoveredStationClasses && (
            <div
              style={{
                position: "fixed",
                top: stationTooltipPos.y + 10,
                left: stationTooltipPos.x + 10,
                background: "rgba(0,0,0,0.75)",
                color: "#fff",
                padding: "4px 8px",
                borderRadius: 4,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                fontSize: 12,
              }}
            >
              {hoveredStationClasses.join(", ")}
            </div>
          )}
        </div>
      </Card>

      {/* 맵 선택 모달 */}
      <Modal
        title="맵 선택"
        open={modalOpen}
        okText="선택"
        cancelText="취소"
        onOk={() => {
          const m = maps.find((x) => x.id === tempId);
          if (m) {
            setSelMap(m);
            saveCurrent.mutate(m.id);
          }
          setModalOpen(false);
        }}
        onCancel={() => setModalOpen(false)}
      >
        {mapsQ.isLoading && maps.length === 0 ? (
          <Spin />
        ) : mapsQ.error ? (
          <Alert type="error" message="맵 로드 실패" />
        ) : (
          <Radio.Group
            value={tempId}
            onChange={(e) => setTempId(e.target.value)}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            {maps.map((m) => (
              <Radio key={m.id} value={m.id}>
                {m.name}{" "}
                {m.is_current && (
                  <Tag color="blue" style={{ marginLeft: 4 }}>
                    현재
                  </Tag>
                )}
              </Radio>
            ))}
          </Radio.Group>
        )}
      </Modal>
    </>
  );
}
