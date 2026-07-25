/**
 * Names + read queries for the APM-emitted metrics in the fast Cribl
 * PromQL store. Dependency-free on purpose: imported by both the Node
 * provisioner (`provisionedSearches.ts` → emitter KQL) and browser read
 * code (`metricsPanels.ts`), so it must not pull the framework fetch
 * client or any `node:*` module.
 *
 * These are the span-derived RED metrics that replace the `$vt_results`
 * RED panel caches. See `docs/metrics-migration-plan.md`. All names use
 * the `criblapm_` prefix and underscores (PromQL identifiers can't
 * contain dots).
 *
 * ── Emit/read semantics (validated live 2026-07-23) ──────────────────
 *  - Counters are **delta** metrics: each point is the count for that
 *    1-minute bin (the store keeps emitted values verbatim, it does NOT
 *    accumulate). Read totals with `sum_over_time`, NOT `rate()` /
 *    `increase()`. Latency histograms read via `histogram_quantile`, and
 *    there `rate()` IS correct (the standard per-bucket idiom).
 *  - Every RED metric carries an `outcome` ∈ {ok,error} label on the
 *    counter so error-rate is `{outcome="error"} / all` at read time.
 */

// ── Metric names ─────────────────────────────────────────────────────
/** Request counter. Labels: svc, operation, outcome∈{ok,error}. Serves
 *  the service summary (sum by svc), time series (range query by svc),
 *  and Top Operations (by svc, operation). */
export const METRIC_REQUESTS_TOTAL = 'criblapm_requests_total';
/** Latency histogram. Labels: svc, operation. */
export const METRIC_REQUEST_DURATION_MS = 'criblapm_request_duration_ms';
/** Service→service RPC edge call counter. Labels: parent, child, outcome. */
export const METRIC_EDGE_CALLS_TOTAL = 'criblapm_edge_calls_total';
/** Edge latency histogram (child span duration). Labels: parent, child. */
export const METRIC_EDGE_DURATION_MS = 'criblapm_edge_duration_ms';
/** Messaging edge counter. Labels: svc, dest, op, system, outcome. */
export const METRIC_MESSAGING_TOTAL = 'criblapm_messaging_total';
/** Messaging latency histogram. Labels: svc, dest, op, system. */
export const METRIC_MESSAGING_DURATION_MS = 'criblapm_messaging_duration_ms';
/** HTTP/gRPC status-class counter for the Service Detail Status mix chart.
 *  Labels: svc, status_class ∈ {ok,4xx,500,502,503,504,other_5xx,grpc_err}. */
export const METRIC_STATUS_CLASS_TOTAL = 'criblapm_status_class_total';

/**
 * PRECOMPUTED latency-percentile GAUGES. A scheduled search computes
 * `percentile(dur_ms, q)` per (svc[, operation]) per minute and emits it as
 * a gauge labelled by `quantile ∈ {p50,p95,p99}`. These REPLACE the
 * `histogram_quantile` reads over `criblapm_request_duration_ms`, which were
 * both slow (~0.8s each, fixed cost) AND WRONG for bimodal distributions —
 * the auto-bucketed histogram collapsed frontend's slow tail (reported p95
 * ≈ 20ms when the true p95 is ~3s). A gauge read is ~114ms and returns the
 * exact percentile. `_us` at read time (values stored in ms). */
export const METRIC_REQUEST_LATENCY_MS = 'criblapm_request_latency_ms';
/** Per-operation latency-percentile gauge. Labels: svc, operation, quantile. */
export const METRIC_OP_LATENCY_MS = 'criblapm_op_latency_ms';
/** Edge latency-percentile gauge. Labels: parent, child, quantile. */
export const METRIC_EDGE_LATENCY_MS = 'criblapm_edge_latency_ms';
/** Messaging latency-percentile gauge. Labels: svc, dest, op, system, quantile. */
export const METRIC_MSG_LATENCY_MS = 'criblapm_msg_latency_ms';

/** The fixed percentiles we precompute + read as gauges. */
export const LATENCY_QUANTILES = [
  { q: 50, label: 'p50' },
  { q: 95, label: 'p95' },
  { q: 99, label: 'p99' },
] as const;

/** Default PromQL lookback for an instant "value over the window" read. */
export const DEFAULT_METRIC_WINDOW = '5m';

/**
 * PromQL that returns samples where a metric HAS data — used by the backfill
 * coverage probe. Must be metric-type-aware: on this engine a histogram's
 * data is ONLY reachable through `histogram_quantile(... by (le))` (bare
 * `count()`/`sum()` over a histogram name return nothing), while counters
 * use `count()`. The 5m rate window is needed so `rate()` sees ≥2 of the
 * once-per-minute samples (same reason the RED duration read floors its
 * window at 5m). Run as a coarse-step RANGE query; the earliest step with a
 * sample is the earliest covered time.
 */
export function coverageProbeQuery(metricName: string, kind: 'counter' | 'histogram'): string {
  if (kind === 'histogram') {
    return `histogram_quantile(0.5, sum(rate(${metricName}[5m])) by (le))`;
  }
  return `count(${metricName})`;
}

/** `-1h` / `1h` → `1h`; unrecognized → default. PromQL range-vectors need
 *  a bare duration, not a relative time. */
export function toPromWindow(range: string, fallback = DEFAULT_METRIC_WINDOW): string {
  const m = /^-?(\d+[smhd])$/.exec(range.trim());
  return m ? m[1] : fallback;
}

const UNIT_SEC: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
function relToSecAgo(e: string): number {
  if (!e || e === 'now') return 0;
  const m = /^-?(\d+)([smhd])$/.exec(e.trim());
  return m ? Number(m[1]) * UNIT_SEC[m[2]] : 0;
}

/**
 * PromQL range-vector duration covering `[earliest, latest]`, for reads
 * over an arbitrary window (e.g. the prior comparison window -2h..-1h,
 * not just -1h..now). Instant-querying with this window at `latest` sums
 * exactly `[earliest, latest]`. Handles the relative expressions the app
 * uses (`-1h` / `-15m` / `-2h` / `now`).
 */
export function promWindow(earliest: string, latest = 'now'): string {
  const span = Math.abs(relToSecAgo(earliest) - relToSecAgo(latest));
  return span > 0 ? `${span}s` : DEFAULT_METRIC_WINDOW;
}

function w(range?: string): string {
  return range ? toPromWindow(range) : DEFAULT_METRIC_WINDOW;
}

// ── Service-level reads (aggregate over operation) ───────────────────
// `histogram_quantile` costs ~700-800ms each on this engine, and counter
// reads ~114ms — so the readers fetch requests+errors in ONE query (split
// by the `outcome` label client-side) and keep histogram calls to a
// minimum. See metricsPanels.ts.

/** Requests AND errors in one query: series keyed by (svc, outcome). Pass
 *  `svc` to scope to one service in-query (`{svc="X"} by (outcome)`). */
export function promServiceReqErr(range?: string, svc?: string): string {
  const by = svc ? '(outcome)' : '(svc, outcome)';
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}${svcSel(svc)}[${w(range)}])) by ${by}`;
}
export function promServiceRequests(range?: string): string {
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}[${w(range)}])) by (svc)`;
}
export function promServiceErrors(range?: string): string {
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}{outcome="error"}[${w(range)}])) by (svc)`;
}
/** Escape a PromQL label-matcher value (backslash + double-quote). */
function promLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
/** `{svc="frontend"}` selector, or '' for all services. When set, the
 *  caller should also drop `svc` from the `by (...)` grouping. */
function svcSel(svc?: string): string {
  return svc ? `{svc="${promLabelValue(svc)}"}` : '';
}

/** Service latency quantile. Pass `svc` to compute only that service's
 *  histogram in-query (`{svc="X"} by (le)`) instead of all services then
 *  filtering client-side — far less work for the metrics engine on the
 *  single-service Service Detail page.
 *  DEPRECATED for reads — see promServiceLatencyGauge (fast + accurate). */
export function promServiceLatencyQuantile(q: number, range?: string, svc?: string): string {
  const by = svc ? '(le)' : '(le, svc)';
  return `histogram_quantile(${clampQ(q)}, sum(rate(${METRIC_REQUEST_DURATION_MS}${svcSel(svc)}[${w(range)}])) by ${by})`;
}

const QLABEL: Record<number, string> = { 50: 'p50', 95: 'p95', 99: 'p99' };

/**
 * Read a precomputed service latency percentile GAUGE (ms). `avg_over_time`
 * collapses the per-minute gauge to one representative value over the window
 * (percentiles don't average exactly, but the mean of per-minute p95 is a
 * fair "typical p95" and matches the chart). Pass `svc` to scope; otherwise
 * grouped by svc. ~114ms and correct — unlike histogram_quantile over the
 * auto-bucketed histogram, which collapsed bimodal tails. */
export function promServiceLatencyGauge(q: number, range?: string, svc?: string): string {
  const sel = svc ? `{svc="${promLabelValue(svc)}",quantile="${QLABEL[q]}"}` : `{quantile="${QLABEL[q]}"}`;
  const by = svc ? '()' : '(svc)';
  return `avg(avg_over_time(${METRIC_REQUEST_LATENCY_MS}${sel}[${w(range)}])) by ${by}`;
}
/** Per-bucket service latency gauge series (Duration chart). `bucket` should
 *  be ≥ the 1-min gauge interval so each step catches a value. */
export function promServiceLatencyGaugeSeries(q: number, bucket: string, svc?: string): string {
  const sel = svc ? `{svc="${promLabelValue(svc)}",quantile="${QLABEL[q]}"}` : `{quantile="${QLABEL[q]}"}`;
  const by = svc ? '()' : '(svc)';
  return `avg(avg_over_time(${METRIC_REQUEST_LATENCY_MS}${sel}[${bucket}])) by ${by}`;
}
/** Per-operation latency percentile gauge (ms), scoped to a service. */
export function promOpLatencyGauge(q: number, range?: string, svc?: string): string {
  const sel = svc ? `{svc="${promLabelValue(svc)}",quantile="${QLABEL[q]}"}` : `{quantile="${QLABEL[q]}"}`;
  const by = svc ? '(operation)' : '(svc, operation)';
  return `avg(avg_over_time(${METRIC_OP_LATENCY_MS}${sel}[${w(range)}])) by ${by}`;
}
/** Edge (parent→child) latency percentile gauge (ms). */
export function promEdgeLatencyGauge(q: number, range?: string): string {
  return `avg(avg_over_time(${METRIC_EDGE_LATENCY_MS}{quantile="${QLABEL[q]}"}[${w(range)}])) by (parent, child)`;
}
/** Messaging edge latency percentile gauge (ms). */
export function promMessagingLatencyGauge(q: number, range?: string): string {
  return `avg(avg_over_time(${METRIC_MSG_LATENCY_MS}{quantile="${QLABEL[q]}"}[${w(range)}])) by (svc, dest, op, system)`;
}

// ── Per-(svc, operation) reads — Top Operations table ────────────────
/** Requests AND errors per (svc, operation, outcome) in one query. */
export function promOpReqErr(range?: string, svc?: string): string {
  const by = svc ? '(operation, outcome)' : '(svc, operation, outcome)';
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}${svcSel(svc)}[${w(range)}])) by ${by}`;
}
export function promOpRequests(range?: string): string {
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}[${w(range)}])) by (svc, operation)`;
}
export function promOpErrors(range?: string): string {
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}{outcome="error"}[${w(range)}])) by (svc, operation)`;
}
/** Op latency quantile. Pass `svc` to scope to one service in-query
 *  (`{svc="X"} by (le, operation)`) — the biggest cardinality win, since
 *  the unscoped `by (le, svc, operation)` fans out over every service. */
export function promOpLatencyQuantile(q: number, range?: string, svc?: string): string {
  const by = svc ? '(le, operation)' : '(le, svc, operation)';
  return `histogram_quantile(${clampQ(q)}, sum(rate(${METRIC_REQUEST_DURATION_MS}${svcSel(svc)}[${w(range)}])) by ${by})`;
}

// ── Time-series reads (range query; `step` is the bucket width) ──────
/** Requests AND errors per (svc, outcome) per bucket, in one range query.
 *  Pass `svc` to scope to one service in-query (`{svc="X"} by (outcome)`). */
export function promServiceReqErrSeries(bucket: string, svc?: string): string {
  const by = svc ? '(outcome)' : '(svc, outcome)';
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}${svcSel(svc)}[${bucket}])) by ${by}`;
}
/** Per-svc request count per bucket. `bucket` is a bare PromQL duration
 *  (e.g. "60s") matching the range-query step. */
export function promServiceRequestsSeries(bucket: string): string {
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}[${bucket}])) by (svc)`;
}
export function promServiceErrorsSeries(bucket: string): string {
  return `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}{outcome="error"}[${bucket}])) by (svc)`;
}
export function promServiceLatencyQuantileSeries(q: number, bucket: string, svc?: string): string {
  const by = svc ? '(le)' : '(le, svc)';
  return `histogram_quantile(${clampQ(q)}, sum(rate(${METRIC_REQUEST_DURATION_MS}${svcSel(svc)}[${bucket}])) by ${by})`;
}
/** HTTP/gRPC status-class counts per (svc, status_class) per bucket, for the
 *  Service Detail Status mix chart. Delta counter → read with sum_over_time.
 *  Fetches all services (grouped by svc); the reader filters client-side. */
export function promStatusClassSeries(bucket: string): string {
  return `sum(sum_over_time(${METRIC_STATUS_CLASS_TOTAL}[${bucket}])) by (svc, status_class)`;
}

// ── Dependency edge reads — System Architecture ──────────────────────
/** Edge calls AND errors per (parent, child, outcome) in one query. */
export function promEdgeReqErr(range?: string): string {
  return `sum(sum_over_time(${METRIC_EDGE_CALLS_TOTAL}[${w(range)}])) by (parent, child, outcome)`;
}
export function promEdgeCalls(range?: string): string {
  return `sum(sum_over_time(${METRIC_EDGE_CALLS_TOTAL}[${w(range)}])) by (parent, child)`;
}
export function promEdgeErrors(range?: string): string {
  return `sum(sum_over_time(${METRIC_EDGE_CALLS_TOTAL}{outcome="error"}[${w(range)}])) by (parent, child)`;
}
export function promEdgeLatencyQuantile(q: number, range?: string): string {
  return `histogram_quantile(${clampQ(q)}, sum(rate(${METRIC_EDGE_DURATION_MS}[${w(range)}])) by (le, parent, child))`;
}

// ── Messaging edge reads ─────────────────────────────────────────────
export function promMessagingCalls(range?: string): string {
  return `sum(sum_over_time(${METRIC_MESSAGING_TOTAL}[${w(range)}])) by (svc, dest, op, system)`;
}
export function promMessagingErrors(range?: string): string {
  return `sum(sum_over_time(${METRIC_MESSAGING_TOTAL}{outcome="error"}[${w(range)}])) by (svc, dest, op, system)`;
}
export function promMessagingLatencyQuantile(q: number, range?: string): string {
  return `histogram_quantile(${clampQ(q)}, sum(rate(${METRIC_MESSAGING_DURATION_MS}[${w(range)}])) by (le, svc, dest, op, system))`;
}

function clampQ(q: number): number {
  return Math.min(1, Math.max(0, q));
}
