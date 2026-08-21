import { describe, it, expect } from 'vitest';
import {
  planBackfillWindows,
  planFixedWindows,
  runMetricsBackfill,
  floorToMinute,
  COUNTER_WINDOW_SECONDS,
  type BackfillDeps,
  type BackfillEmitter,
} from '../metricsBackfill';
import { getMetricEmitters } from '../provisionedSearches';
import { setCurrentDataset } from '@criblio/app-utils/dataset';

setCurrentDataset('otel');

describe('planBackfillWindows', () => {
  const bins = (counts: number[], step = 300, t0 = 1000) =>
    counts.map((count, i) => ({ tSec: t0 + i * step, count }));

  it('packs contiguous bins into windows under the cap', () => {
    const w = planBackfillWindows(bins([10, 10, 10, 10]), 300, 25);
    expect(w).toEqual([
      { earliestSec: 1000, latestSec: 1600 },
      { earliestSec: 1600, latestSec: 2200 },
    ]);
  });

  it('is contiguous (no gaps) and covers the whole span', () => {
    const w = planBackfillWindows(bins([10, 10, 10]), 300, 15);
    expect(w[0].earliestSec).toBe(1000);
    expect(w[w.length - 1].latestSec).toBe(1900);
    for (let i = 1; i < w.length; i++) expect(w[i].earliestSec).toBe(w[i - 1].latestSec);
  });

  it('handles empty input', () => {
    expect(planBackfillWindows([], 300, 40)).toEqual([]);
  });
});

describe('planFixedWindows', () => {
  it('splits a range into fixed-size contiguous windows, clamped to the end', () => {
    const w = planFixedWindows(0, 15_000, 6000);
    expect(w).toEqual([
      { earliestSec: 0, latestSec: 6000 },
      { earliestSec: 6000, latestSec: 12000 },
      { earliestSec: 12000, latestSec: 15000 },
    ]);
  });
});

describe('floorToMinute', () => {
  it('floors to the minute', () => {
    expect(floorToMinute(1000)).toBe(960);
    expect(floorToMinute(960)).toBe(960);
  });
});

function fakeDeps(over: Partial<BackfillDeps> = {}): BackfillDeps & { exports: Array<{ e: number; l: number }> } {
  const exports: Array<{ e: number; l: number }> = [];
  return {
    exports,
    countSpans: async () => [
      { tSec: 0, count: 10 },
      { tSec: 300, count: 10 },
    ],
    runExport: async (_q, e, l) => {
      exports.push({ e, l });
      return { eventsOut: 5, eventsDropped: 0 };
    },
    earliestCoveredSec: async () => null, // uncovered by default
    log: () => {},
    ...over,
  };
}

const hist = (id: string, metricName = id): BackfillEmitter => ({
  id, metricName, kind: 'histogram', backfillQuery: `q:${id}`, sampleRate: 1,
});
const counter = (id: string, metricName = id): BackfillEmitter => ({
  id, metricName, kind: 'counter', backfillQuery: `q:${id}`,
});

describe('runMetricsBackfill — per-metric idempotency', () => {
  it('backfills an UNCOVERED metric over the full horizon', async () => {
    const deps = fakeDeps();
    const res = await runMetricsBackfill(deps, [hist('a')], { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].skipped).toBe(false);
    expect(res.exportsRun).toBe(1); // one window (10+10 < cap), one emitter
    expect(res.emitters[0].gapToSec).toBe(600);
  });

  it('SKIPS a metric whose horizon is already covered', async () => {
    // earliestCoveredSec at/below fromSec ⇒ nothing to backfill.
    const deps = fakeDeps({ earliestCoveredSec: async () => 0 });
    const res = await runMetricsBackfill(deps, [hist('a')], { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].skipped).toBe(true);
    expect(res.exportsRun).toBe(0);
    expect(deps.exports).toHaveLength(0);
  });

  it('backfills ONLY the new metric when an existing one is covered', async () => {
    // 'old' is covered (earliest=0 ⇒ skip); 'new' has no data (null ⇒ backfill).
    const deps = fakeDeps({
      earliestCoveredSec: async (metric) => (metric === 'old' ? 0 : null),
    });
    const res = await runMetricsBackfill(deps, [hist('old'), hist('new')], { horizonSec: 600, nowSec: 600 });
    expect(res.emitters.find((e) => e.metricName === 'old')?.skipped).toBe(true);
    expect(res.emitters.find((e) => e.metricName === 'new')?.skipped).toBe(false);
    expect(res.exportsRun).toBe(1); // only 'new' emitted
  });

  it('backfills only the uncovered GAP below the forward-emit boundary', async () => {
    // Forward emit covers from 300s onward ⇒ gap is [0, 300).
    const deps = fakeDeps({
      countSpans: async () => [{ tSec: 0, count: 10 }, { tSec: 300, count: 10 }],
      earliestCoveredSec: async (_m, _k, eMs) => (eMs === 0 ? 300 : null),
    });
    const res = await runMetricsBackfill(deps, [hist('a')], { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].gapToSec).toBe(300);
    // window(s) all sit below 300
    for (const x of deps.exports) expect(x.l).toBeLessThanOrEqual(300_000);
  });
});

describe('runMetricsBackfill — ordering + windows', () => {
  it('runs newest→oldest (reverse) for a counter over big fixed windows', async () => {
    const now = COUNTER_WINDOW_SECONDS * 3; // 3 windows over the horizon
    const deps = fakeDeps({ earliestCoveredSec: async () => null });
    await runMetricsBackfill(deps, [counter('c')], { horizonSec: now, nowSec: now });
    // exports fire newest window first
    const starts = deps.exports.map((x) => x.e);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeLessThan(starts[i - 1]);
    expect(starts[0]).toBe(COUNTER_WINDOW_SECONDS * 2 * 1000); // newest first
  });

  it('resumes via the gap — a re-run fills only what earliestCovered leaves', async () => {
    // A prior run covered from 300s onward ⇒ gap is [0, 300); only the
    // window(s) below 300 are (re)emitted, never touching covered data.
    const deps = fakeDeps({
      countSpans: async () => [{ tSec: 0, count: 30000 }, { tSec: 300, count: 30000 }],
      earliestCoveredSec: async () => 300,
    });
    const res = await runMetricsBackfill(deps, [hist('a')], { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].gapToSec).toBe(300);
    expect(deps.exports.length).toBeGreaterThan(0);
    expect(deps.exports.every((x) => x.l <= 300_000)).toBe(true);
  });
});

describe('runMetricsBackfill — drop handling', () => {
  it('splits a window that drops events and retries until clean', async () => {
    let first = true;
    const deps = fakeDeps({
      countSpans: async () => [{ tSec: 0, count: 10 }],
      runExport: async (_q, e, l) => {
        if (first && l - e >= 300_000) { first = false; return { eventsOut: 0, eventsDropped: 50000 }; }
        return { eventsOut: 10, eventsDropped: 0 };
      },
    });
    const res = await runMetricsBackfill(deps, [hist('a')], { horizonSec: 300, nowSec: 300 });
    expect(res.exportsRun).toBeGreaterThan(1);
    expect(res.totalDropped).toBe(0);
  });

  it('records a dense minute that still drops at the floor', async () => {
    const deps = fakeDeps({
      countSpans: async () => [{ tSec: 0, count: 10 }],
      runExport: async () => ({ eventsOut: 0, eventsDropped: 99999 }),
    });
    const res = await runMetricsBackfill(deps, [hist('a')], { horizonSec: 60, nowSec: 60 });
    expect(res.droppedWindows.length).toBeGreaterThan(0);
    expect(res.totalDropped).toBeGreaterThan(0);
  });
});

describe('getMetricEmitters', () => {
  it('returns emitters with backfill metadata', () => {
    const em = getMetricEmitters();
    const ids = em.map((e) => e.id);
    // core counters + status class + 6 latency gauges (svc/op × p50/95/99)
    // + edge/messaging p95 gauges. Duration histograms are no longer emitted.
    for (const id of [
      'criblapm__metric_requests',
      'criblapm__metric_edge_calls',
      'criblapm__metric_messaging',
      'criblapm__metric_status_class',
      'criblapm__metric_req_lat_p50', 'criblapm__metric_req_lat_p95', 'criblapm__metric_req_lat_p99',
      'criblapm__metric_op_lat_p50', 'criblapm__metric_op_lat_p95', 'criblapm__metric_op_lat_p99',
      'criblapm__metric_edge_lat_p95', 'criblapm__metric_msg_lat_p95',
    ]) {
      expect(ids).toContain(id);
    }
    // no duration histograms remain
    expect(ids).not.toContain('criblapm__metric_duration');
    for (const e of em) {
      expect(e.backfillQuery).toContain('export to metrics');
      expect(e.metricName).toMatch(/^criblapm_/);
      expect(['counter', 'histogram']).toContain(e.kind);
    }
    // latency gauges emit percentile(), read as a gauge (counter kind)
    const lat = em.find((e) => e.id === 'criblapm__metric_req_lat_p95')!;
    expect(lat.kind).toBe('counter');
    expect(lat.backfillQuery).toContain('percentile(dur_ms, 95)');
  });
});
