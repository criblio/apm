/** Jaeger-compatible data shapes used throughout the app. */

export interface JaegerTag {
  key: string;
  type: string;
  value: string | number | boolean;
}

export interface JaegerReference {
  refType: 'CHILD_OF' | 'FOLLOWS_FROM';
  traceID: string;
  spanID: string;
}

export interface JaegerLogEntry {
  timestamp: number; // microseconds
  fields: JaegerTag[];
}

export interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references: JaegerReference[];
  startTime: number; // microseconds since epoch
  duration: number; // microseconds
  tags: JaegerTag[];
  logs: JaegerLogEntry[];
  processID: string;
  warnings: string[] | null;
}

export interface JaegerProcess {
  serviceName: string;
  tags: JaegerTag[];
}

export interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, JaegerProcess>;
  warnings: string[] | null;
}

/** Summary for the search results table (one row per trace). */
export interface TraceSummary {
  traceID: string;
  rootService: string;
  rootOperation: string;
  startTime: number; // μs
  duration: number; // μs
  spanCount: number;
  errorCount: number;
  services: string[];
}

/**
 * Dependency edge for the System Architecture graph.
 *
 * Two kinds exist:
 *  - `rpc` (default): edges derived from parent→child span relationships,
 *    i.e. gRPC / HTTP call chains where the callee span is a child of
 *    the caller's span.
 *  - `messaging`: edges derived from producer/consumer pairs via the
 *    OTel `messaging.*` attributes. The producer and consumer typically
 *    live in different traces so they wouldn't otherwise appear on the
 *    graph; the messaging lens queries them separately and reconstructs
 *    the edge.
 *
 * Metrics are attributed differently per kind:
 *  - `rpc`: p95 is the child span's latency (how long the callee took
 *    to respond).
 *  - `messaging`: p95 is the **consumer's** span duration (how long
 *    the receiver took to process), which is where kafka lag shows up.
 */
export interface DependencyEdge {
  parent: string;
  child: string;
  callCount: number;
  errorCount: number;
  /** p95 latency of the relevant span on this edge, microseconds. */
  p95DurUs: number;
  /** How this edge was discovered. Defaults to 'rpc' if missing. */
  kind?: 'rpc' | 'messaging';
  /** Topic / queue name for messaging edges only. */
  topic?: string;
}

/** Per-service rollup for the Home page catalog + Service detail header. */
export interface ServiceSummary {
  service: string;
  requests: number;
  errors: number;
  errorRate: number; // 0..1
  p50Us: number;
  p95Us: number;
  p99Us: number;
  /** Epoch ms of the most-recent span we saw for this service in the
   *  current window. Drives the "last seen Ns ago" stale-row pill on
   *  the Home catalog: when a service has been silent for more than
   *  ~25% of the lookback window the row is showing residue rather
   *  than live data, and the user needs to know. Optional so existing
   *  callers (cached panel reads, scheduled-search consumers) keep
   *  working without immediate schema updates. */
  lastSeenMs?: number;
}

/** One time bucket of per-service aggregates; drives sparklines + RED charts. */
export interface ServiceBucket {
  service: string;
  bucketMs: number; // epoch ms at bucket start
  requests: number;
  errors: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
}

/**
 * HTTP status classes used by the Service Detail status-mix chart.
 * The set covers the 5xx subtypes whose semantics differ for
 * diagnosis (503 = capacity / no healthy upstream, 504 = upstream
 * timeout, 500 = upstream bug, 502 = bad gateway, other_5xx = the
 * uncommon rest), 4xx as a single class, and a grpc_err catch-all
 * for non-HTTP failures.
 */
export type StatusCodeClass =
  | 'ok'
  | '503'
  | '504'
  | '502'
  | '500'
  | 'other_5xx'
  | '4xx'
  | 'grpc_err';

/**
 * Order is stack order (bottom-to-top in the stacked column chart):
 * `ok` is the baseline so error classes stack visibly on top with
 * the total height showing absolute request volume.
 */
export const STATUS_CODE_CLASSES: readonly StatusCodeClass[] = [
  'ok',
  '4xx',
  '500',
  '502',
  '503',
  '504',
  'other_5xx',
  'grpc_err',
] as const;

/** One time bucket of per-(status-class) error counts for one service. */
export interface StatusCodeMixBucket {
  bucketMs: number; // epoch ms at bucket start
  statusClass: StatusCodeClass;
  count: number;
}

/**
 * Per-attribute facet bucket — one row per (attr_name, attr_value)
 * within the user's current Search filter. Used by the facet
 * panel ("of the spans matching this filter, what are the top
 * values of <attr_name>?") and as the SELECTION half of a
 * Spotlight comparison.
 */
export interface AttrValueBucket {
  attrName: string;
  attrValue: string;
  /** Number of spans matching the predicate with this value. */
  n: number;
}

/**
 * Per-attribute differential bucket — one row per (attr_name,
 * attr_value) showing both selection count (sel) and baseline
 * count (base). The UI computes the diff client-side as
 * (sel/sel_total) - (base/base_total) and ranks attributes by
 * max(|diff|) over their values. Powers the Spotlight panel,
 * which surfaces "which attribute values are over-represented
 * in your selection vs the rest of the data."
 */
export interface SpotlightBucket {
  attrName: string;
  attrValue: string;
  /** Spans matching this value AND in the user's selection. */
  selN: number;
  /** Spans matching this value but NOT in the selection
   *  (the baseline — the rest of the time window). */
  baseN: number;
}

/** Per-operation rollup inside a service. */
export interface OperationSummary {
  operation: string;
  requests: number;
  errors: number;
  errorRate: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
}

export interface InstanceSummary {
  instanceId: string;
  requests: number;
  errors: number;
  errorRate: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
}

/** Short summary of a trace for "slow traces" / "error traces" panels. */
export interface TraceBrief {
  traceID: string;
  durationUs: number;
  startTime: number; // μs
  errorCount?: number;
}

/** A class of slow traces: all traces sharing a (service, operation) root. */
export interface SlowTraceClass {
  rootService: string;
  rootOperation: string;
  count: number;
  maxDurationUs: number;
  p95DurationUs: number;
  p50DurationUs: number;
  /** Trace IDs in this class, sorted by duration desc. First is the slowest. */
  sampleTraceIDs: string[];
}

/**
 * A per-operation latency anomaly — an operation whose current-window
 * p95 is significantly higher than its immediately-prior window. Used
 * to surface signals the absolute-duration "Slowest trace classes"
 * widget misses: e.g., a consumer operation that normally runs in
 * ~100ms now runs at 18s because of consumer-side delay injected by
 * the kafka-queue-problems scenario.
 *
 * TODO: attach a list of "reasons" explaining why this was flagged —
 * ratio vs baseline, absolute p95, volume jump, etc. — so the widget
 * can show reason pills ("×90 baseline", "5s+ absolute"). Plumbing is
 * in types/search/queries; the component just needs the extra fields.
 */
export interface OperationAnomaly {
  service: string;
  operation: string;
  /** Current-window p95 duration in microseconds. */
  currP95Us: number;
  /** Prior-window p95 duration in microseconds — the baseline. */
  prevP95Us: number;
  /** currP95Us / prevP95Us — how many times worse than baseline. */
  ratio: number;
  /** Current-window request count for this op. */
  requests: number;
}

/** A class of errors: (service, operation, first-line-of-message). */
export interface ErrorClass {
  service: string;
  operation: string;
  message: string;
  count: number;
  lastSeenMs: number;
  /** Trace IDs that contained this error, most-recent first. */
  sampleTraceIDs: string[];
}

/** A correlated log entry — trace_id + span_id matching the trace. */
export interface TraceLogEntry {
  time: number; // ms
  traceID: string;
  spanID: string;
  service: string;
  body: string;
  severityText: string;
  severityNumber: number;
  codeFile?: string;
  codeFunction?: string;
  codeLine?: number;
  attributes: Record<string, unknown>;
}

/**
 * One metric name entry from the Metrics explorer picker. `samples`
 * is the raw record count in the current window — bigger = more
 * frequently-reported metric. `services` is the number of distinct
 * services emitting it, useful for ranking "everywhere" metrics like
 * system.cpu.time above service-specific ones.
 */
export interface MetricSummary {
  name: string;
  samples: number;
  services: number;
  type?: MetricType;
}

/** A single point on a metric time series. Ms since epoch, numeric value. */
export interface MetricPoint {
  t: number;
  v: number;
}

/**
 * Aggregation operators supported by the metrics explorer. Maps
 * roughly to KQL functions:
 *   avg/sum/min/max/count → standard aggregations on _value
 *   p50/p75/p95/p99        → percentile(_value, N)
 *   rate                   → max(_value) per bucket, client-side Δ/Δt
 *                            (use for monotonic counters)
 */
export type MetricAgg =
  | 'avg'
  | 'sum'
  | 'min'
  | 'max'
  | 'count'
  | 'p50'
  | 'p75'
  | 'p95'
  | 'p99'
  | 'rate';

/**
 * Detected metric "shape". Counter = monotonically increasing
 * cumulative value (needs rate derivation to be human-readable);
 * histogram = has a cumulative bucket map in `${name}_data._buckets`
 * (true percentiles possible); gauge = plain sampled value. `unknown`
 * is the fallback when no sample is available or the fields don't
 * match any pattern.
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'unknown';

/**
 * Result of `getMetricInfo(name)`. Type is detected by sniffing a
 * sample record. `dimensions` is the list of attribute-like keys
 * found on the sample — candidates for the group-by picker.
 */
export interface MetricInfo {
  name: string;
  type: MetricType;
  /** Candidate group-by dimensions (e.g. "service.name", "rpc.method"). */
  dimensions: string[];
  /** Explicit unit if the sample carried one, else undefined. */
  unit?: string;
}

/**
 * One series within a MetricSeries result. `key` identifies the
 * group-by dimension value for this series (empty string when no
 * group-by is in effect, so the single ungrouped case still fits
 * the same shape).
 */
export interface MetricSeriesGroup {
  key: string;
  points: MetricPoint[];
}

/**
 * Result of `getMetricSeries` — may be multi-series when group-by
 * is set. Top-N limiting is applied client-side on the caller's
 * side; `groups` carries exactly what should be rendered.
 */
export interface MetricSeries {
  metric: string;
  agg: MetricAgg;
  groupBy?: string;
  groups: MetricSeriesGroup[];
}

/** A single detected issue surfaced on the Home page alerts panel.
 *  Derived from health-bucket computation + dependency edges. */
export interface DetectedIssue {
  service: string;
  signalType:
    | 'error_rate_critical'
    | 'error_rate_warn'
    | 'traffic_drop'
    | 'latency_anomaly'
    | 'silent';
  severity: 'critical' | 'warn';
  detail: string;
  operation?: string;
  rootCauseHint?: string;
  /** Alert state from the server-side state machine. Present when
   *  reading from the cached alert rows. */
  alertStatus?: 'ok' | 'pending' | 'firing' | 'resolving';
  /** True when this is a persistent issue (similar error rate in
   *  prev window) vs a new/worsening one. Used to render a
   *  "Persistent" badge so users can distinguish ongoing problems
   *  from fresh incidents. Does NOT hide the issue. */
  isPersistent?: boolean;
}

/** One service's membership in an incident, as read from the incident
 *  state fold (one $vt_results row per (incident, service)). */
export interface IncidentMember {
  service: string;
  /** Epoch ms of this service's first firing transition in the incident. */
  firstSeenMs: number;
  /** Epoch ms of this service's latest firing transition. */
  lastFireMs: number;
  fireCount: number;
}

/** An incident — the warroom record above alerts/investigations
 *  (P4.4). Assembled client-side by grouping the state fold's
 *  per-(incident, service) rows on incidentId. */
export interface IncidentSummary {
  incidentId: string;
  title: string;
  status: 'open' | 'investigating' | 'identified' | 'mitigated' | 'resolved' | 'closed';
  severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
  /** Members sorted by firstSeenMs — the first entry is the derived
   *  root (first-firing service). */
  services: IncidentMember[];
  /** First-firing service (graph-aware root lands with P4.4 Phase 4). */
  rootService: string;
  openedAtMs: number;
  lastFireMs: number;
}

/** One row of an incident's append-only timeline (warroom log). */
export interface IncidentTimelineEntry {
  timeMs: number;
  eventId: string;
  eventType: string;
  incidentId: string;
  author: 'agent' | 'human' | 'system';
  status?: string;
  severity?: string;
  rootService?: string;
  services?: string;
  note?: string;
  investigationId?: string;
  alertEventId?: string;
  title?: string;
  producer: string;
}

/** OTel span kind numeric values. */
export const SpanKind: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'INTERNAL',
  2: 'SERVER',
  3: 'CLIENT',
  4: 'PRODUCER',
  5: 'CONSUMER',
};

/** OTel status code values. */
export const StatusCode: Record<string, string> = {
  '0': 'UNSET',
  '1': 'OK',
  '2': 'ERROR',
};
