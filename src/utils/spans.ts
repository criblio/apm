/**
 * Utilities for working with Jaeger-shaped traces. The waterfall layout
 * is the framework's generic `buildTimeline` (@criblio/app-utils/viz);
 * this file only says how to read a Jaeger span. Service identity
 * colours are `entityColor` from the same module.
 */
import { buildTimeline, type Timeline, type TimelineAccessors } from '@criblio/app-utils/viz';
import type { JaegerSpan, JaegerTrace } from '../api/types';

/**
 * How the framework timeline reads a Jaeger span: the parent is the
 * span's first CHILD_OF reference (FOLLOWS_FROM links do not nest), and
 * times stay in Jaeger's microseconds, so `end` = start + duration.
 */
export const jaegerSpanAccessors: TimelineAccessors<JaegerSpan> = {
  id: (sp) => sp.spanID,
  parentId: (sp) => sp.references.find((r) => r.refType === 'CHILD_OF')?.spanID,
  start: (sp) => sp.startTime,
  end: (sp) => sp.startTime + sp.duration,
};

/**
 * Depth-first, start-ordered waterfall for a trace, windowed to the root
 * span (μs). Clock-skewed children stamped before the root are clipped
 * (`clippedStart` / `inWindow: false`) instead of rescaling the chart —
 * see `buildTimeline` in @criblio/app-utils/viz.
 */
export function traceTimeline(trace: JaegerTrace): Timeline<JaegerSpan> {
  return buildTimeline(trace.spans, jaegerSpanAccessors);
}

/** Format a μs duration as a short human string. */
export function formatDurationUs(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}
