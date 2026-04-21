/**
 * Isometric rendering of the service dependency graph.
 *
 * Reuses the shared useForceLayout simulation so switching views
 * preserves positions and drag state. Each node is projected from its
 * (x, y) world position through a classic isometric transform and
 * drawn as a cylinder — identity-colored top disc, darker side, and a
 * darker base arc. Edges connect cylinder tops.
 *
 * Interaction mirrors the 2D graph: hover → tooltip, click → pin,
 * drag → move. Drag performs an inverse isometric projection on the
 * pointer position so dropping feels 1:1 with the cursor.
 *
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NodeTooltip from './NodeTooltip';
import EdgeTooltip from './EdgeTooltip';
import ZoomControls from './ZoomControls';
import type { InvestigationSeed } from '../api/agentContext';
import { serviceColor, serviceColorAtLightness } from '../utils/spans';
import { serviceHealth, healthFromRate } from '../utils/health';
import { useForceLayout, type SimNode, type SimLink } from '../hooks/useForceLayout';
import { usePanZoom } from '../hooks/usePanZoom';
import type {
  DependencyEdge,
  ServiceSummary,
  ServiceBucket,
  OperationSummary,
} from '../api/types';

interface Props {
  edges: DependencyEdge[];
  services: Map<string, ServiceSummary>;
  /** Previous-window summaries — enables the traffic-drop signal. */
  prevServices?: Map<string, ServiceSummary>;
  bucketsByService: Map<string, ServiceBucket[]>;
  width: number;
  height: number;
  loadOperations?: (service: string) => Promise<OperationSummary[]>;
  lookback: string;
}

const DRAG_THRESHOLD = 4;
// Isometric projection constants — standard 30° projection.
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);
// Cylinder geometry defaults.
const CYL_HEIGHT = 22;
const CYL_TOP_RY_RATIO = 0.4; // ry / rx for the top ellipse

interface IsoProjection {
  /** Scale applied to world positions before projecting. */
  scale: number;
  /** Offset applied to the projected coords to center them in view. */
  offsetX: number;
  offsetY: number;
}

/** Apply the isometric transform to a world (x,y) position. */
function projectPoint(
  x: number,
  y: number,
  p: IsoProjection,
): { px: number; py: number } {
  const sx = x * p.scale;
  const sy = y * p.scale;
  return {
    px: (sx - sy) * COS30 + p.offsetX,
    py: (sx + sy) * SIN30 + p.offsetY,
  };
}

/** Inverse of projectPoint — screen point → world (x,y). */
function unprojectPoint(
  px: number,
  py: number,
  p: IsoProjection,
): { x: number; y: number } {
  const dx = px - p.offsetX;
  const dy = py - p.offsetY;
  const sx = (dx / COS30 + dy / SIN30) / 2;
  const sy = (-dx / COS30 + dy / SIN30) / 2;
  return { x: sx / p.scale, y: sy / p.scale };
}

export default function IsometricGraph({
  edges,
  services,
  prevServices,
  bucketsByService,
  width,
  height,
  loadOperations,
  lookback,
}: Props) {
  const navigate = useNavigate();

  /**
   * Click handler for dependency edges → launches a Copilot
   * investigation pre-filled with the edge's context (parent → child,
   * call count, error rate, kind). Navigates to /investigate with a
   * seed passed via router state.
   */
  const investigateEdge = useCallback(
    (info: {
      parent: string;
      child: string;
      kind: 'rpc' | 'messaging';
      topic?: string;
      callCount: number;
      errorCount: number;
      p95DurUs: number;
    }) => {
      const errorRate = info.callCount > 0 ? info.errorCount / info.callCount : 0;
      const signals: string[] = [
        `Call count: ${info.callCount.toLocaleString()} in ${lookback}`,
        `Error count: ${info.errorCount.toLocaleString()}`,
        `Error rate: ${(errorRate * 100).toFixed(2)}%`,
        `p95 duration: ${info.p95DurUs >= 1000 ? (info.p95DurUs / 1000).toFixed(1) + 'ms' : info.p95DurUs.toFixed(0) + 'μs'}`,
        `Dependency kind: ${info.kind}`,
      ];
      if (info.topic) signals.push(`Messaging topic: ${info.topic}`);
      const question =
        info.errorCount > 0
          ? `The ${info.parent} → ${info.child} ${info.kind} call has ${info.errorCount} failing calls (${(errorRate * 100).toFixed(2)}% error rate). Investigate whether the failure originates in ${info.child} or is something about how ${info.parent} is calling it.`
          : `Investigate the ${info.parent} → ${info.child} ${info.kind} dependency. Look at latency patterns, error spikes, and which operations on each side dominate the traffic.`;
      const seed: InvestigationSeed = {
        question,
        service: info.child,
        knownSignals: signals,
        topology: [{ parent: info.parent, child: info.child, kind: info.kind }],
        earliest: lookback,
        latest: 'now',
      };
      navigate('/investigate', { state: { seed } });
    },
    [navigate, lookback],
  );

  const {
    transform,
    svgRef,
    onBackgroundPointerDown,
    onBackgroundPointerMove,
    onBackgroundPointerUp,
    screenToWorld,
    worldToScreen,
    zoomBy,
    reset: resetPanZoom,
    fitToBounds,
    consumeLastPan,
  } = usePanZoom(width, height);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  // Hovered edge for the EdgeTooltip card. Mirrors the 2D view —
  // tracks the link data plus the current cursor position so the
  // card can follow the mouse.
  interface HoveredEdge {
    key: string;
    parent: string;
    child: string;
    kind: 'rpc' | 'messaging';
    topic?: string;
    callCount: number;
    errorCount: number;
    p95DurUs: number;
    cursorX: number;
    cursorY: number;
  }
  const [hoveredEdge, setHoveredEdge] = useState<HoveredEdge | null>(null);

  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    hasMoved: boolean;
  } | null>(null);

  // Node + link data from edges/services (same construction as the 2D view).
  // Also seeds ghost nodes from prevServices for any service that was busy
  // in the prior window but is fully silent now — see DependencyGraph.tsx
  // for the rationale.
  const { nodes, links } = useMemo(() => {
    const nodeMap = new Map<string, SimNode>();
    const linkAgg = new Map<string, SimLink>();
    for (const svc of services.keys()) {
      if (!nodeMap.has(svc)) nodeMap.set(svc, { id: svc, size: 0 });
    }
    if (prevServices) {
      for (const [svc, prevSummary] of prevServices.entries()) {
        if (nodeMap.has(svc)) continue;
        if (prevSummary.requests < 50) continue;
        nodeMap.set(svc, { id: svc, size: 0 });
      }
    }
    for (const e of edges) {
      if (!nodeMap.has(e.parent)) nodeMap.set(e.parent, { id: e.parent, size: 0 });
      if (!nodeMap.has(e.child)) nodeMap.set(e.child, { id: e.child, size: 0 });
      nodeMap.get(e.parent)!.size += e.callCount;
      nodeMap.get(e.child)!.size += e.callCount;
      if (e.parent === e.child) continue;
      const kind = e.kind ?? 'rpc';
      // Keep rpc and messaging edges DISTINCT even for the same pair —
      // see DependencyGraph.tsx for the full rationale.
      const key = `${kind}\u0000${e.parent}\u0000${e.child}`;
      const existing = linkAgg.get(key);
      if (existing) {
        existing.value += e.callCount;
        existing.errorCount += e.errorCount;
        if (e.p95DurUs > existing.p95DurUs) existing.p95DurUs = e.p95DurUs;
      } else {
        linkAgg.set(key, {
          source: e.parent,
          target: e.child,
          value: e.callCount,
          errorCount: e.errorCount,
          p95DurUs: e.p95DurUs,
          kind,
          topic: e.topic,
        });
      }
    }
    return {
      nodes: Array.from(nodeMap.values()),
      links: Array.from(linkAgg.values()),
    };
  }, [edges, services, prevServices]);

  const nodeRadius = useCallback(
    (node: SimNode): number => {
      const summary = services.get(node.id);
      const prev = prevServices?.get(node.id);
      const volume = summary?.requests ?? prev?.requests ?? node.size;
      return Math.max(12, Math.min(36, 12 + Math.log10(volume + 1) * 6));
    },
    [services, prevServices],
  );

  // Shared simulation with the 2D graph view. `tick` bumps each frame
  // and is a dependency of the projection/layout memos so they
  // recompute as positions change.
  const { simNodesRef, simLinksRef, tick, pinNode, releaseNode } = useForceLayout({
    nodes,
    links,
    width,
    height,
    nodeRadius,
  });

  // Compute isometric projection to fit the simulation bounding box into
  // the available canvas with padding. Recomputed each render because
  // node positions change during drag / simulation ticks.
  const projection = useMemo<IsoProjection>(() => {
    const pad = 60;
    const sim = simNodesRef.current;
    if (sim.length === 0) {
      return { scale: 1, offsetX: width / 2, offsetY: height / 2 };
    }
    let xMin = Infinity,
      xMax = -Infinity,
      yMin = Infinity,
      yMax = -Infinity;
    for (const n of sim) {
      const nx = n.x ?? 0;
      const ny = n.y ?? 0;
      if (nx < xMin) xMin = nx;
      if (nx > xMax) xMax = nx;
      if (ny < yMin) yMin = ny;
      if (ny > yMax) yMax = ny;
    }
    // Project the bbox corners (unscaled, no offset) to find iso extent.
    const cornerP = (x: number, y: number) => ({
      px: (x - y) * COS30,
      py: (x + y) * SIN30,
    });
    const corners = [
      cornerP(xMin, yMin),
      cornerP(xMax, yMin),
      cornerP(xMin, yMax),
      cornerP(xMax, yMax),
    ];
    let pxMin = Infinity,
      pxMax = -Infinity,
      pyMin = Infinity,
      pyMax = -Infinity;
    for (const c of corners) {
      if (c.px < pxMin) pxMin = c.px;
      if (c.px > pxMax) pxMax = c.px;
      if (c.py < pyMin) pyMin = c.py;
      if (c.py > pyMax) pyMax = c.py;
    }
    const isoW = Math.max(1, pxMax - pxMin);
    const isoH = Math.max(1, pyMax - pyMin + CYL_HEIGHT);
    const availW = Math.max(1, width - 2 * pad);
    const availH = Math.max(1, height - 2 * pad);
    const scale = Math.min(availW / isoW, availH / isoH, 0.85);
    const offsetX = width / 2 - (pxMin + pxMax) * 0.5 * scale;
    const offsetY = height / 2 - (pyMin + pyMax) * 0.5 * scale;
    return { scale, offsetX, offsetY };
    // simNodesRef.current is mutated by d3 between renders; `tick` bumps
    // each sim step so the memo invalidates appropriately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, width, height]);

  const focusId = pinned ?? hovered;
  const focusNode = focusId
    ? simNodesRef.current.find((n) => n.id === focusId)
    : null;

  function pointerSvgCoords(e: React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onNodePointerDown(e: React.PointerEvent<SVGGElement>, nodeId: string) {
    e.stopPropagation();
    const target = e.currentTarget;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    const { x, y } = pointerSvgCoords(e);
    dragRef.current = { id: nodeId, startX: x, startY: y, hasMoved: false };
    // Screen → scene (undo pan/zoom) → sim world (undo iso projection).
    // Compensate for cylinder height so the pin tracks the top disc.
    const { x: scx, y: scy } = screenToWorld(x, y + CYL_HEIGHT);
    const { x: wx, y: wy } = unprojectPoint(scx, scy, projection);
    pinNode(nodeId, wx, wy);
  }

  function onNodePointerMove(e: React.PointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = pointerSvgCoords(e);
    if (
      !drag.hasMoved &&
      Math.hypot(x - drag.startX, y - drag.startY) > DRAG_THRESHOLD
    ) {
      drag.hasMoved = true;
    }
    if (drag.hasMoved) {
      const { x: scx, y: scy } = screenToWorld(x, y + CYL_HEIGHT);
      const { x: wx, y: wy } = unprojectPoint(scx, scy, projection);
      pinNode(drag.id, wx, wy);
    }
  }

  function onNodePointerUp(e: React.PointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const target = e.currentTarget;
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    const wasDrag = drag.hasMoved;
    dragRef.current = null;
    if (!wasDrag) {
      releaseNode(drag.id);
      setPinned((cur) => (cur === drag.id ? null : drag.id));
    }
  }

  // Project every node once per render so link rendering can reuse the
  // positions without repeating the math.
  const projectedNodes = useMemo(() => {
    const out = new Map<string, {
      id: string;
      node: SimNode;
      px: number;
      py: number;
      r: number;
    }>();
    for (const n of simNodesRef.current) {
      const { px, py } = projectPoint(n.x ?? 0, n.y ?? 0, projection);
      out.set(n.id, { id: n.id, node: n, px, py, r: nodeRadius(n) * projection.scale });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, projection, nodeRadius]);

  // Sort nodes back-to-front so closer cylinders paint over farther ones.
  // Larger py means lower on the screen (closer to viewer).
  const sortedNodes = useMemo(() => {
    const arr = Array.from(projectedNodes.values());
    arr.sort((a, b) => a.py - b.py);
    return arr;
  }, [projectedNodes]);

  function tooltipPosition(px: number, py: number): { left: number; top: number } {
    // (px, py) are scene-space (inside the pan/zoom group). Forward
    // project through the pan/zoom transform so the tooltip tracks the
    // cylinder as the user pans or zooms.
    const { x: sx, y: sy } = worldToScreen(px, py);
    const cylH = CYL_HEIGHT * transform.scale;
    const tooltipW = 300;
    const tooltipH = 400;
    let left = sx + 20;
    let top = sy - tooltipH / 2 - cylH;
    if (left + tooltipW > width) left = sx - 20 - tooltipW;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + tooltipH > height) top = height - tooltipH - 8;
    return { left, top };
  }

  return (
    <div
      style={{ position: 'relative', width, height }}
      onClick={() => {
        if (consumeLastPan()) return;
        setPinned(null);
      }}
    >
      <svg
        ref={svgRef}
        width={width}
        height={height}
        style={{
          display: 'block',
          cursor: 'grab',
          touchAction: 'none',
        }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onBackgroundPointerMove}
        onPointerUp={onBackgroundPointerUp}
        onPointerCancel={onBackgroundPointerUp}
      >
        <defs>
          {/* Soft floor grid gradient — gives the scene a base plane. */}
          <linearGradient id="isoFloor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f8f9fa" stopOpacity="0" />
            <stop offset="100%" stopColor="#e8eaed" stopOpacity="0.6" />
          </linearGradient>
          <marker
            id="isoArrow"
            viewBox="0 -5 10 10"
            refX="10"
            refY="0"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M0,-5L10,0L0,5" fill="#9ca3af" />
          </marker>
          <marker
            id="isoArrowActive"
            viewBox="0 -5 10 10"
            refX="10"
            refY="0"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M0,-5L10,0L0,5" fill="#0190ff" />
          </marker>
        </defs>

        {/* Everything inside this group is affected by pan+zoom. */}
        <g transform={`translate(${transform.tx},${transform.ty}) scale(${transform.scale})`}>
        {/* Floor plate — a large diamond suggesting the ground plane. */}
        <g opacity="0.5">
          {(() => {
            // Compute a large diamond around the current content.
            const centerX = width / 2;
            const centerY = height / 2 + CYL_HEIGHT / 2;
            const w = width * 0.9;
            const h = w * SIN30 * 0.9;
            return (
              <polygon
                points={`${centerX},${centerY - h / 2} ${centerX + w / 2},${centerY} ${centerX},${centerY + h / 2} ${centerX - w / 2},${centerY}`}
                fill="url(#isoFloor)"
                stroke="var(--cds-color-border-subtle)"
                strokeWidth={1}
              />
            );
          })()}
        </g>

        {/* Edges connect cylinder TOPS (cy - CYL_HEIGHT). Draw below the
            cylinders so they visually sit behind any node they reach. */}
        <g>
          {simLinksRef.current.map((l, i) => {
            const srcId = (l.source as SimNode).id;
            const tgtId = (l.target as SimNode).id;
            const src = projectedNodes.get(srcId);
            const tgt = projectedNodes.get(tgtId);
            if (!src || !tgt) return null;
            const sx = src.px;
            const sy = src.py - CYL_HEIGHT;
            const tx = tgt.px;
            const ty = tgt.py - CYL_HEIGHT;
            const dx = tx - sx;
            const dy = ty - sy;
            const dist = Math.max(1, Math.hypot(dx, dy));
            const tEndX = tx - (dx / dist) * tgt.r;
            const tEndY = ty - (dy / dist) * tgt.r * CYL_TOP_RY_RATIO;
            const isHighlighted = focusId === srcId || focusId === tgtId;
            const edgeHealth = healthFromRate(
              l.value > 0 ? l.errorCount / l.value : 0,
              l.value,
            );
            const hasErrors =
              edgeHealth.bucket !== 'healthy' && edgeHealth.bucket !== 'idle';
            const baseStroke = hasErrors ? edgeHealth.color : '#9ca3af';
            const stroke = isHighlighted ? '#0190ff' : baseStroke;
            const isMessaging = l.kind === 'messaging';
            const dashArray = isMessaging ? '6 4' : undefined;
            const edgeKey = `${l.kind ?? 'rpc'}\u0000${srcId}\u0000${tgtId}`;
            const computedWidth = Math.max(
              1,
              Math.log10(l.value + 1) + (hasErrors ? 1 : 0),
            );
            return (
              <g key={i}>
                <line
                  x1={sx}
                  y1={sy}
                  x2={tEndX}
                  y2={tEndY}
                  stroke="transparent"
                  strokeWidth={Math.max(computedWidth + 8, 10)}
                  onMouseEnter={(e) => {
                    const rect = svgRef.current?.getBoundingClientRect();
                    setHoveredEdge({
                      key: edgeKey,
                      parent: srcId,
                      child: tgtId,
                      kind: (l.kind ?? 'rpc') as 'rpc' | 'messaging',
                      topic: l.topic,
                      callCount: l.value,
                      errorCount: l.errorCount,
                      p95DurUs: l.p95DurUs,
                      cursorX: rect ? e.clientX - rect.left : 0,
                      cursorY: rect ? e.clientY - rect.top : 0,
                    });
                  }}
                  onMouseMove={(e) => {
                    const rect = svgRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setHoveredEdge((prev) =>
                      prev && prev.key === edgeKey
                        ? {
                            ...prev,
                            cursorX: e.clientX - rect.left,
                            cursorY: e.clientY - rect.top,
                          }
                        : prev,
                    );
                  }}
                  onMouseLeave={() => {
                    setHoveredEdge((prev) =>
                      prev && prev.key === edgeKey ? null : prev,
                    );
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    investigateEdge({
                      parent: srcId,
                      child: tgtId,
                      kind: (l.kind ?? 'rpc') as 'rpc' | 'messaging',
                      topic: l.topic,
                      callCount: l.value,
                      errorCount: l.errorCount,
                      p95DurUs: l.p95DurUs,
                    });
                  }}
                  style={{ cursor: 'pointer' }}
                />
                <line
                  x1={sx}
                  y1={sy}
                  x2={tEndX}
                  y2={tEndY}
                  stroke={stroke}
                  strokeOpacity={
                    isHighlighted ? 0.95 : focusId ? 0.15 : hasErrors ? 0.85 : 0.55
                  }
                  strokeWidth={computedWidth}
                  strokeDasharray={dashArray}
                  markerEnd={
                    isHighlighted ? 'url(#isoArrowActive)' : 'url(#isoArrow)'
                  }
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            );
          })}
        </g>

        {/* Cylinders painted back-to-front so overlapping ones stack
            correctly without needing z-index. */}
        <g>
          {sortedNodes.map((p) => {
            const n = p.node;
            const summary = services.get(n.id);
            const prevSummary = prevServices?.get(n.id);
            const health = serviceHealth(summary, prevSummary);
            const isFocused = focusId === n.id;
            const isPinned = pinned === n.id;
            const idColor = serviceColor(n.id);
            const sideColor = serviceColorAtLightness(n.id, 32);
            const rimColor = serviceColorAtLightness(n.id, 22);

            const rx = p.r;
            const ry = rx * CYL_TOP_RY_RATIO;
            const cx = p.px;
            const cy = p.py;
            const topCy = cy - CYL_HEIGHT;

            // Halo around the top of the cylinder for non-healthy buckets.
            const haloGap = 3;
            const haloRx = rx + haloGap;
            const haloRy = ry + haloGap * CYL_TOP_RY_RATIO * 2.5;
            const haloWidth =
              health.bucket === 'critical' ? 3.5
              : health.bucket === 'silent' ? 3.5
              : health.bucket === 'traffic_drop' ? 3
              : health.bucket === 'warn' ? 3
              : health.bucket === 'watch' ? 2
              : health.bucket === 'idle' ? 1
              : 0;
            const haloDash =
              health.bucket === 'idle' || health.bucket === 'silent'
                ? '3 3'
                : undefined;
            const isGhost = health.bucket === 'silent';

            const dimOpacity = isGhost
              ? 0.4
              : focusId && !isFocused
                ? 0.35
                : 1;

            return (
              <g
                key={n.id}
                style={{ cursor: 'grab', touchAction: 'none' }}
                onMouseEnter={() => setHovered(n.id)}
                onMouseLeave={() => setHovered(null)}
                onPointerDown={(e) => onNodePointerDown(e, n.id)}
                onPointerMove={onNodePointerMove}
                onPointerUp={onNodePointerUp}
                onClick={(e) => e.stopPropagation()}
                opacity={dimOpacity}
              >
                {/* Ground shadow — flat ellipse on the floor plane */}
                <ellipse
                  cx={cx}
                  cy={cy + ry * 0.4}
                  rx={rx * 0.9}
                  ry={ry * 0.9}
                  fill="rgba(0,0,0,0.18)"
                />

                {/* Side rectangle of the cylinder (between top + bottom
                    ellipses). */}
                <path
                  d={`M ${cx - rx} ${topCy} L ${cx - rx} ${cy} A ${rx} ${ry} 0 0 0 ${cx + rx} ${cy} L ${cx + rx} ${topCy}`}
                  fill={sideColor}
                  stroke={rimColor}
                  strokeWidth={1}
                />

                {/* Top ellipse — identity color, primary visual */}
                <ellipse
                  cx={cx}
                  cy={topCy}
                  rx={rx}
                  ry={ry}
                  fill={idColor}
                  stroke={isPinned ? '#1a1a2e' : rimColor}
                  strokeWidth={isPinned ? 2 : 1}
                />

                {/* Health halo on top of the cylinder top */}
                {haloWidth > 0 && (
                  <ellipse
                    cx={cx}
                    cy={topCy}
                    rx={haloRx}
                    ry={haloRy}
                    fill="none"
                    stroke={health.color}
                    strokeWidth={haloWidth}
                    strokeDasharray={haloDash}
                    opacity={0.85}
                  >
                    {health.bucket === 'critical' && (
                      <>
                        <animate
                          attributeName="rx"
                          values={`${haloRx};${haloRx + 3};${haloRx}`}
                          dur="1.8s"
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          values="0.85;0.35;0.85"
                          dur="1.8s"
                          repeatCount="indefinite"
                        />
                      </>
                    )}
                  </ellipse>
                )}

                <text
                  x={cx}
                  y={cy + ry + 14}
                  textAnchor="middle"
                  fontSize="11"
                  fontFamily='"Open Sans", sans-serif'
                  fill="#1a1a2e"
                  fontWeight={isFocused || health.bucket === 'critical' || isGhost ? 600 : 500}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {n.id}
                </text>
                {isGhost && (
                  <text
                    x={cx}
                    y={cy + ry + 26}
                    textAnchor="middle"
                    fontSize="10"
                    fontFamily='"Open Sans", sans-serif'
                    fill="#dc2626"
                    fontWeight={600}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    no traffic
                  </text>
                )}
              </g>
            );
          })}
        </g>
        </g>
      </svg>

      <ZoomControls
        scale={transform.scale}
        onZoomIn={() => zoomBy(1.25)}
        onZoomOut={() => zoomBy(1 / 1.25)}
        onReset={resetPanZoom}
      />

      {focusNode &&
        (() => {
          const p = projectedNodes.get(focusNode.id);
          if (!p) return null;
          const { left, top } = tooltipPosition(p.px, p.py);
          return (
            <NodeTooltip
              service={focusNode.id}
              summary={services.get(focusNode.id)}
              prevSummary={prevServices?.get(focusNode.id)}
              buckets={bucketsByService.get(focusNode.id) ?? []}
              pinned={pinned === focusNode.id}
              left={left}
              top={top}
              onClose={() => setPinned(null)}
              loadOperations={loadOperations}
              lookback={lookback}
            />
          );
        })()}

      {/* Edge tooltip follows the cursor while an edge is hovered.
       * Suppressed when a node tooltip is already active. */}
      {hoveredEdge && !focusNode && (
        <EdgeTooltip
          parent={hoveredEdge.parent}
          child={hoveredEdge.child}
          kind={hoveredEdge.kind}
          topic={hoveredEdge.topic}
          callCount={hoveredEdge.callCount}
          errorCount={hoveredEdge.errorCount}
          p95DurUs={hoveredEdge.p95DurUs}
          left={hoveredEdge.cursorX}
          top={hoveredEdge.cursorY}
          containerWidth={width}
          containerHeight={height}
        />
      )}
    </div>
  );
}
