/**
 * APM's metrics backfill: the framework's runMetricsBackfill driven by
 * APM's emitter registry, window planner and coverage probe. The generic
 * algorithm (gap from coverage, newest→oldest, split-on-drop) is tested in
 * the framework; these tests pin what APM supplies and the framework
 * behaviours APM adopted deliberately when it dropped its own copy:
 *   - a dropping window is split NEWER half first (APM ran older first);
 *   - a window that drops EVERY event stops that emitter as `failed`
 *     instead of splitting to the one-minute floor;
 *   - an export that returns no stats row is counted (`unreportedExports`)
 *     instead of silently reading as 0 out / 0 dropped.
 */
import { describe, it, expect } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import {
  createMetricsCoverageProbe,
  DEFAULT_BACKFILL_WINDOW_SECONDS,
  type ExportStats,
} from '@criblio/app-utils/metrics-backfill';
import type { MetricsTransport } from '@criblio/app-utils/metrics';
import {
  emitterFamilyLabel,
  makeApmPlanWindows,
  runMetricsBackfill,
  spanCountBins,
  type ApmBackfillDeps,
  type BackfillEmitter,
  type SpanCountBin,
} from '../metricsBackfill';
import { getMetricEmitters } from '../provisionedSearches';

setCurrentDataset('otel');

const noHttp = { get: async () => ({}), post: async () => ({}) };
const clean = (eventsOut = 5): ExportStats => ({ eventsOut, eventsDropped: 0, dropReasons: {}, reported: true });

function fakeDeps(
  over: Partial<ApmBackfillDeps> & { bins?: SpanCountBin[] } = {},
): ApmBackfillDeps & { exports: Array<{ e: number; l: number }> } {
  const exports: Array<{ e: number; l: number }> = [];
  const bins = over.bins ?? [{ tSec: 0, count: 10 }, { tSec: 300, count: 10 }];
  return {
    exports,
    runExport: async (_q, e, l) => {
      exports.push({ e, l });
      return clean();
    },
    earliestCoveredSec: async () => null, // uncovered by default
    planWindows: makeApmPlanWindows(noHttp, async () => bins),
    log: () => {},
    ...over,
  };
}

const hist = (id: string, sampleRate = 1): BackfillEmitter => ({
  id, metricName: id, kind: 'histogram', query: `q:${id}`, sampleRate,
});
const counter = (id: string): BackfillEmitter => ({ id, metricName: id, kind: 'counter', query: `q:${id}` });

describe('makeApmPlanWindows', () => {
  it('plans counters/gauges as contiguous fixed 6h windows over the gap', async () => {
    const plan = makeApmPlanWindows(noHttp, async () => { throw new Error('counters never count spans'); });
    const w = await plan(counter('c'), { earliestSec: 0, latestSec: DEFAULT_BACKFILL_WINDOW_SECONDS * 2 + 60 });
    expect(w).toEqual([
      { earliestSec: 0, latestSec: DEFAULT_BACKFILL_WINDOW_SECONDS },
      { earliestSec: DEFAULT_BACKFILL_WINDOW_SECONDS, latestSec: DEFAULT_BACKFILL_WINDOW_SECONDS * 2 },
      { earliestSec: DEFAULT_BACKFILL_WINDOW_SECONDS * 2, latestSec: DEFAULT_BACKFILL_WINDOW_SECONDS * 2 + 60 },
    ]);
  });

  it('sizes histogram windows from span counts in the gap, scaled by sampleRate', async () => {
    const counts: Array<[number, number]> = [];
    const plan = makeApmPlanWindows(noHttp, async (e, l) => {
      counts.push([e, l]);
      return [
        { tSec: 0, count: 30_000 }, { tSec: 300, count: 30_000 },
        { tSec: 600, count: 30_000 }, { tSec: 900, count: 30_000 }, // outside the gap
      ];
    });
    // Unsampled: 40k cap → one 5-minute bin per window.
    expect(await plan(hist('h'), { earliestSec: 0, latestSec: 900 })).toEqual([
      { earliestSec: 0, latestSec: 300 }, { earliestSec: 300, latestSec: 600 }, { earliestSec: 600, latestSec: 900 },
    ]);
    // 0.25 sample rate: a window may hold 160k raw spans → one window.
    expect(await plan(hist('h', 0.25), { earliestSec: 0, latestSec: 900 })).toEqual([
      { earliestSec: 0, latestSec: 900 },
    ]);
    expect(counts[0]).toEqual([0, 900_000]); // the count pass covers only the gap
  });

  it('clamps histogram windows to a gap that is not bin-aligned', async () => {
    // 5-minute count bins, minute-aligned gap [60, 420): never emit outside
    // it — past the top is already-covered data the store would double.
    const plan = makeApmPlanWindows(noHttp, async () => [
      { tSec: 0, count: 30_000 }, { tSec: 300, count: 30_000 },
    ]);
    expect(await plan(hist('h'), { earliestSec: 60, latestSec: 420 })).toEqual([
      { earliestSec: 60, latestSec: 300 }, { earliestSec: 300, latestSec: 420 },
    ]);
  });

  it('parses backfillSpanCounts rows', () => {
    expect(spanCountBins([{ t: 60, n: '7' }, { status: 'x' }])).toEqual([{ tSec: 60, count: 7 }]);
  });
});

describe('runMetricsBackfill with APM deps — per-metric idempotency', () => {
  it('backfills an UNCOVERED metric over the full horizon', async () => {
    const deps = fakeDeps();
    const res = await runMetricsBackfill([hist('a')], deps, { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].status).toBe('filled');
    expect(res.exportsRun).toBe(1); // one window (10+10 < cap), one emitter
    expect(res.emitters[0].gap).toEqual({ earliestSec: 0, latestSec: 600 });
  });

  it('SKIPS a metric whose horizon is already covered', async () => {
    const deps = fakeDeps({ earliestCoveredSec: async () => 0 });
    const res = await runMetricsBackfill([hist('a')], deps, { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].status).toBe('skipped');
    expect(deps.exports).toHaveLength(0);
  });

  it('backfills ONLY the new metric when an existing one is covered', async () => {
    const deps = fakeDeps({ earliestCoveredSec: async (e) => (e.metricName === 'old' ? 0 : null) });
    const res = await runMetricsBackfill([hist('old'), hist('new')], deps, { horizonSec: 600, nowSec: 600 });
    expect(res.emitters.map((e) => [e.id, e.status])).toEqual([['old', 'skipped'], ['new', 'filled']]);
    expect(res.exportsRun).toBe(1);
  });

  it('backfills only the uncovered GAP below the forward-emit boundary', async () => {
    const deps = fakeDeps({ earliestCoveredSec: async () => 300 });
    const res = await runMetricsBackfill([hist('a')], deps, { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].gap).toEqual({ earliestSec: 0, latestSec: 300 });
    expect(deps.exports.length).toBeGreaterThan(0);
    for (const x of deps.exports) expect(x.l).toBeLessThanOrEqual(300_000);
  });

  it('runs counter windows newest→oldest', async () => {
    const now = DEFAULT_BACKFILL_WINDOW_SECONDS * 3;
    const deps = fakeDeps();
    await runMetricsBackfill([counter('c')], deps, { horizonSec: now, nowSec: now });
    expect(deps.exports.map((x) => x.e / 1000)).toEqual([
      DEFAULT_BACKFILL_WINDOW_SECONDS * 2, DEFAULT_BACKFILL_WINDOW_SECONDS, 0,
    ]);
  });
});

describe('runMetricsBackfill with APM deps — drop handling (adopted framework behaviour)', () => {
  it('splits a partly dropping window, NEWER half first, until clean', async () => {
    let first = true;
    const deps = fakeDeps({
      bins: [{ tSec: 0, count: 10 }],
      runExport: async (_q, e, l) => {
        deps.exports.push({ e, l });
        if (first) { first = false; return { eventsOut: 40_000, eventsDropped: 10_000, dropReasons: {}, reported: true }; }
        return clean(10);
      },
    });
    const res = await runMetricsBackfill([hist('a')], deps, { horizonSec: 300, nowSec: 300 });
    expect(deps.exports).toEqual([
      { e: 0, l: 300_000 },
      { e: 120_000, l: 300_000 }, // newer half first: coverage stays contiguous from the top
      { e: 0, l: 120_000 },
    ]);
    expect(res.eventsDropped).toBe(0);
    expect(res.emitters[0].partialRetries).toEqual([{ earliestSec: 0, latestSec: 300 }]);
  });

  it('records a dense minute that still drops at the one-minute floor', async () => {
    const deps = fakeDeps({
      bins: [{ tSec: 0, count: 10 }],
      runExport: async () => ({ eventsOut: 1, eventsDropped: 99_999, dropReasons: {}, reported: true }),
    });
    const res = await runMetricsBackfill([hist('a')], deps, { horizonSec: 60, nowSec: 60 });
    expect(res.emitters[0].droppedWindows).toEqual([{ earliestSec: 0, latestSec: 60 }]);
    expect(res.eventsDropped).toBe(99_999);
  });

  it('stops an emitter whose export drops EVERY event, and runs the next one', async () => {
    const deps = fakeDeps({
      runExport: async (q, e, l) => {
        deps.exports.push({ e, l });
        return q === 'q:broken'
          ? { eventsOut: 0, eventsDropped: 500, dropReasons: { invalid_type: 500 }, reported: true }
          : clean();
      },
    });
    const now = DEFAULT_BACKFILL_WINDOW_SECONDS * 2;
    const res = await runMetricsBackfill([counter('broken'), counter('ok')], deps, { horizonSec: now, nowSec: now });
    expect(res.emitters[0].status).toBe('failed');
    expect(res.emitters[0].error).toContain('invalid_type');
    expect(res.emitters[0].exportsRun).toBe(1); // no split cascade
    expect(res.emitters[1].status).toBe('filled');
  });

  it('counts an export that returned no stats row', async () => {
    const deps = fakeDeps({
      runExport: async () => ({ eventsOut: 0, eventsDropped: 0, dropReasons: {}, reported: false }),
    });
    const res = await runMetricsBackfill([hist('a')], deps, { horizonSec: 600, nowSec: 600 });
    expect(res.emitters[0].status).toBe('filled');
    expect(res.emitters[0].unreportedExports).toBe(1);
  });
});

describe('coverage probe for the per-quantile percentile gauges', () => {
  /** NDJSON a `count by (quantile)` range query returns: p50/p95 from 120s,
   *  p99 only from 600s. */
  const transportCalls: string[] = [];
  const transport: MetricsTransport = async (query) => {
    transportCalls.push(query);
    const rows = [
      ...[120, 180, 600].map((t) => ({ _kind: 'sample', _time: t, _value: 4, quantile: 'p50' })),
      ...[120, 600].map((t) => ({ _kind: 'sample', _time: t, _value: 4, quantile: 'p95' })),
      { _kind: 'sample', _time: 600, _value: 4, quantile: 'p99' },
    ];
    return [JSON.stringify({ isFinished: true, totalEventCount: rows.length }), ...rows.map((r) => JSON.stringify(r))].join('\n');
  };
  const probe = createMetricsCoverageProbe<BackfillEmitter>({ transport });
  const byId = new Map(getMetricEmitters().map((e) => [e.id, e]));

  it('probes count by (quantile) and takes only the emitter’s own quantile', async () => {
    transportCalls.length = 0;
    expect(await probe(byId.get('criblapm__metric_req_lat_p95')!, 0, 900_000)).toBe(120);
    expect(await probe(byId.get('criblapm__metric_req_lat_p99')!, 0, 900_000)).toBe(600);
    expect(transportCalls[0]).toBe('count by (quantile) (criblapm_request_latency_ms)');
  });

  it('reads a quantile with no samples as uncovered even when its siblings exist', async () => {
    const edge = byId.get('criblapm__metric_edge_lat_p95')!;
    const noP95: MetricsTransport = async () =>
      [JSON.stringify({ isFinished: true, totalEventCount: 1 }), JSON.stringify({ _kind: 'sample', _time: 60, _value: 1, quantile: 'p50' })].join('\n');
    expect(await createMetricsCoverageProbe<BackfillEmitter>({ transport: noP95 })(edge, 0, 900_000)).toBeNull();
  });

  it('probes plain counters with count(metric)', async () => {
    transportCalls.length = 0;
    await probe(byId.get('criblapm__metric_requests')!, 0, 900_000);
    expect(transportCalls[0]).toBe('count(criblapm_requests_total)');
  });
});

describe('getMetricEmitters', () => {
  it('returns emitters with backfill metadata', () => {
    const em = getMetricEmitters();
    const ids = em.map((e) => e.id);
    // core counters + status class + 6 latency gauges (svc/op × p50/95/99)
    // + edge/messaging p95 gauges. Duration histograms are no longer emitted.
    expect(ids).toEqual([
      'criblapm__metric_requests',
      'criblapm__metric_edge_calls',
      'criblapm__metric_messaging',
      'criblapm__metric_status_class',
      'criblapm__metric_req_lat_p50', 'criblapm__metric_op_lat_p50',
      'criblapm__metric_req_lat_p95', 'criblapm__metric_op_lat_p95',
      'criblapm__metric_req_lat_p99', 'criblapm__metric_op_lat_p99',
      'criblapm__metric_edge_lat_p95', 'criblapm__metric_msg_lat_p95',
    ]);
    for (const e of em) {
      expect(e.query).toContain('export to metrics');
      // A bare PromQL identifier: the framework probe rejects selectors, so
      // the quantile lives in coverageSplit, not in the name.
      expect(e.metricName).toMatch(/^criblapm_[a-z_]+$/);
      expect(['counter', 'histogram']).toContain(e.kind);
    }
    // latency gauges emit percentile(), read as a gauge (counter kind), one
    // quantile per emitter
    const lat = em.find((e) => e.id === 'criblapm__metric_req_lat_p95')!;
    expect(lat.kind).toBe('counter');
    expect(lat.query).toContain('percentile(dur_ms, 95)');
    expect(lat.coverageSplit).toEqual({ label: 'quantile', values: ['p95'] });
    expect(emitterFamilyLabel(lat)).toBe('criblapm_request_latency_ms{quantile="p95"}');
    expect(em.find((e) => e.id === 'criblapm__metric_requests')!.coverageSplit).toBeUndefined();
  });
});
