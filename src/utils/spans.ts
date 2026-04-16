/**
 * Utilities for working with Jaeger-shaped traces:
 *  - building a parent/child tree from references
 *  - DFS flattening to a linear ordered list with depth
 *  - deterministic per-service colour assignment
 */
import type { JaegerSpan, JaegerTrace } from '../api/types';

export interface SpanNode {
  span: JaegerSpan;
  depth: number;
  hasChildren: boolean;
  childIds: string[];
}

export interface TraceTimeline {
  traceStart: number; // μs
  traceEnd: number; // μs
  traceDuration: number; // μs (always > 0)
  rootSpanId: string | null;
  nodes: SpanNode[]; // DFS-ordered
}

/**
 * Walk a trace's spans, build a parent→children map, then DFS in start-time
 * order so the timeline reads top-down.
 */
export function buildTimeline(trace: JaegerTrace): TraceTimeline {
  const spans = trace.spans;
  if (spans.length === 0) {
    return { traceStart: 0, traceEnd: 0, traceDuration: 1, rootSpanId: null, nodes: [] };
  }

  const byId = new Map<string, JaegerSpan>();
  const childrenOf = new Map<string, string[]>();
  for (const sp of spans) {
    byId.set(sp.spanID, sp);
  }
  const roots: string[] = [];
  for (const sp of spans) {
    const parentRef = sp.references.find((r) => r.refType === 'CHILD_OF');
    if (parentRef && byId.has(parentRef.spanID)) {
      const list = childrenOf.get(parentRef.spanID) ?? [];
      list.push(sp.spanID);
      childrenOf.set(parentRef.spanID, list);
    } else {
      roots.push(sp.spanID);
    }
  }

  // Sort children by startTime
  for (const list of childrenOf.values()) {
    list.sort((a, b) => byId.get(a)!.startTime - byId.get(b)!.startTime);
  }
  roots.sort((a, b) => byId.get(a)!.startTime - byId.get(b)!.startTime);

  const nodes: SpanNode[] = [];
  function visit(id: string, depth: number) {
    const span = byId.get(id);
    if (!span) return;
    const children = childrenOf.get(id) ?? [];
    nodes.push({ span, depth, hasChildren: children.length > 0, childIds: children });
    for (const cid of children) visit(cid, depth + 1);
  }
  for (const r of roots) visit(r, 0);

  // Time window — anchor the chart's coordinate space to the root
  // span (first parent-less span in start-time order) when one
  // exists, and extend the right edge only for spans whose start
  // falls *inside* that root window.
  //
  // Walking raw min/max across every span is naive against intra-
  // trace clock skew: some OTel instrumentations (PHP in particular,
  // when a service's SDK is stamping span times from a different
  // monotonic source than its upstream caller) occasionally emit
  // child spans whose start_time lands fractions of a second before
  // their parent's start. A single skewed child then drags
  // `traceStart` into the past and blows the waterfall scale so the
  // real work is crammed into the last few percent of the chart
  // width, leaving the left side of the waterfall visibly empty.
  //
  // Anchoring to the root keeps the scale tied to what the trace
  // actually measured. Skewed spans still belong to the trace and
  // remain selectable in SpanTree — their bars are clipped by the
  // renderer rather than scaling the chart around them. The
  // `traceEnd` extension covers legitimate async overflow where a
  // child span started inside the root window outlives its parent.
  //
  // Fall back to the raw min/max walk when there is no root span
  // (fragmented traces, dropped parent links) so multi-root shapes
  // still display with reasonable bounds.
  let traceStart: number;
  let traceEnd: number;
  const rootId = roots[0];
  if (rootId) {
    const root = byId.get(rootId)!;
    traceStart = root.startTime;
    traceEnd = root.startTime + root.duration;
    for (const sp of spans) {
      if (sp.startTime < traceStart) continue; // skew before the root — ignore
      const e = sp.startTime + sp.duration;
      if (e > traceEnd) traceEnd = e;
    }
  } else {
    traceStart = Infinity;
    traceEnd = -Infinity;
    for (const sp of spans) {
      if (sp.startTime < traceStart) traceStart = sp.startTime;
      const e = sp.startTime + sp.duration;
      if (e > traceEnd) traceEnd = e;
    }
  }
  const traceDuration = Math.max(1, traceEnd - traceStart);

  return {
    traceStart,
    traceEnd,
    traceDuration,
    rootSpanId: roots[0] ?? null,
    nodes,
  };
}

/**
 * Stable hash → hue mapping for service identity colors.
 *
 * Why identity (hash) colors and not health colors everywhere:
 *   - The trace waterfall needs identity colors so you can visually follow
 *     a call chain (cyan bar -> magenta -> green = load-generator ->
 *     frontend -> product-catalog). Switching to health would collapse
 *     every span to green/red and break that mental model.
 *   - The Home catalog and System Architecture DO benefit from health
 *     signaling, so those views add health as a secondary signal: Home
 *     tints row backgrounds, Sys Arch fills nodes by health and draws a
 *     subtle identity-hued ring around them.
 *   - Compare and Logs use identity colors to keep services recognizable.
 *
 * So: identity colors are for *tracking a service across views*, health
 * colors are for *scanning for problems*. Both signals live side by side.
 */
export function serviceColor(service: string): string {
  return `hsl(${serviceHue(service)}, 60%, 50%)`;
}

/** Same hue as serviceColor() but at a custom lightness. Used by the
 * isometric view to render cylinder sides + bottom shadows in darker
 * shades of the service's identity color. */
export function serviceColorAtLightness(service: string, lightnessPct: number): string {
  return `hsl(${serviceHue(service)}, 60%, ${lightnessPct}%)`;
}

function serviceHue(service: string): number {
  let hash = 0;
  for (let i = 0; i < service.length; i++) {
    hash = (hash * 31 + service.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** Format a μs duration as a short human string. */
export function formatDurationUs(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}
