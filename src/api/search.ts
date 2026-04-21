/**
 * High-level search operations: combine queries.ts + cribl.ts + transform.ts
 * into the verbs the UI calls.
 */
import { runQuery } from './cribl';
import * as Q from './queries';
import { toJaegerTraces, summarizeTrace, toDependencyEdges, toMessagingEdges } from './transform';
import type {
  TraceSummary,
  JaegerTrace,
  DependencyEdge,
  ServiceSummary,
  ServiceBucket,
  OperationSummary,
  InstanceSummary,
  OperationAnomaly,
  TraceBrief,
  TraceLogEntry,
  SlowTraceClass,
  ErrorClass,
  MetricSummary,
  MetricSeries,
  MetricSeriesGroup,
  MetricInfo,
  MetricType,
} from './types';

export async function listServices(earliest = '-1h'): Promise<string[]> {
  const rows = await runQuery(Q.services(), earliest, 'now', 500);
  return rows.map((r) => String(r.svc)).filter(Boolean);
}

export async function listOperations(service: string, earliest = '-1h'): Promise<string[]> {
  if (!service) return [];
  const rows = await runQuery(Q.operations(service), earliest, 'now', 1000);
  return rows.map((r) => String(r.name)).filter(Boolean);
}

/**
 * 2-stage search:
 *   1. Find root spans matching filters → list of trace IDs.
 *   2. Fetch all spans for those trace IDs → transform to Jaeger shape.
 *
 * Returns both summaries (for the table) and full traces (cached for click-through).
 */
export interface SearchResult {
  summaries: TraceSummary[];
  traces: Map<string, JaegerTrace>;
}

export async function findTraces(
  params: Q.FindTracesParams,
  earliest = '-1h',
  latest = 'now',
): Promise<SearchResult> {
  const rootRows = await runQuery(Q.findTraces(params), earliest, latest, params.limit ?? 20);
  const traceIds = rootRows.map((r) => String(r.trace_id)).filter(Boolean);
  if (traceIds.length === 0) {
    return { summaries: [], traces: new Map() };
  }

  // Fetch all spans for the matching trace IDs in one query.
  // Note: no long-poll filter is applied here. Search is an explicit
  // user query — if they asked for a service/operation, they should
  // see what they asked for, including streams and idle-wait traces.
  // The stream filter only affects aggregate statistics (service
  // percentiles, top operations, dependency edges, slow-trace
  // rankings), not individual trace listings.
  const spanRows = await runQuery(Q.traceSpans(traceIds), earliest, latest, 10000);
  const traces = toJaegerTraces(spanRows);
  const traceMap = new Map<string, JaegerTrace>();
  for (const t of traces) traceMap.set(t.traceID, t);

  // Preserve the root-span order (by recency)
  const summaries: TraceSummary[] = [];
  for (const id of traceIds) {
    const tr = traceMap.get(id);
    if (tr) summaries.push(summarizeTrace(tr));
  }

  return { summaries, traces: traceMap };
}

/** Fetch a single trace's full span list. */
export async function getTrace(
  traceId: string,
  earliest = '-1h',
  latest = 'now',
): Promise<JaegerTrace | null> {
  const rows = await runQuery(Q.traceSpans([traceId]), earliest, latest, 10000);
  const traces = toJaegerTraces(rows);
  return traces[0] ?? null;
}

/**
 * Fetch the full set of dependency edges for the System Architecture
 * graph. Runs two queries in parallel:
 *   1. RPC edges via parent→child span self-join (dependencies()).
 *   2. Messaging edges via OTel messaging.* attributes
 *      (messagingDependencies()), which catch kafka-style async flows
 *      where producer and consumer live in different traces and so
 *      would otherwise be invisible on the graph.
 *
 * Both sets are merged; messaging edges are tagged with kind='messaging'
 * so the graph can render them differently (dashed stroke in the 2D view).
 * If the messaging query returns nothing (no async services) the result
 * is functionally identical to the old RPC-only edge list.
 */
export async function getDependencies(
  earliest = '-1h',
  latest = 'now',
): Promise<DependencyEdge[]> {
  const [rpcRows, msgRows] = await Promise.all([
    runQuery(Q.dependencies(), earliest, latest, 1000),
    runQuery(Q.messagingDependencies(), earliest, latest, 1000).catch(() => []),
  ]);
  return [...toDependencyEdges(rpcRows), ...toMessagingEdges(msgRows)];
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cribl Search returns nested objects either as parsed objects or as
 * JSON-encoded strings depending on how the projection was written.
 * Object.entries() on a string iterates characters, which blows up
 * anything that renders attributes as key/value rows. Normalize to a
 * plain object or empty.
 */
function toObject(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON */
    }
    return {};
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

/**
 * Fetch the per-service rollup. Raw-span aggregation — the
 * spanmetrics-backed path was tried but omitting the long-poll /
 * idle-wait stream filter distorted percentile-of-means latencies
 * (any service with a streaming gRPC endpoint showed 500s+ p95).
 * Raw spans get the stream filter, which is the source of truth
 * for latency percentiles.
 */
export async function listServiceSummaries(
  earliest = '-1h',
  latest = 'now',
  service?: string,
): Promise<ServiceSummary[]> {
  const rows = await runQuery(Q.serviceSummary(service), earliest, latest, 500);
  return rows.map((r) => {
    const requests = toNum(r.requests);
    const errors = toNum(r.errors);
    // last_seen is epoch seconds (Cribl `_time` is seconds). Convert
    // to ms so the rest of the app's Date math is consistent. Skip
    // when the field is missing or zero (cached rows from before
    // this column was added).
    const lastSeenSec = toNum(r.last_seen);
    return {
      service: String(r.svc ?? 'unknown'),
      requests,
      errors,
      errorRate: toNum(r.error_rate),
      p50Us: toNum(r.p50_us),
      p95Us: toNum(r.p95_us),
      p99Us: toNum(r.p99_us),
      lastSeenMs: lastSeenSec > 0 ? lastSeenSec * 1000 : undefined,
    };
  });
}

/**
 * Fetch time-bucketed per-service aggregates.
 */
export async function getServiceTimeSeries(
  binSeconds: number,
  service?: string,
  earliest = '-1h',
  latest = 'now',
): Promise<ServiceBucket[]> {
  const rows = await runQuery(
    Q.serviceTimeSeries(binSeconds, service),
    earliest,
    latest,
    10000,
  );
  return rows.map((r) => ({
    service: String(r.svc ?? 'unknown'),
    // bin(_time, Ns) returns a "bucket" column; the Cribl engine sometimes
    // returns epoch seconds as a number, sometimes as a string. Handle both.
    bucketMs: toNum(r.bucket) * 1000,
    requests: toNum(r.requests),
    errors: toNum(r.errors),
    p50Us: toNum(r.p50_us),
    p95Us: toNum(r.p95_us),
    p99Us: toNum(r.p99_us),
  }));
}

/**
 * Fetch operations for a service, sorted by volume. Raw-span
 * aggregation — see listServiceSummaries() for why spanmetrics
 * isn't used here.
 */
export async function listOperationSummaries(
  service: string,
  earliest = '-1h',
  latest = 'now',
): Promise<OperationSummary[]> {
  const rows = await runQuery(Q.serviceOperations(service), earliest, latest, 100);
  return rows.map((r) => ({
    operation: String(r.name ?? 'unknown'),
    requests: toNum(r.requests),
    errors: toNum(r.errors),
    errorRate: toNum(r.error_rate),
    p50Us: toNum(r.p50_us),
    p95Us: toNum(r.p95_us),
    p99Us: toNum(r.p99_us),
  }));
}

export async function listServiceInstances(
  service: string,
  earliest = '-1h',
  latest = 'now',
): Promise<InstanceSummary[]> {
  const rows = await runQuery(Q.serviceInstances(service), earliest, latest, 100);
  return rows.map((r) => ({
    instanceId: String(r.instance_id ?? 'unknown'),
    requests: toNum(r.requests),
    errors: toNum(r.errors),
    errorRate: toNum(r.error_rate),
    p50Us: toNum(r.p50_us),
    p95Us: toNum(r.p95_us),
    p99Us: toNum(r.p99_us),
  }));
}

/** Brief listings for Home page panels. */
export async function listSlowestTraces(
  service: string | undefined,
  earliest = '-1h',
  latest = 'now',
): Promise<TraceBrief[]> {
  const rows = await runQuery(Q.slowestTraces(service), earliest, latest, 30);
  return rows
    .map((r) => ({
      traceID: String(r.trace_id ?? ''),
      durationUs: toNum(r.trace_dur_us),
      startTime: toNum(r.trace_start_ns) / 1000,
    }))
    .filter((t) => t.traceID);
}

export async function listRecentErrorTraces(
  service: string | undefined,
  earliest = '-1h',
  latest = 'now',
): Promise<TraceBrief[]> {
  const rows = await runQuery(Q.recentErrorTraces(service), earliest, latest, 30);
  return rows
    .map((r) => ({
      traceID: String(r.trace_id ?? ''),
      durationUs: 0,
      startTime: toNum(r.first_seen) * 1_000_000,
      errorCount: toNum(r.error_count),
    }))
    .filter((t) => t.traceID);
}

/**
 * Fetch the raw slowest-trace rows and group them client-side by
 * (root_service, root_operation). Each class collapses N duplicate-looking
 * traces into one row with count, max, p95, p50, and a sorted list of
 * sample trace IDs.
 */
export async function listSlowTraceClasses(
  earliest = '-1h',
  latest = 'now',
  rawLimit = 500,
  topClasses = 20,
): Promise<SlowTraceClass[]> {
  const rows = await runQuery(Q.rawSlowestTraces(rawLimit), earliest, latest, rawLimit);
  return groupSlowTraceClasses(rows, topClasses);
}

/**
 * Pure grouping logic used by both the live `listSlowTraceClasses`
 * verb and the panel-cache partitioner. Expects rows with root_svc,
 * root_op, trace_id, trace_dur_us as produced by
 * `Q.rawSlowestTraces`.
 */
export function groupSlowTraceClasses(
  rows: Record<string, unknown>[],
  topClasses: number = 20,
): SlowTraceClass[] {
  interface Acc {
    rootService: string;
    rootOperation: string;
    durations: number[];
    traceIds: string[];
  }
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    const svc = String(r.root_svc ?? '');
    const op = String(r.root_op ?? '');
    const dur = toNum(r.trace_dur_us);
    const id = String(r.trace_id ?? '');
    if (!svc || !id) continue;
    const key = `${svc}\u0000${op}`;
    let g = groups.get(key);
    if (!g) {
      g = { rootService: svc, rootOperation: op, durations: [], traceIds: [] };
      groups.set(key, g);
    }
    g.durations.push(dur);
    g.traceIds.push(id);
  }
  const classes: SlowTraceClass[] = [];
  for (const g of groups.values()) {
    const paired = g.durations.map((d, i) => ({ d, id: g.traceIds[i] }));
    paired.sort((a, b) => b.d - a.d);
    const durs = paired.map((p) => p.d);
    classes.push({
      rootService: g.rootService,
      rootOperation: g.rootOperation,
      count: durs.length,
      maxDurationUs: durs[0] ?? 0,
      p95DurationUs: percentile(durs, 95),
      p50DurationUs: percentile(durs, 50),
      sampleTraceIDs: paired.map((p) => p.id).slice(0, 5),
    });
  }
  classes.sort((a, b) => b.maxDurationUs - a.maxDurationUs);
  return classes.slice(0, topClasses);
}

/**
 * Fetch raw recent error spans and group them client-side by
 * (service, operation, first-line-of-message). Counts, last seen, and
 * up to 5 sample trace IDs per class.
 */
export async function listErrorClasses(
  earliest = '-1h',
  latest = 'now',
  rawLimit = 300,
  topClasses = 20,
): Promise<ErrorClass[]> {
  const rows = await runQuery(Q.rawRecentErrorSpans(rawLimit), earliest, latest, rawLimit);
  return groupErrorClasses(rows, topClasses);
}

/**
 * Pure grouping logic shared by the live `listErrorClasses` verb
 * and the panel-cache partitioner. Expects rows with svc, name,
 * msg, trace_id, _time as produced by `Q.rawRecentErrorSpans`.
 */
export function groupErrorClasses(
  rows: Record<string, unknown>[],
  topClasses: number = 20,
): ErrorClass[] {
  interface Acc {
    service: string;
    operation: string;
    message: string;
    count: number;
    lastSeenMs: number;
    traceIds: string[];
  }
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    const svc = String(r.svc ?? 'unknown');
    const op = String(r.name ?? 'unknown');
    const rawMsg = String(r.msg ?? '').trim();
    const firstLine = rawMsg.split('\n')[0].trim();
    const msg = firstLine || '(no status message)';
    const t = toNum(r._time) * 1000;
    const id = String(r.trace_id ?? '');
    if (!id) continue;
    const key = `${svc}\u0000${op}\u0000${msg}`;
    let g = groups.get(key);
    if (!g) {
      g = { service: svc, operation: op, message: msg, count: 0, lastSeenMs: 0, traceIds: [] };
      groups.set(key, g);
    }
    g.count += 1;
    if (t > g.lastSeenMs) g.lastSeenMs = t;
    if (g.traceIds.length < 5) g.traceIds.push(id);
  }
  const classes: ErrorClass[] = Array.from(groups.values()).map((g) => ({
    service: g.service,
    operation: g.operation,
    message: g.message,
    count: g.count,
    lastSeenMs: g.lastSeenMs,
    sampleTraceIDs: g.traceIds,
  }));
  classes.sort((a, b) => b.count - a.count || b.lastSeenMs - a.lastSeenMs);
  return classes.slice(0, topClasses);
}

// ─────────────────────────────────────────────────────────────────
// Latency anomaly detection
// ─────────────────────────────────────────────────────────────────

/** Minimum baseline sample count for an op to be considered for
 * anomaly scoring. Lower than the service-level traffic-drop gate
 * because individual ops have lower volume. */
const ANOMALY_MIN_BASELINE_REQUESTS = 20;

/** Minimum ratio of curr p95 / prev p95 to flag as anomalous. 5× is
 * large enough to filter out routine day-vs-day variance and small
 * enough to catch consumer-side delay scenarios that push p95 from
 * ~100ms to ~500ms+. */
const ANOMALY_MIN_RATIO = 5;

/** Absolute p95 floor — a 5× jump from 10ms to 50ms isn't actionable
 * even if it technically qualifies. 1s of latency is the threshold
 * at which a human would consider the operation "slow in absolute
 * terms". */
const ANOMALY_MIN_CURR_P95_US = 1_000_000;

/**
 * Per-op latency anomalies vs the persisted `criblapm_op_baselines`
 * lookup (written by the scheduled op-baseline search provisioned
 * via ROADMAP §2b.1). One server-side query: current-window
 * aggregation, hash-join against the lookup, filter by ratio +
 * absolute threshold + baseline sample count. Returns
 * OperationAnomaly[] ready for the widget.
 *
 * Cache-miss semantics: if the lookup doesn't exist yet (fresh
 * install, scheduled search hasn't run its first cycle) the
 * query returns zero rows. The widget shows its empty state.
 * The `wait for baselines to populate` UX copy is the caller's
 * responsibility.
 *
 * TODO: reason pills — expose per-op error-rate delta, volume
 * delta, and child-attribution delta so the widget can explain
 * *why* an op was flagged instead of showing a bare ratio. See
 * ROADMAP §2b.2 follow-ups.
 */
export async function listOperationAnomalies(
  earliest: string = '-1h',
  latest: string = 'now',
  topN: number = 20,
): Promise<OperationAnomaly[]> {
  const rows = await runQuery(
    Q.operationAnomaliesFromLookup(
      ANOMALY_MIN_RATIO,
      ANOMALY_MIN_CURR_P95_US,
      ANOMALY_MIN_BASELINE_REQUESTS,
      topN,
    ),
    earliest,
    latest,
    topN,
  );
  return rows.map((r) => ({
    service: String(r.svc ?? ''),
    operation: String(r.op ?? ''),
    currP95Us: toNum(r.curr_p95_us),
    prevP95Us: toNum(r.prev_p95_us),
    ratio: toNum(r.ratio),
    requests: toNum(r.requests),
  }));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Standalone log search — Log Explorer tab. Filters at the KQL level for
 * service/severity/body text; returns most-recent-first.
 */
export async function searchLogs(
  params: Q.SearchLogsParams,
  earliest = '-1h',
  latest = 'now',
): Promise<TraceLogEntry[]> {
  const rows = await runQuery(Q.searchLogs(params), earliest, latest, params.limit ?? 200);
  return rows.map((r) => ({
    time: toNum(r._time) * 1000,
    traceID: String(r.trace_id ?? ''),
    spanID: String(r.span_id ?? ''),
    service: String(r.service_name ?? 'unknown'),
    body: String(r.body ?? ''),
    severityText: String(r.severity_text ?? ''),
    severityNumber: toNum(r.severity_number),
    codeFile: r.code_file ? String(r.code_file) : undefined,
    codeFunction: r.code_function ? String(r.code_function) : undefined,
    codeLine: r.code_line != null ? toNum(r.code_line) : undefined,
    attributes: toObject(r.attributes),
  }));
}

/** List distinct services that have emitted logs. */
export async function listLogServices(earliest = '-1h'): Promise<string[]> {
  const rows = await runQuery(Q.logServices(), earliest, 'now', 500);
  return rows.map((r) => String(r.svc)).filter(Boolean);
}

/** Fetch logs correlated to a given trace. */
export async function getTraceLogs(
  traceId: string,
  earliest = '-24h',
  latest = 'now',
): Promise<TraceLogEntry[]> {
  if (!traceId) return [];
  const rows = await runQuery(Q.traceLogs(traceId), earliest, latest, 5000);
  return rows.map((r) => ({
    time: toNum(r._time) * 1000,
    traceID: String(r.trace_id ?? ''),
    spanID: String(r.span_id ?? ''),
    service: String(r.service_name ?? 'unknown'),
    body: String(r.body ?? ''),
    severityText: String(r.severity_text ?? ''),
    severityNumber: toNum(r.severity_number),
    codeFile: r.code_file ? String(r.code_file) : undefined,
    codeFunction: r.code_function ? String(r.code_function) : undefined,
    codeLine: r.code_line != null ? toNum(r.code_line) : undefined,
    attributes: toObject(r.attributes),
  }));
}

// ─────────────────────────────────────────────────────────────────
// Metrics verbs
// ─────────────────────────────────────────────────────────────────

/**
 * Keys on metric records that are never metric values — metadata,
 * infrastructure, or deprecated columns from the old schema.
 */
const METRIC_EXCLUDE_KEYS = new Set([
  '_time', 'source', 'datatype', '_raw', 'dataset',
  '_metric_type', '_datatype_detection', '_metric', '_value',
]);

/**
 * Client-side metric-name discovery from a set of raw wide-column
 * sample records. Each numeric key that isn't in METRIC_EXCLUDE_KEYS
 * is treated as a metric name. Returns MetricSummary[] sorted by
 * sample count descending.
 */
function discoverMetricNames(rows: Record<string, unknown>[]): MetricSummary[] {
  const metrics = new Map<string, { count: number; services: Set<string> }>();
  for (const row of rows) {
    const svc = String(row['service.name'] ?? '');
    for (const [key, val] of Object.entries(row)) {
      if (METRIC_EXCLUDE_KEYS.has(key)) continue;
      if (typeof val !== 'number') continue;
      let entry = metrics.get(key);
      if (!entry) {
        entry = { count: 0, services: new Set() };
        metrics.set(key, entry);
      }
      entry.count++;
      if (svc) entry.services.add(svc);
    }
  }
  return Array.from(metrics.entries())
    .map(([name, { count, services }]) => ({
      name,
      samples: count,
      services: services.size,
    }))
    .sort((a, b) => b.samples - a.samples);
}

// Module-level cache for metric name discovery. Metric names are
// essentially static (they only change if the pipeline changes),
// so we cache the first successful discovery and reuse it for the
// session. A page refresh clears the cache.
let metricNamesCache: MetricSummary[] | null = null;

/**
 * List all metric names. Cached after first call — metric names
 * are static within a session. Uses a small sample (200 records)
 * for fast discovery; most environments have <100 distinct metric
 * names so 200 records covers the catalog with headroom.
 */
export async function listMetrics(
  earliest = '-1h',
  latest = 'now',
): Promise<MetricSummary[]> {
  if (metricNamesCache) return metricNamesCache;
  const rows = await runQuery(Q.metricSampleRecords(500), earliest, latest, 500);
  const result = discoverMetricNames(rows);
  if (result.length > 0) metricNamesCache = result;
  return result;
}

/** Services that emit a given metric in the current window. */
export async function listMetricServices(
  metric: string,
  earliest = '-1h',
  latest = 'now',
): Promise<string[]> {
  if (!metric) return [];
  const rows = await runQuery(Q.metricServices(metric), earliest, latest, 500);
  return rows.map((r) => String(r.svc)).filter(Boolean);
}

const svcMetricCache = new Map<string, string[]>();

export async function listServiceMetricNames(
  service: string,
  earliest = '-1h',
  latest = 'now',
): Promise<string[]> {
  if (!service) return [];
  const cached = svcMetricCache.get(service);
  if (cached) return cached;
  const rows = await runQuery(
    Q.serviceMetricSampleRecords(service, 200),
    earliest,
    latest,
    200,
  );
  const names = discoverMetricNames(rows).map((m) => m.name);
  if (names.length > 0) svcMetricCache.set(service, names);
  return names;
}

/**
 * Latest scalar value for a metric scoped to a service. Returns
 * undefined if the metric has no samples in the window. Used by
 * the Service Detail cards for "current memory usage", "ready
 * state", etc.
 */
export async function getServiceMetricLatest(
  service: string,
  metric: string,
  earliest = '-1h',
  latest = 'now',
): Promise<number | undefined> {
  if (!service || !metric) return undefined;
  const rows = await runQuery(
    Q.serviceMetricLatest(service, metric),
    earliest,
    latest,
    1,
  );
  if (rows.length === 0) return undefined;
  const v = toNum(rows[0].val);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Cumulative-counter delta for a service over the window. Used
 * by the Infrastructure card's restart counter display — "how many
 * restarts in the last hour" is the actionable number, not the
 * lifetime count.
 */
export async function getServiceMetricDelta(
  service: string,
  metric: string,
  earliest = '-1h',
  latest = 'now',
): Promise<number> {
  if (!service || !metric) return 0;
  const rows = await runQuery(
    Q.serviceMetricDelta(service, metric),
    earliest,
    latest,
    1,
  );
  if (rows.length === 0) return 0;
  const v = toNum(rows[0].delta);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Single-query batch fetch of per-service sparklines for many
 * metrics at once. Returns a Map keyed by metric name with sorted
 * (t, v) series. In the wide-column schema the query returns raw
 * rows where each metric is a separate numeric field; this function
 * unpivots them client-side into per-metric (bucket, value) arrays.
 */
export async function getServiceMetricsBatch(
  service: string,
  metrics: string[],
  binSeconds: number,
  earliest = '-1h',
  latest = 'now',
): Promise<Map<string, Array<{ t: number; v: number }>>> {
  const out = new Map<string, Array<{ t: number; v: number }>>();
  if (!service || metrics.length === 0) return out;
  const rows = await runQuery(
    Q.serviceMetricsBatch(service, metrics, binSeconds),
    earliest,
    latest,
    10000,
  );
  const metricSet = new Set(metrics);
  for (const row of rows) {
    const bucket = toNum(row.bucket) * 1000;
    for (const [key, val] of Object.entries(row)) {
      if (!metricSet.has(key)) continue;
      if (typeof val !== 'number') continue;
      let arr = out.get(key);
      if (!arr) { arr = []; out.set(key, arr); }
      arr.push({ t: bucket, v: val });
    }
  }
  for (const arr of out.values()) arr.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Time-series for a service metric — drives sparklines in the
 * Service Detail cards. Default agg is p95 which makes sense for
 * the histogram metrics (http/rpc/db/jvm-gc durations) most of
 * these cards show; callers can override for gauges where max or
 * avg is more meaningful.
 */
export async function getServiceMetricSeries(
  service: string,
  metric: string,
  binSeconds: number,
  agg: 'avg' | 'max' | 'p95' = 'p95',
  earliest = '-1h',
  latest = 'now',
): Promise<Array<{ t: number; v: number }>> {
  if (!service || !metric) return [];
  const rows = await runQuery(
    Q.serviceMetricTimeSeries(service, metric, binSeconds, agg),
    earliest,
    latest,
    1000,
  );
  return rows
    .map((r) => ({ t: toNum(r.bucket) * 1000, v: toNum(r.val) }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Fetch a time-bucketed metric series. Handles both single-series
 * and group-by modes; in the single-series case the result has one
 * group with key="". The `rate` aggregation transforms the server's
 * `max(_value)` per bucket into per-bucket deltas client-side so
 * counters render as a human-readable rate instead of a climbing
 * cumulative line.
 */
export async function getMetricSeries(
  params: Q.MetricSeriesParams,
  earliest = '-1h',
  latest = 'now',
): Promise<MetricSeries> {
  const rows = await runQuery(Q.metricTimeSeries(params), earliest, latest, 5000);

  // Partition rows into groups by the group-by key (empty string when
  // no group-by is set, so the single-series case stays uniform).
  const byKey = new Map<string, Array<{ t: number; v: number }>>();
  for (const r of rows) {
    const key = params.groupBy ? String(r.grp ?? '') : '';
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({
      t: toNum(r.bucket) * 1000,
      v: toNum(r.val),
    });
  }

  // Sort each series by time, then optionally rate-derive.
  const groups: MetricSeriesGroup[] = [];
  for (const [key, points] of byKey) {
    points.sort((a, b) => a.t - b.t);
    const derived =
      params.agg === 'rate'
        ? deriveRate(points, params.binSeconds)
        : points;
    groups.push({ key, points: derived });
  }

  return {
    metric: params.metric,
    agg: params.agg,
    groupBy: params.groupBy,
    groups,
  };
}

/**
 * Convert a monotonic cumulative counter series into a per-second
 * rate series. For each point after the first, rate = Δvalue / Δt.
 * Counter resets (value decreased) are treated as a reset from zero
 * — the delta is then just the new cumulative value, divided by the
 * elapsed bucket time. Negative rates are clamped to zero.
 *
 * The first sample has no prior point to diff against and is dropped.
 * `binSeconds` is used only when Δt can't be computed from the
 * points themselves (it shouldn't happen with well-formed data).
 */
function deriveRate(
  points: Array<{ t: number; v: number }>,
  binSeconds: number,
): Array<{ t: number; v: number }> {
  if (points.length < 2) return [];
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const dtSec = Math.max(1, (cur.t - prev.t) / 1000 || binSeconds);
    let delta = cur.v - prev.v;
    if (delta < 0) {
      // Counter reset — assume restart from zero, so the delta this
      // bucket is just the current cumulative value.
      delta = cur.v;
    }
    const rate = delta / dtSec;
    out.push({ t: cur.t, v: rate < 0 ? 0 : rate });
  }
  return out;
}

/**
 * Sniff a metric's type and candidate group-by dimensions by looking
 * at a single sample record. Cached by the caller — each metric
 * should only be sniffed once per session.
 *
 * Detection: the wide-column schema stores `_metric_type` ("counter",
 * "gauge", "histogram") directly on the record — no need to inspect
 * `_otel`/`_data` sub-objects.
 *
 * Dimensions are every top-level key that looks attribute-like:
 * contains a `.` (matches OTel semconv like `service.name`,
 * `rpc.method`) and is a string value — numeric keys are metric
 * values themselves, not dimensions.
 */
export async function getMetricInfo(
  metric: string,
  earliest = '-1h',
  latest = 'now',
): Promise<MetricInfo> {
  const empty: MetricInfo = { name: metric, type: 'unknown', dimensions: [] };
  if (!metric) return empty;
  const rows = await runQuery(Q.metricSampleRow(metric), earliest, latest, 1);
  if (rows.length === 0) return empty;

  const row = rows[0] as Record<string, unknown>;

  // Detect type from the wide-column _metric_type field.
  const metricType = String(row._metric_type ?? 'unknown');
  let type: MetricType = 'unknown';
  if (metricType === 'counter') type = 'counter';
  else if (metricType === 'gauge') type = 'gauge';
  else if (metricType === 'histogram') type = 'histogram';

  // Discover dimensions from row keys — string-valued dotted keys
  // are resource/scope attributes (e.g. "service.name", "rpc.method").
  const dimensions: string[] = [];
  for (const key of Object.keys(row)) {
    if (METRIC_EXCLUDE_KEYS.has(key)) continue;
    if (typeof row[key] === 'number') continue; // metric value itself
    if (key.includes('.') && typeof row[key] === 'string') {
      dimensions.push(key);
    }
  }

  dimensions.sort();
  return { name: metric, type, dimensions };
}
