/**
 * Force-directed dependency graph rendered as SVG.
 *
 * Uses the shared useForceLayout hook so the IsometricGraph sibling can
 * read the same simulation state and node positions. Each component
 * owns its own rendering + pointer interaction; the hook owns the
 * physics.
 *
 * Interaction:
 *  - Hover a node → show tooltip
 *  - Click a node (no drag) → pin tooltip; click again / click background
 *    to unpin
 *  - Drag a node → repositions it via fx/fy and the position stays after
 *    release (the user explicitly moved it, so physics won't pull it back).
 *    A drag threshold distinguishes click from drag so the tooltip-pin
 *    behavior doesn't fire on drags.
 *
 * Node visual encoding:
 *  - Fill = serviceColor(id) — the deterministic hash hue used everywhere
 *    else in the app for consistent service identification.
 *  - Size = log of request count (traffic volume).
 *  - Health = offset halo ring drawn only for non-healthy buckets; the
 *    common healthy case stays visually calm.
 *
 * We deliberately read d3's mutable node/link arrays out of refs during
 * render — that's how d3-force and React cooperate without copying arrays
 * every tick. The eslint rule flags it but the pattern is intentional.
 */
/* eslint-disable react-hooks/refs */
import { useMemo, useRef, useState } from 'react';
import NodeTooltip from './NodeTooltip';
import EdgeTooltip from './EdgeTooltip';
import ZoomControls from './ZoomControls';
import { serviceColor } from '../utils/spans';
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
  /** Previous-window summaries, keyed by service name. Enables the
   * traffic-drop health signal — services whose request rate has
   * fallen sharply vs baseline are promoted to the `traffic_drop`
   * bucket in the halo + tooltip. */
  prevServices?: Map<string, ServiceSummary>;
  bucketsByService: Map<string, ServiceBucket[]>;
  width: number;
  height: number;
  loadOperations?: (service: string) => Promise<OperationSummary[]>;
  lookback: string;
}

const DRAG_THRESHOLD = 4;

export default function DependencyGraph({
  edges,
  services,
  prevServices,
  bucketsByService,
  width,
  height,
  loadOperations,
  lookback,
}: Props) {
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
  // Hovered edge for the EdgeTooltip card. Tracks the full link data
  // so the card has everything it needs without looking it up again,
  // plus the current cursor position so the card can follow the
  // mouse like a traditional tooltip.
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

  // Drag state — the active pointer session, cleared on release.
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    hasMoved: boolean;
  } | null>(null);

  // Build nodes & links. Seed from the services map so isolated services
  // still appear. Also seed ghost nodes from the prior window for any
  // service that was busy then but is fully silent now — those are the
  // most actionable failures (a service that crashed or got isolated)
  // and would otherwise vanish from the graph entirely. Skip self-loops
  // on edges.
  const { nodes, links } = useMemo(() => {
    const nodeMap = new Map<string, SimNode>();
    const linkAgg = new Map<string, SimLink>();
    for (const svc of services.keys()) {
      if (!nodeMap.has(svc)) nodeMap.set(svc, { id: svc, size: 0 });
    }
    if (prevServices) {
      for (const [svc, prevSummary] of prevServices.entries()) {
        if (nodeMap.has(svc)) continue;
        // Gate ghost nodes on the same minimum baseline as the
        // serviceHealth `silent` bucket so a single noise span in the
        // prior window doesn't conjure a permanent ghost.
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
      // Keep rpc and messaging edges as DISTINCT links even for the
      // same (parent, child) pair. They mean different things (sync
      // call vs async queue hop) and users should see both. Use kind
      // as part of the aggregation key.
      const key = `${kind}\u0000${e.parent}\u0000${e.child}`;
      const existing = linkAgg.get(key);
      if (existing) {
        existing.value += e.callCount;
        existing.errorCount += e.errorCount;
        // Keep the higher p95 across aggregated rows — it's a pessimistic
        // but honest summary; the real fix would be to re-percentile, but
        // that requires raw samples we don't carry here.
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

  // Node size function shared with the simulation (so collision padding
  // uses the same radii as rendering). Ghost nodes (no current
  // summary, only a prior-window one) get sized off their last-known
  // volume so they don't collapse to the minimum radius and look
  // like "always idle" services.
  function nodeRadius(node: SimNode): number {
    const summary = services.get(node.id);
    const prev = prevServices?.get(node.id);
    const volume = summary?.requests ?? prev?.requests ?? node.size;
    return Math.max(10, Math.min(34, 10 + Math.log10(volume + 1) * 6));
  }

  const { simNodesRef, simLinksRef, tick, pinNode, releaseNode } = useForceLayout({
    nodes,
    links,
    width,
    height,
    nodeRadius,
  });

  const didFitRef = useRef(false);
  useEffect(() => {
    didFitRef.current = false;
  }, [edges]);
  useEffect(() => {
    if (didFitRef.current || tick < 30) return;
    didFitRef.current = true;
    const sn = simNodesRef.current;
    if (sn.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of sn) {
      const r = nodeRadius(n);
      if (n.x != null) { minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r); }
      if (n.y != null) { minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r); }
    }
    if (isFinite(minX)) fitToBounds({ minX, minY, maxX, maxY });
  }, [tick, edges, fitToBounds, simNodesRef]);

  const focusId = pinned ?? hovered;
  const focusNode = focusId
    ? simNodesRef.current.find((n) => n.id === focusId)
    : null;

  // Position the tooltip next to the focused node, keeping it inside the
  // canvas area. World coords get forward-projected through the pan/zoom
  // transform so the tooltip tracks the node as the user zooms or pans.
  function tooltipPosition(node: SimNode): { left: number; top: number } {
    const r = nodeRadius(node) * transform.scale;
    const nx = node.x ?? 0;
    const ny = node.y ?? 0;
    const { x: sx, y: sy } = worldToScreen(nx, ny);
    const tooltipW = 300;
    const tooltipH = 400;
    let left = sx + r + 12;
    let top = sy - tooltipH / 2;
    if (left + tooltipW > width) left = sx - r - 12 - tooltipW;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + tooltipH > height) top = height - tooltipH - 8;
    return { left, top };
  }

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
    // Pin immediately in *world* space so the node doesn't jitter under
    // the pointer regardless of the current pan/zoom.
    const { x: wx, y: wy } = screenToWorld(x, y);
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
      const { x: wx, y: wy } = screenToWorld(x, y);
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
      // Short click → release the temporary pin (physics takes over
      // again) and toggle the tooltip pin for this node.
      releaseNode(drag.id);
      setPinned((cur) => (cur === drag.id ? null : drag.id));
    }
    // If it WAS a drag, leave fx/fy set so the node stays where the user
    // dropped it. The simulation will route other nodes around it.
  }

  return (
    <div
      style={{ position: 'relative', width, height }}
      onClick={() => {
        // Suppress unpin if the user just finished a pan drag; a real
        // click on the background should still unpin the tooltip.
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
          <marker
            id="arrowhead"
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
            id="arrowheadActive"
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
        <g>
          {simLinksRef.current.map((l, i) => {
            const sx = (l.source as SimNode).x ?? 0;
            const sy = (l.source as SimNode).y ?? 0;
            const tx = (l.target as SimNode).x ?? 0;
            const ty = (l.target as SimNode).y ?? 0;
            const sourceId = (l.source as SimNode).id;
            const targetId = (l.target as SimNode).id;
            const dx = tx - sx;
            const dy = ty - sy;
            const dist = Math.max(1, Math.hypot(dx, dy));
            const tradius = nodeRadius(l.target as SimNode);
            const tEndX = tx - (dx / dist) * tradius;
            const tEndY = ty - (dy / dist) * tradius;
            const isHighlighted =
              focusId === sourceId || focusId === targetId;
            const edgeHealth = healthFromRate(
              l.value > 0 ? l.errorCount / l.value : 0,
              l.value,
            );
            // Use health color when the edge has errors, fall back to neutral gray
            // so healthy + highlighted cases still look like the old behavior.
            const hasErrors = edgeHealth.bucket !== 'healthy' && edgeHealth.bucket !== 'idle';
            const baseStroke = hasErrors ? edgeHealth.color : '#9ca3af';
            const stroke = isHighlighted ? '#0190ff' : baseStroke;
            const isMessaging = l.kind === 'messaging';
            // Dashed stroke distinguishes async/messaging edges from
            // synchronous RPC edges even when the pair of services is
            // the same. Dash pattern scales roughly with line width.
            const dashArray = isMessaging ? '6 4' : undefined;
            const edgeKey = `${l.kind ?? 'rpc'}\u0000${sourceId}\u0000${targetId}`;
            // A wider, transparent "hit" line lets hover catch thin
            // edges without the user needing pixel-perfect aim. The
            // visible styled line sits on top of it.
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
                      parent: sourceId,
                      child: targetId,
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
                  style={{ cursor: 'help' }}
                />
                <line
                  x1={sx}
                  y1={sy}
                  x2={tEndX}
                  y2={tEndY}
                  stroke={stroke}
                  strokeOpacity={
                    isHighlighted ? 0.95 : focusId ? 0.15 : hasErrors ? 0.8 : 0.45
                  }
                  strokeWidth={computedWidth}
                  strokeDasharray={dashArray}
                  markerEnd={
                    isHighlighted ? 'url(#arrowheadActive)' : 'url(#arrowhead)'
                  }
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            );
          })}
        </g>

        <g>
          {simNodesRef.current.map((n) => {
            const r = nodeRadius(n);
            const x = n.x ?? 0;
            const y = n.y ?? 0;
            const summary = services.get(n.id);
            const prevSummary = prevServices?.get(n.id);
            const health = serviceHealth(summary, prevSummary);
            const isFocused = focusId === n.id;
            const isPinned = pinned === n.id;
            const idColor = serviceColor(n.id);

            const haloGap = 3;
            const haloRadius = r + haloGap;
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

            return (
              <g
                key={n.id}
                transform={`translate(${x},${y})`}
                style={{ cursor: 'grab', touchAction: 'none' }}
                onMouseEnter={() => setHovered(n.id)}
                onMouseLeave={() => setHovered(null)}
                onPointerDown={(e) => onNodePointerDown(e, n.id)}
                onPointerMove={onNodePointerMove}
                onPointerUp={onNodePointerUp}
                onClick={(e) => e.stopPropagation()}
              >
                {haloWidth > 0 && (
                  <circle
                    r={haloRadius}
                    fill="none"
                    stroke={health.color}
                    strokeWidth={haloWidth}
                    strokeDasharray={haloDash}
                    strokeLinecap="round"
                    opacity={focusId && !isFocused ? 0.35 : 0.85}
                  >
                    {health.bucket === 'critical' && (
                      <>
                        <animate
                          attributeName="r"
                          values={`${haloRadius};${haloRadius + 3};${haloRadius}`}
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
                  </circle>
                )}
                <circle
                  r={r}
                  fill={idColor}
                  stroke={isPinned ? '#1a1a2e' : 'rgba(0,0,0,0.2)'}
                  strokeWidth={isPinned ? 2 : 1}
                  opacity={
                    isGhost ? 0.32 : focusId && !isFocused ? 0.35 : 1
                  }
                  strokeDasharray={isGhost ? '4 3' : undefined}
                />
                <text
                  y={r + haloGap + haloWidth + 12}
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
                    y={r + haloGap + haloWidth + 24}
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
          const { left, top } = tooltipPosition(focusNode);
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
       * Suppressed when a node tooltip is already pinned/focused to
       * avoid two floating cards competing for attention. */}
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
