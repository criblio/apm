/**
 * Dark dual-read seam (M2) for RED panels.
 *
 * When `metricsRead` is ON, this reads per-service rate/errors/latency
 * from the fast PromQL store (synchronous, off the search worker pool)
 * and returns it in a panel-friendly shape. When OFF — or on ANY error /
 * empty result — it returns `null`, and the caller falls back to the
 * existing `$vt_results` cache / live query. That mirrors panelCache.ts's
 * "cache miss is graceful degradation, not an error" contract.
 *
 * Nothing wires this into the live panels yet — that's M4, gated by the
 * same `metricsRead` flag, flipped per-panel after a week of side-by-side
 * agreement. See docs/metrics-migration-plan.md.
 *
 * Read semantics (validated 2026-07-23): request/error counts are DELTA
 * counters read via `sum_over_time`; latency is a histogram read via
 * `histogram_quantile`. See metricNames.ts.
 */
import { type MetricSample, type MetricSeries } from './metrics';
import { cachedQueryInstant, cachedQueryRange } from './metricsCache';
import { getMetricsRead } from './metricsRead';
import { withGenerationSignal } from './queryGeneration';
import {
  promServiceReqErr,
  promServiceReqErrSeries,
  promOpReqErr,
  promEdgeReqErr,
  promMessagingCalls,
  promMessagingErrors,
  promStatusClassSeries,
  promServiceLatencyGauge,
  promServiceLatencyGaugeSeries,
  promOpLatencyGauge,
  promEdgeLatencyGauge,
  promMessagingLatencyGauge,
  toPromWindow,
  promWindow,
} from './metricNames';
import type {
  ServiceSummary,
  ServiceBucket,
  OperationSummary,
  DependencyEdge,
  OperationAnomaly,
  StatusCodeMixBucket,
  StatusCodeClass,
} from './types';

// Anomaly thresholds — mirror the KQL detector in search.ts.
const ANOMALY_MIN_BASELINE_REQUESTS = 20;
const ANOMALY_MIN_RATIO = 5;
const ANOMALY_MIN_CURR_P95_US = 1_000_000;

// Navigation-scoped cancellation: reads default to the current query
// generation's signal (see queryGeneration.ts) so navigating away aborts
// them. `genSignal` is a local alias for brevity in the readers below.
const genSignal = withGenerationSignal;

/** Per-service RED row derived entirely from the metrics store. */
export interface ServiceRedMetrics {
  svc: string;
  /** Request count over the window (all outcomes). */
  requests: number;
  /** Error count over the window (outcome="error"). */
  errors: number;
  /** errors / requests, 0 when no requests. */
  errorRate: number;
  /** Latency percentiles in milliseconds; null when the histogram has no
   *  data for the service in the window. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

function svcOf(s: MetricSample): string | null {
  const svc = s.labels?.svc;
  return svc && svc.trim() ? svc : null;
}

/**
 * Per-service RED metrics over `range` (e.g. `-1h`), or `null` to signal
 * "fall back to the existing path". Never throws — a metrics failure must
 * degrade gracefully, exactly like a `$vt_results` cache miss.
 */
export async function readServiceRedMetrics(
  earliest: string,
  latest = 'now',
  signal?: AbortSignal,
  service?: string,
): Promise<ServiceRedMetrics[] | null> {
  const counts = await readServiceCounts(earliest, latest, signal, service);
  if (!counts) return null;
  const lat = await readServiceLatencies(earliest, latest, signal, service);
  if (lat) applyLatencies(counts, lat);
  return counts;
}

/** Per-service latency quantiles, keyed by svc. */
export type ServiceLatencies = Map<
  string,
  { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null }
>;

/**
 * FAST counts-only read: ONE combined counter query (~114ms) → requests,
 * errors, error rate. Latency is left null. This is the hot path that
 * lets the catalog render immediately; callers enrich latency separately
 * via `readServiceLatencies` (the ~700ms+ histogram_quantile reads) so
 * the slow percentiles never block the table. Returns null (→ fallback)
 * only if the cheap counter query fails / has no data.
 */
export async function readServiceCounts(
  earliest: string,
  latest = 'now',
  signal?: AbortSignal,
  service?: string,
): Promise<ServiceRedMetrics[] | null> {
  if (!getMetricsRead()) return null;
  const w = promWindow(earliest, latest);
  let reqErr: MetricSample[];
  try {
    reqErr = await cachedQueryInstant(promServiceReqErr(w, service), { earliest, latest, signal: genSignal(signal) });
  } catch {
    return null;
  }
  if (reqErr.length === 0) return null;
  const bySvc = new Map<string, ServiceRedMetrics>();
  const row = (svc: string): ServiceRedMetrics => {
    let r = bySvc.get(svc);
    if (!r) {
      r = { svc, requests: 0, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null, p99Ms: null };
      bySvc.set(svc, r);
    }
    return r;
  };
  for (const s of reqErr) {
    const svc = service ?? svcOf(s); // scoped query carries no svc label
    if (!svc) continue;
    const r = row(svc);
    r.requests += s._value;
    if (s.labels.outcome === 'error') r.errors += s._value;
  }
  for (const r of bySvc.values()) r.errorRate = r.requests > 0 ? r.errors / r.requests : 0;
  return [...bySvc.values()].sort((a, b) => b.requests - a.requests);
}

/**
 * Per-service latency quantiles (p50/p95/p99, ms) — 3 histogram_quantile
 * reads (~700ms+ each), best-effort. Fired separately from the counts so
 * the table doesn't wait on it. Returns null when metricsRead is off.
 */
export async function readServiceLatencies(
  earliest: string,
  latest = 'now',
  signal?: AbortSignal,
  service?: string,
): Promise<ServiceLatencies | null> {
  if (!getMetricsRead()) return null;
  const w = promWindow(earliest, latest);
  const opts = { earliest, latest, signal: genSignal(signal) };
  const [p50, p95, p99] = await Promise.all([
    cachedQueryInstant(promServiceLatencyGauge(50, w, service), opts).catch(() => [] as MetricSample[]),
    cachedQueryInstant(promServiceLatencyGauge(95, w, service), opts).catch(() => [] as MetricSample[]),
    cachedQueryInstant(promServiceLatencyGauge(99, w, service), opts).catch(() => [] as MetricSample[]),
  ]);
  const m: ServiceLatencies = new Map();
  const get = (svc: string) => {
    let e = m.get(svc);
    if (!e) { e = { p50Ms: null, p95Ms: null, p99Ms: null }; m.set(svc, e); }
    return e;
  };
  const so = (s: MetricSample) => service ?? svcOf(s); // scoped → no svc label
  for (const s of p50) { const k = so(s); if (k) get(k).p50Ms = s._value; }
  for (const s of p95) { const k = so(s); if (k) get(k).p95Ms = s._value; }
  for (const s of p99) { const k = so(s); if (k) get(k).p99Ms = s._value; }
  return m;
}

function applyLatencies(rows: ServiceRedMetrics[], lat: ServiceLatencies): void {
  for (const r of rows) {
    const l = lat.get(r.svc);
    if (l) { r.p50Ms = l.p50Ms; r.p95Ms = l.p95Ms; r.p99Ms = l.p99Ms; }
  }
}

/** Map the metrics RED shape to the app's ServiceSummary (µs units).
 *  `lastSeenMs` is left undefined — the metrics path has no per-service
 *  last-seen yet, so the staleness pill simply won't show for these rows. */
export function redMetricsToServiceSummaries(rows: ServiceRedMetrics[]): ServiceSummary[] {
  return rows.map((r) => ({
    service: r.svc,
    requests: r.requests,
    errors: r.errors,
    errorRate: r.errorRate,
    p50Us: (r.p50Ms ?? 0) * 1000,
    p95Us: (r.p95Ms ?? 0) * 1000,
    p99Us: (r.p99Ms ?? 0) * 1000,
  }));
}

/**
 * Service summaries from the fast metrics store, or `null` to fall back.
 * The M4 read entry point: `search.listServiceSummaries` calls this first
 * for current-window reads. Honors the `metricsRead` gate (via
 * readServiceRedMetrics).
 */
export async function listServiceSummariesViaMetrics(
  earliest: string,
  latest = 'now',
  signal?: AbortSignal,
  service?: string,
): Promise<ServiceSummary[] | null> {
  const red = await readServiceRedMetrics(earliest, latest, signal, service);
  return red ? redMetricsToServiceSummaries(red) : null;
}

/** Fast counts-only summaries (latency fields 0 until enriched). */
export async function listServiceCountsViaMetrics(
  earliest: string,
  latest = 'now',
  signal?: AbortSignal,
): Promise<ServiceSummary[] | null> {
  const c = await readServiceCounts(earliest, latest, signal);
  return c ? redMetricsToServiceSummaries(c) : null;
}

/** Per-service latency in µs, for merging into counts-first summaries. */
export async function listServiceLatenciesUsViaMetrics(
  earliest: string,
  latest = 'now',
  signal?: AbortSignal,
): Promise<Map<string, { p50Us: number; p95Us: number; p99Us: number }> | null> {
  const lat = await readServiceLatencies(earliest, latest, signal);
  if (!lat) return null;
  const out = new Map<string, { p50Us: number; p95Us: number; p99Us: number }>();
  for (const [svc, l] of lat) {
    out.set(svc, {
      p50Us: (l.p50Ms ?? 0) * 1000,
      p95Us: (l.p95Ms ?? 0) * 1000,
      p99Us: (l.p99Ms ?? 0) * 1000,
    });
  }
  return out;
}

// ── Time series (per-svc RED buckets) — sparklines + RED charts ──────
const lbl = (s: MetricSample | MetricSeries, k: string): string | undefined => {
  const v = s.labels?.[k];
  return v && v.trim() ? v : undefined;
};

/**
 * Per-service RED buckets over `range` at `binSeconds` resolution, or
 * null to fall back. A range query per RED field; points are merged into
 * (service, bucket) rows matching the `$vt_results` serviceTimeSeries
 * shape. Latency (ms) is converted to µs.
 */
export async function readServiceBucketsViaMetrics(
  range: string,
  binSeconds: number,
  /**
   * When set, scope EVERY query to this one service in-PromQL
   * (`{svc="X"}`) instead of computing all services then filtering — a
   * large saving on the single-service Service Detail page — and fetch all
   * three latency quantiles. When undefined (the all-services catalog),
   * queries stay unscoped and only p95 is fetched (sparklines).
   */
  service?: string,
  signal?: AbortSignal,
  /**
   * Counts-first streaming hook. Fired with request/error buckets
   * (latency fields still 0) the moment the cheap counter range query
   * resolves (~600ms) while the expensive histogram_quantile latency
   * queries (~1–2s) are still in flight — so the caller can paint the
   * request-rate + error-rate charts immediately and fill the duration
   * chart when the full result returns.
   */
  onPartial?: (buckets: ServiceBucket[]) => void,
): Promise<ServiceBucket[] | null> {
  if (!getMetricsRead()) return null;
  const bucket = `${Math.max(1, Math.round(binSeconds))}s`;
  // Latency uses `rate()`, which needs ≥2 samples inside its range-vector
  // window. Our metrics are emitted once per MINUTE, so a window tied to a
  // fine bin (e.g. 60s at -1h) usually captures <2 samples and returns
  // NOTHING — the duration chart came back empty (flat 0). Floor the rate
  // window at 5m so it always spans several samples. The step still
  // controls resolution; only the smoothing window widens. The COUNTER
  // uses sum_over_time (1 sample suffices) so it keeps the fine bin.
    // Gauges are emitted once per minute, so the read window must span ≥1
    // minute for each chart step to catch a value; 120s catches ≥2 for a
    // lightly smoothed line without the histogram's flat-0 gaps.
  const gaugeWin = `${Math.max(Math.round(binSeconds), 120)}s`;
  const full = !!service; // single service → all quantiles; catalog → p95 only
  const opts = { earliest: range, latest: 'now', step: binSeconds, signal: genSignal(signal) };
  try {
    // Fire all four concurrently, but AWAIT the cheap counter first so we
    // can emit request/error buckets before the (now fast) latency gauges.
    const reqErrP = cachedQueryRange(promServiceReqErrSeries(bucket, service), opts).catch(() => null);
    const p95P = cachedQueryRange(promServiceLatencyGaugeSeries(95, gaugeWin, service), opts).catch(() => [] as MetricSeries[]);
    const p50P = full ? cachedQueryRange(promServiceLatencyGaugeSeries(50, gaugeWin, service), opts).catch(() => [] as MetricSeries[]) : Promise.resolve([] as MetricSeries[]);
    const p99P = full ? cachedQueryRange(promServiceLatencyGaugeSeries(99, gaugeWin, service), opts).catch(() => [] as MetricSeries[]) : Promise.resolve([] as MetricSeries[]);

    const reqErr = await reqErrP;
    if (!reqErr || reqErr.length === 0) return null;
    const map = new Map<string, ServiceBucket>();
    const key = (svc: string, t: number) => `${svc}\u0000${t}`;
    const cell = (svc: string, tSec: number): ServiceBucket => {
      const k = key(svc, tSec);
      let b = map.get(k);
      if (!b) {
        b = { service: svc, bucketMs: tSec * 1000, requests: 0, errors: 0, p50Us: 0, p95Us: 0, p99Us: 0 };
        map.set(k, b);
      }
      return b;
    };
    // Scoped queries carry no `svc` label — use the requested service.
    for (const s of reqErr) {
      const svc = service ?? lbl(s, 'svc');
      if (!svc) continue;
      const isErr = s.labels.outcome === 'error';
      for (const p of s.points) {
        const c = cell(svc, p.t);
        c.requests += p.v;
        if (isErr) c.errors += p.v;
      }
    }
    const snapshot = () => [...map.values()].sort((a, b) => a.service.localeCompare(b.service) || a.bucketMs - b.bucketMs);
    // Emit counts-only buckets now — the rate + error charts can render
    // while the histogram_quantile latency queries are still resolving.
    if (onPartial) onPartial(snapshot());

    const [p95, p50, p99] = await Promise.all([p95P, p50P, p99P]);
    // Latency ENRICHES existing counter buckets only — it must NOT create
    // its own. The counter (criblapm__metric_requests) and the duration
    // histogram (criblapm__metric_duration) are separate scheduled searches
    // with independent jitter, and the latency query uses a wider (5m) rate
    // window, so it returns points for trailing minutes the counter hasn't
    // summarized yet. Creating cells from those would draw a phantom
    // requests=0 bucket at the right edge (the "dropped to zero" the user
    // saw). Keying to the counter means a bucket exists iff the minute was
    // actually summarized — the counter never emits an empty bucket.
    const enrich = (svc: string, tSec: number, field: 'p50Us' | 'p95Us' | 'p99Us', v: number) => {
      const b = map.get(key(svc, tSec));
      if (b) b[field] = v;
    };
    for (const s of p50) { const svc = service ?? lbl(s, 'svc'); if (svc) for (const p of s.points) enrich(svc, p.t, 'p50Us', p.v * 1000); }
    for (const s of p95) { const svc = service ?? lbl(s, 'svc'); if (svc) for (const p of s.points) enrich(svc, p.t, 'p95Us', p.v * 1000); }
    for (const s of p99) { const svc = service ?? lbl(s, 'svc'); if (svc) for (const p of s.points) enrich(svc, p.t, 'p99Us', p.v * 1000); }
    return snapshot();
  } catch {
    return null;
  }
}

// ── Status-code mix (per svc, status_class) — Service Detail chart ───
/**
 * Per-bucket HTTP/gRPC status-class counts for one service from the fast
 * store, or null to fall back to KQL. Reads the `criblapm_status_class_total`
 * delta counter (sum_over_time) grouped by status_class; filters to
 * `service` client-side. Current-window only (time-series).
 */
export async function readServiceStatusMixViaMetrics(
  binSeconds: number,
  service: string,
  range: string,
  signal?: AbortSignal,
): Promise<StatusCodeMixBucket[] | null> {
  if (!getMetricsRead()) return null;
  const bucket = `${Math.max(1, Math.round(binSeconds))}s`;
  const opts = { earliest: range, latest: 'now', step: binSeconds, signal: genSignal(signal) };
  try {
    const series = await cachedQueryRange(promStatusClassSeries(bucket), opts);
    if (!series || series.length === 0) return null;
    const out: StatusCodeMixBucket[] = [];
    for (const s of series) {
      if (lbl(s, 'svc') !== service) continue;
      const cls = lbl(s, 'status_class');
      if (!cls) continue;
      for (const p of s.points) {
        out.push({ bucketMs: p.t * 1000, statusClass: cls as StatusCodeClass, count: p.v });
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ── Top operations (per svc, operation) — Service Detail table ───────
/**
 * OperationSummary rows for one service, or null to fall back. The metric
 * carries an `operation` label; we filter to `service` and key by
 * operation. `service` is required (operation names collide across svcs).
 */
export async function readServiceOperationsViaMetrics(
  range: string,
  service: string,
  signal?: AbortSignal,
): Promise<OperationSummary[] | null> {
  if (!getMetricsRead()) return null;
  const w = toPromWindow(range);
  const opts = { earliest: range, latest: 'now', signal: genSignal(signal) };
  try {
    // Scope every query to this service IN-QUERY ({svc="X"} by (le,
    // operation)) — the unscoped `by (le, svc, operation)` fanned out over
    // every service's operations and was the slowest read on the page.
    const [reqErr, p50, p95, p99] = await Promise.all([
      cachedQueryInstant(promOpReqErr(w, service), opts).catch(() => null),
      cachedQueryInstant(promOpLatencyGauge(50, w, service), opts).catch(() => [] as MetricSample[]),
      cachedQueryInstant(promOpLatencyGauge(95, w, service), opts).catch(() => [] as MetricSample[]),
      cachedQueryInstant(promOpLatencyGauge(99, w, service), opts).catch(() => [] as MetricSample[]),
    ]);
    if (!reqErr || reqErr.length === 0) return null;
    const map = new Map<string, OperationSummary>();
    // Results are already scoped to `service` (no svc label to check).
    const cell = (op: string): OperationSummary => {
      let o = map.get(op);
      if (!o) {
        o = { operation: op, requests: 0, errors: 0, errorRate: 0, p50Us: 0, p95Us: 0, p99Us: 0 };
        map.set(op, o);
      }
      return o;
    };
    for (const s of reqErr) {
      const op = lbl(s, 'operation');
      if (!op) continue;
      const o = cell(op);
      o.requests += s._value;
      if (s.labels.outcome === 'error') o.errors += s._value;
    }
    for (const s of p50) { const op = lbl(s, 'operation'); if (op) cell(op).p50Us = s._value * 1000; }
    for (const s of p95) { const op = lbl(s, 'operation'); if (op) cell(op).p95Us = s._value * 1000; }
    for (const s of p99) { const op = lbl(s, 'operation'); if (op) cell(op).p99Us = s._value * 1000; }
    if (map.size === 0) return null;
    for (const o of map.values()) o.errorRate = o.requests > 0 ? o.errors / o.requests : 0;
    return [...map.values()].sort((a, b) => b.requests - a.requests);
  } catch {
    return null;
  }
}

// ── Operation latency anomalies — current p95 vs 24h baseline ───────
/**
 * Per-(svc, op) latency anomalies from metrics: current-window p95 vs the
 * 24h-baseline p95, flagged when the ratio and absolute latency clear the
 * thresholds and the baseline had enough traffic. Replaces the KQL
 * detector (`operationAnomaliesFromLookup`, which created a search job and
 * read the op_baselines lookup). Returns null → fall back only if the
 * current-p95 read fails.
 */
export async function readOperationAnomaliesViaMetrics(
  range: string,
  topN: number,
  signal?: AbortSignal,
): Promise<OperationAnomaly[] | null> {
  if (!getMetricsRead()) return null;
  const w = promWindow(range, 'now');
  const opts = { earliest: range, latest: 'now', signal: genSignal(signal) };
  const baseOpts = { earliest: '-24h', latest: 'now', signal: genSignal(signal) };
  const [currP95, basP95, basReq] = await Promise.all([
    cachedQueryInstant(promOpLatencyGauge(95, w), opts).catch(() => null),
    cachedQueryInstant(promOpLatencyGauge(95, '24h'), baseOpts).catch(() => [] as MetricSample[]),
    cachedQueryInstant(promOpReqErr('24h'), baseOpts).catch(() => [] as MetricSample[]),
  ]);
  if (!currP95) return null;

  const key = (svc: string, op: string) => `${svc}\u0000${op}`;
  const curr = new Map<string, number>();
  const base = new Map<string, number>();
  const baseReq = new Map<string, number>();
  for (const s of currP95) { const svc = lbl(s, 'svc'), op = lbl(s, 'operation'); if (svc && op) curr.set(key(svc, op), s._value); }
  for (const s of basP95) { const svc = lbl(s, 'svc'), op = lbl(s, 'operation'); if (svc && op) base.set(key(svc, op), s._value); }
  for (const s of basReq) {
    const svc = lbl(s, 'svc'), op = lbl(s, 'operation');
    if (svc && op) baseReq.set(key(svc, op), (baseReq.get(key(svc, op)) ?? 0) + s._value);
  }

  const out: OperationAnomaly[] = [];
  for (const [k, currMs] of curr) {
    const baseMs = base.get(k);
    const req = baseReq.get(k) ?? 0;
    if (!baseMs || baseMs <= 0) continue;
    const ratio = currMs / baseMs;
    const currUs = currMs * 1000;
    if (ratio >= ANOMALY_MIN_RATIO && currUs >= ANOMALY_MIN_CURR_P95_US && req >= ANOMALY_MIN_BASELINE_REQUESTS) {
      const [svc, op] = k.split('\u0000');
      out.push({ service: svc, operation: op, currP95Us: currUs, prevP95Us: baseMs * 1000, ratio, requests: req });
    }
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out.slice(0, topN);
}

// ── Dependency edges (RPC + messaging) — System Architecture ────────
const MSG_PRODUCER_OPS = new Set(['publish', 'send', 'create']);

/**
 * Service dependency edges (RPC self-join edges + messaging
 * producer→consumer edges) from metrics, or null to fall back. RPC edges
 * key on (parent, child). Messaging edges pair each producer with each
 * consumer on a topic (matching toMessagingEdges), keyed by op∈producer/
 * consumer classification.
 */
export async function readDependencyEdgesViaMetrics(
  range: string,
  signal?: AbortSignal,
): Promise<DependencyEdge[] | null> {
  if (!getMetricsRead()) return null;
  const w = toPromWindow(range);
  const opts = { earliest: range, latest: 'now', signal: genSignal(signal) };
  try {
    const [edgeReqErr, p95, mcalls, merrs, mp95] = await Promise.all([
      cachedQueryInstant(promEdgeReqErr(w), opts).catch(() => null),
      cachedQueryInstant(promEdgeLatencyGauge(95, w), opts).catch(() => [] as MetricSample[]),
      cachedQueryInstant(promMessagingCalls(w), opts).catch(() => [] as MetricSample[]),
      cachedQueryInstant(promMessagingErrors(w), opts).catch(() => [] as MetricSample[]),
      cachedQueryInstant(promMessagingLatencyGauge(95, w), opts).catch(() => [] as MetricSample[]),
    ]);
    if ((!edgeReqErr || edgeReqErr.length === 0) && mcalls.length === 0) return null;

    const edges = new Map<string, DependencyEdge>();
    const rpc = (p: string, c: string): DependencyEdge => {
      const k = `rpc\u0000${p}\u0000${c}`;
      let e = edges.get(k);
      if (!e) { e = { parent: p, child: c, callCount: 0, errorCount: 0, p95DurUs: 0, kind: 'rpc' }; edges.set(k, e); }
      return e;
    };
    for (const s of edgeReqErr ?? []) {
      const p = lbl(s, 'parent'), c = lbl(s, 'child');
      if (!p || !c) continue;
      const e = rpc(p, c);
      e.callCount += s._value;
      if (s.labels.outcome === 'error') e.errorCount += s._value;
    }
    for (const s of p95) { const p = lbl(s, 'parent'), c = lbl(s, 'child'); if (p && c) rpc(p, c).p95DurUs = s._value * 1000; }

    // Messaging: gather per-topic producer/consumer legs, then pair.
    interface Leg { svc: string; calls: number; errors: number; p95Us: number }
    const topics = new Map<string, { producers: Map<string, Leg>; consumers: Map<string, Leg> }>();
    const leg = (topic: string, side: 'producers' | 'consumers', svc: string): Leg => {
      let t = topics.get(topic);
      if (!t) { t = { producers: new Map(), consumers: new Map() }; topics.set(topic, t); }
      let l = t[side].get(svc);
      if (!l) { l = { svc, calls: 0, errors: 0, p95Us: 0 }; t[side].set(svc, l); }
      return l;
    };
    const sideOf = (op?: string): 'producers' | 'consumers' =>
      op && MSG_PRODUCER_OPS.has(op.toLowerCase()) ? 'producers' : 'consumers';
    const applyMsg = (samples: MetricSample[], field: 'calls' | 'errors' | 'p95Us', scale = 1) => {
      for (const s of samples) {
        const svc = lbl(s, 'svc'), dest = lbl(s, 'dest');
        if (!svc || !dest) continue;
        const l = leg(dest, sideOf(lbl(s, 'op')), svc);
        if (field === 'p95Us') l.p95Us = Math.max(l.p95Us, s._value * scale);
        else l[field] += s._value;
      }
    };
    applyMsg(mcalls, 'calls');
    applyMsg(merrs, 'errors');
    applyMsg(mp95, 'p95Us', 1000);
    for (const [topic, { producers, consumers }] of topics) {
      // If a side is empty, still show the other as an edge to the topic
      // so a lone producer/consumer isn't dropped.
      const prod = producers.size ? [...producers.values()] : [{ svc: topic, calls: 0, errors: 0, p95Us: 0 }];
      const cons = consumers.size ? [...consumers.values()] : [{ svc: topic, calls: 0, errors: 0, p95Us: 0 }];
      for (const p of prod) for (const c of cons) {
        if (p.svc === c.svc) continue;
        edges.set(`msg\u0000${p.svc}\u0000${c.svc}\u0000${topic}`, {
          parent: p.svc, child: c.svc,
          callCount: Math.max(p.calls, c.calls),
          errorCount: Math.max(p.errors, c.errors),
          p95DurUs: Math.max(p.p95Us, c.p95Us),
          kind: 'messaging', topic,
        });
      }
    }
    return [...edges.values()].sort((a, b) => b.callCount - a.callCount);
  } catch {
    return null;
  }
}
