// src/pages/MapSettings/MapViewerModal.jsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Modal } from "antd";

export default function MapViewerModal({ visible, onClose, mapData }) {
  console.log(mapData);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [scaleFactor, setScaleFactor] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [lastMouse, setLastMouse] = useState({ x: 0, y: 0 });

  /* ── safeParse: 두 겹 JSON 도 처리 ───────────────── */
  const safeParse = (str, fallback = {}) => {
    try {
      let v = typeof str === "string" ? JSON.parse(str) : str;
      if (typeof v === "string") v = JSON.parse(v);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  };

  /* ── 캔버스 DPI 대응 ─────────────────────────────── */
  const updateCanvasSize = useCallback(() => {
    if (!containerRef.current || !canvasRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const c = canvasRef.current;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = `${rect.width}px`;
    c.style.height = `${rect.height}px`;
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  /* ── 초기 뷰포트 계산 ─────────────────────────────── */
  const initViewport = useCallback(() => {
    if (!containerRef.current || !mapData) return;

    const stationsObj = safeParse(mapData.stations);
    const normalPosList =
      safeParse(mapData.additional_info).normalPosList ?? [];
    const pts = [
      ...(stationsObj.stations ?? []).map(({ x, y }) => ({ x, y })),
      ...normalPosList,
    ];
    if (!pts.length) return;

    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const w = Math.max(maxX - minX, 0.01);
    const h = Math.max(maxY - minY, 0.01);

    const rect = containerRef.current.getBoundingClientRect();
    const sf = Math.max(0.1, Math.min(rect.width / w, rect.height / h) * 0.9); // clamp

    setScaleFactor(sf);
    setScale(1);
    setOffset({
      x: rect.width / 2 - (minX + w / 2) * sf,
      y: rect.height / 2 - (minY + h / 2) * sf,
    });
  }, [mapData]);

  /* ── 모달 오픈 때 ──────────────────────────────── */
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      updateCanvasSize();
      initViewport();
      window.addEventListener("resize", updateCanvasSize);
    });
    return () => window.removeEventListener("resize", updateCanvasSize);
  }, [visible, updateCanvasSize, initViewport]);

  /* ── 좌표 변환 ─────────────────────────────────── */
  const transform = (x, y) => {
    const h = containerRef.current?.getBoundingClientRect().height || 0;
    return {
      x: x * scaleFactor * scale + offset.x,
      y: h - (y * scaleFactor * scale + offset.y),
    };
  };

  /* ── 드래그/휠 핸들러 ─────────────────────────── */
  const getMouse = (e) => {
    const r = canvasRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onMouseDown = (e) => {
    if (e.button === 0) {
      setIsDragging(true);
      setLastMouse(getMouse(e));
    }
  };
  const onMouseMove = (e) => {
    if (!isDragging) return;
    const pos = getMouse(e);
    setOffset((o) => ({
      x: o.x + (pos.x - lastMouse.x),
      y: o.y + (pos.y - lastMouse.y),
    }));
    setLastMouse(pos);
  };
  const endDrag = () => setIsDragging(false);
  const onWheel = (e) => {
    e.preventDefault();
    const pos = getMouse(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const ns = Math.max(0.1, Math.min(scale * factor, 80));
    const ratio = ns / scale;
    setScale(ns);
    setOffset((o) => ({
      x: o.x * ratio + pos.x * (1 - ratio),
      y: o.y * ratio + pos.y * (1 - ratio),
    }));
  };

  /* ── 그리기 루프 ──────────────────────────────── */
  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

    const stationArr = safeParse(mapData.stations).stations ?? [];
    const pathArr = safeParse(mapData.paths).paths ?? [];
    const nList = safeParse(mapData.additional_info).normalPosList ?? [];

    // normalPosList
    ctx.fillStyle = "#000";
    nList.forEach((p) => {
      const q = transform(p.x, p.y);
      ctx.fillRect(q.x, q.y, 1, 1);
    });

    // paths
    ctx.strokeStyle = "#f00";
    ctx.lineWidth = 1;
    pathArr.forEach((p) => {
      let s, e;
      if (p.coordinates) {
        s = p.coordinates.start;
        e = p.coordinates.end;
      } else {
        s = stationArr.find((st) => String(st.id) === String(p.start));
        e = stationArr.find((st) => String(st.id) === String(p.end));
      }
      if (!(s && e)) return;
      const sp = transform(s.x, s.y),
        ep = transform(e.x, e.y);
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(ep.x, ep.y);
      ctx.stroke();
    });

    // stations
    ctx.fillStyle = "#ffa500";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    stationArr.forEach((st) => {
      const p = transform(st.x, st.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.fillText(String(st.id ?? st.name), p.x, p.y - 8);
      ctx.fillStyle = "#ffa500";
    });

    console.log("draw", {
      station: stationArr.length,
      path: pathArr.length,
      normal: nList.length,
    });
  }, [visible, mapData, scale, offset, scaleFactor]);

  /* ── UI ─────────────────────────────────────── */
  return (
    <Modal
      open={visible}
      onCancel={onClose}
      width="80%"
      footer={null}
      destroyOnClose
      bodyStyle={{ padding: 0, overflow: "hidden" }}
      style={{ top: 20 }}
    >
      <div
        ref={containerRef}
        style={{ width: "100%", height: "60vh", position: "relative" }}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
            cursor: isDragging ? "grabbing" : "grab",
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onWheel={onWheel}
        />
      </div>
    </Modal>
  );
}
