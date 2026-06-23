/**
 * High-level search operations: combine queries.ts + cribl.ts + transform.ts
 * into the verbs the UI calls.
 */
import { runQuery } from './cribl';
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import { listCachedMetricCatalog } from './panelCache';
import { applyFilterRulesToRaw, DEFAULT_FILTER_RULES } from './errorFilter';
import * as Q from './queries';
import { flatFieldsAvailable } from './featureDetect';
import { toJaegerTraces, summarizeTrace, toDependencyEdges, toMessagingEdges } from './transform';
import type {
  TraceSummary,
  JaegerTrace,
  DependencyEdge,
  ServiceSummary,
  ServiceBucket,
  StatusCodeClass,
  StatusCodeMixBucket,
  AttrValueBucket,
  SpotlightBucket,
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
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.services({ flatFields }), earliest, 'now', 500);
  return rows.map((r) => String(r.svc)).filter(Boolean);
}

export async function listOperations(service: string, earliest = '-1h'): Promise<string[]> {
  if (!service) return [];
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.operations(service, { flatFields }), earliest, 'now', 1000);
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
  const flatFields = await flatFieldsAvailable();
  const rootRows = await runQuery(
    Q.findTraces({ ...params, opts: { flatFields } }),
    earliest,
    latest,
    params.limit ?? 20,
  );
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
  const spanRows = await runQuery(
    Q.traceSpans(traceIds, { flatFields }),
    earliest,
    latest,
    10000,
  );
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
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.traceSpans([traceId], { flatFields }), earliest, latest, 10000);
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
/**
 * Per-attribute value distribution for the facet panel. Fires
 * one query per attribute in parallel — the engine is the same
 * shape used by Spotlight (see getSpotlightDiff below) so they
 * share the same constants and rate limits.
 *
 * Skips attributes the dataset has no rows for. The result map
 * is keyed on attribute name; missing entries mean "no values
 * for this attribute in the matched span set" — the UI renders
 * those as collapsed rows.
 */
/**
 * Cribl Search has a per-cluster concurrent-job ceiling (the
 * `Search queue limit reached (max: 20)` error). Pages like Service
 * Detail already fire ~15 queries of their own, so unconditionally
 * fanning out 22 Spotlight queries blows past the ceiling and the
 * tail return 429s. Run with a small concurrency cap so we coexist
 * with the rest of the page; the streaming UX is unchanged from
 * the user's POV — attrs still appear one by one, just paced.
 */
const SPOTLIGHT_CONCURRENCY = 4;

async function runWithLimit<T>(
  attrs: readonly string[],
  limit: number,
  worker: (attr: string) => Promise<T>,
): Promise<void> {
  let next = 0;
  async function pump(): Promise<void> {
    while (next < attrs.length) {
      const i = next++;
      await worker(attrs[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, attrs.length) }, () => pump()),
  );
}

export async function getFacetDistribution(
  attrs: readonly string[],
  predicateKql: string,
  earliest = '-1h',
  latest = 'now',
  topPerAttr = 20,
  /**
   * Optional per-attribute callback. Called once for each attribute as
   * its query resolves (success or failure → empty list). The UI uses
   * this to stream results into the panel so attributes appear one by
   * one instead of the user staring at "Loading…" until all parallel
   * queries settle.
   */
  onAttr?: (attr: string, rows: AttrValueBucket[]) => void,
): Promise<Map<string, AttrValueBucket[]>> {
  const out = new Map<string, AttrValueBucket[]>();
  await runWithLimit(attrs, SPOTLIGHT_CONCURRENCY, async (attr) => {
    const rows = await runQuery(
      Q.attrValueDistribution(attr, predicateKql, topPerAttr),
      earliest,
      latest,
      topPerAttr,
    ).catch(() => [] as Record<string, unknown>[]);
    const buckets = rows.map((r) => ({
      attrName: String(r.attr_name ?? attr),
      attrValue: String(r.attr_value ?? ''),
      n: toNum(r.n),
    }));
    if (buckets.length > 0) out.set(attr, buckets);
    onAttr?.(attr, buckets);
  });
  return out;
}

/**
 * Spotlight differentials, keyed on attribute name. For each
 * attribute in `attrs`, fires one query that computes
 * (sel_n, base_n) per value, then returns the top-N values by
 * total count. UI computes the per-value % share within sel /
 * base and ranks attributes by max-abs diff.
 *
 * Same parallel-query pattern as getFacetDistribution above.
 * Attributes with no rows are omitted from the result map.
 */
export interface SpotlightDiffOptions {
  /** Cap per attribute. Defaults to 20. */
  topPerAttr?: number;
  /**
   * Optional scope predicate. When set, BOTH selection and baseline
   * are restricted to spans matching this clause — so the differential
   * becomes "what's different about my selection vs the REST OF THE
   * SCOPE" instead of "vs the rest of the time window."
   *
   * Use for embedded surfaces (Service Detail, Errors page expansion)
   * where the parent context is implicit. Without it, attributes that
   * distinguish the scope ITSELF from other services dominate the
   * ranking and drown out the signal you actually want.
   */
  scopeKql?: string;
  /** Streaming hook (same shape as getFacetDistribution's). */
  onAttr?: (attr: string, rows: SpotlightBucket[]) => void;
}

export async function getSpotlightDiff(
  attrs: readonly string[],
  selectionKql: string,
  earliest = '-1h',
  latest = 'now',
  options: SpotlightDiffOptions = {},
): Promise<Map<string, SpotlightBucket[]>> {
  const { topPerAttr = 20, scopeKql, onAttr } = options;
  const out = new Map<string, SpotlightBucket[]>();
  await runWithLimit(attrs, SPOTLIGHT_CONCURRENCY, async (attr) => {
    const rows = await runQuery(
      Q.spotlightAttrDiff(attr, selectionKql, topPerAttr, scopeKql),
      earliest,
      latest,
      topPerAttr,
    ).catch(() => [] as Record<string, unknown>[]);
    const buckets = rows.map((r) => ({
      attrName: String(r.attr_name ?? attr),
      attrValue: String(r.attr_value ?? ''),
      selN: toNum(r.sel_n),
      baseN: toNum(r.base_n),
    }));
    if (buckets.length > 0) out.set(attr, buckets);
    onAttr?.(attr, buckets);
  });
  return out;
}

export async function getDependencies(
  earliest = '-1h',
  latest = 'now',
): Promise<DependencyEdge[]> {
  const flatFields = await flatFieldsAvailable();
  const [rpcRows, msgRows] = await Promise.all([
    runQuery(Q.dependencies({ flatFields }), earliest, latest, 1000),
    runQuery(Q.messagingDependencies({ flatFields }), earliest, latest, 1000).catch(() => []),
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
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(
    Q.serviceSummary(service, { flatFields, cachedPropagation: true }),
    earliest,
    latest,
    500,
  );
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
 *
 * Reads the flat acceleration columns (service_name / status_code)
 * when the dataset is provisioned (see datasetProvisioner.ts);
 * falls back to dotted-path access otherwise. The featureDetect
 * probe is cached, so this check is essentially free after first
 * page load.
 */
export async function getServiceTimeSeries(
  binSeconds: number,
  service?: string,
  earliest = '-1h',
  latest = 'now',
): Promise<ServiceBucket[]> {
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(
    Q.serviceTimeSeries(binSeconds, service, { flatFields }),
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
 * Fetch per-(status-class) error counts bucketed by minute for one
 * service. Powers the Service Detail status-mix chart. Returns one
 * row per (bucket, statusClass); the UI pivots into separate line
 * series per class.
 */
export async function getServiceStatusCodeMix(
  binSeconds: number,
  service: string,
  earliest = '-1h',
  latest = 'now',
): Promise<StatusCodeMixBucket[]> {
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(
    Q.serviceStatusCodeMix(binSeconds, service, { flatFields }),
    earliest,
    latest,
    10000,
  );
  return rows
    .map((r) => ({
      bucketMs: toNum(r.bucket) * 1000,
      statusClass: String(r.status_class ?? '') as StatusCodeClass,
      count: toNum(r.n),
    }))
    .filter((b) => Number.isFinite(b.bucketMs) && b.bucketMs > 0 && b.statusClass);
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
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.serviceOperations(service, { flatFields }), earliest, latest, 100);
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

/**
 * Per-pod start time + uptime for a service. Used by ServiceDetail
 * to surface uptime chips, and by the Investigator seed to feed
 * the leak-fingerprint check ("Pod has been up for many days").
 */
export interface PodUptime {
  service: string;
  pod: string;
  startIso: string;
  uptimeHours: number;
}
export async function listPodUptime(
  service: string,
  earliest = '-30m',
  latest = 'now',
): Promise<PodUptime[]> {
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.podUptime(service, { flatFields }), earliest, latest, 50);
  return rows.map((r) => ({
    service: String(r.svc ?? service),
    pod: String(r.pod ?? 'unknown'),
    startIso: String(r.start_iso ?? ''),
    uptimeHours: toNum(r.uptime_hours),
  }));
}

export async function listServiceInstances(
  service: string,
  earliest = '-1h',
  latest = 'now',
): Promise<InstanceSummary[]> {
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.serviceInstances(service, { flatFields }), earliest, latest, 100);
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
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.slowestTraces(service, { flatFields }), earliest, latest, 30);
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
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(Q.recentErrorTraces(service, { flatFields }), earliest, latest, 30);
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
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(
    Q.rawRecentErrorSpans(rawLimit, { flatFields, cachedPropagation: true }),
    earliest,
    latest,
    rawLimit,
  );
  const { kept } = applyFilterRulesToRaw(rows, DEFAULT_FILTER_RULES);
  return groupErrorClasses(kept, topClasses);
}

/**
 * Trace-originator classifications observed in the current window.
 * Same shape as the `criblapm_trace_originators` lookup the scheduled
 * search writes — re-running the underlying KQL ad-hoc here is cheap
 * (small per-service aggregate) and gives Settings a current view
 * without depending on the lookup being readable directly.
 */
export interface TraceOriginatorRow {
  rootService: string;
  type: 'user' | 'service' | 'unknown';
  total: number;
  signals: {
    browser: number;
    loadtest: number;
    probe: number;
    messaging: number;
    nameUser: number;
    nameService: number;
  };
}

/** One row per recent deploy event emitted by the
 *  criblapm__deploy_events scheduled search (P2.2 phase 1). */
export interface RecentDeploy {
  service: string;
  version: string;
  firstSeenMs: number;
  ageMinutes: number;
  nSpans: number;
}

/**
 * Read recent deploy events from the dataset. Reads
 * datatype="criblapm_deploy" rows emitted by the criblapm__deploy_events
 * scheduled search. Used by the Investigator preflight to enrich
 * the seed context with "service X deployed Nm ago" lines so the
 * agent considers deploy-correlation when investigating.
 *
 * Window defaults to -2h — wide enough to surface a deploy that
 * happened just before the alert that triggered the investigation,
 * narrow enough that we're not paging through hours of history.
 */
export async function listRecentDeploys(
  earliest = '-2h',
  latest = 'now',
): Promise<RecentDeploy[]> {
  const kql = `dataset="${getCurrentDataset().replace(/[^a-zA-Z0-9_-]/g, '')}"
    | where datatype == "criblapm_deploy"
    | extend svc=tostring(svc), version=tostring(version),
             first_seen_num=toreal(first_seen),
             n_spans_num=tolong(n_spans)
    | summarize first_seen_ms=max(first_seen_num)*1000,
                n_spans_total=max(n_spans_num)
      by svc, version
    | sort by first_seen_ms desc
    | limit 25`;
  const rows = await runQuery(kql, earliest, latest, 50);
  const nowMs = Date.now();
  return rows.map((r) => {
    const firstSeenMs = Number(r.first_seen_ms ?? 0);
    const ageMinutes = firstSeenMs > 0 ? Math.max(0, (nowMs - firstSeenMs) / 60000) : Infinity;
    return {
      service: String(r.svc ?? 'unknown'),
      version: String(r.version ?? 'unknown'),
      firstSeenMs,
      ageMinutes,
      nSpans: Number(r.n_spans_total ?? 0),
    };
  });
}

export async function listTraceOriginators(
  earliest = '-15m',
  latest = 'now',
): Promise<TraceOriginatorRow[]> {
  const rows = await runQuery(Q.traceOriginators(), earliest, latest, 500);
  return rows.map((r) => {
    const t = String(r.type ?? 'unknown');
    const type: TraceOriginatorRow['type'] =
      t === 'user' || t === 'service' ? t : 'unknown';
    const num = (v: unknown): number => {
      const n = typeof v === 'number' ? v : Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      rootService: String(r.root_svc ?? 'unknown'),
      type,
      total: num(r.total),
      signals: {
        browser: num(r.n_browser),
        loadtest: num(r.n_loadtest),
        probe: num(r.n_probe),
        messaging: num(r.n_msg),
        nameUser: num(r.n_name_user),
        nameService: num(r.n_name_service),
      },
    };
  });
}

/**
 * Variant that returns BOTH the filtered class set AND the unfiltered
 * one, plus the per-rule drop counts. Used by the Home page to power
 * the "N hidden — show" toggle. Keeps the simpler `listErrorClasses`
 * verb available for consumers that just want the filtered output.
 */
export interface ErrorClassesBreakdown {
  classes: ErrorClass[];
  unfilteredClasses: ErrorClass[];
  droppedBy: Record<string, number>;
}

export async function listErrorClassesWithBreakdown(
  earliest = '-1h',
  latest = 'now',
  rawLimit = 300,
  topClasses = 20,
  rules: import('./errorFilter').ErrorFilterRule[] = DEFAULT_FILTER_RULES,
): Promise<ErrorClassesBreakdown> {
  const flatFields = await flatFieldsAvailable();
  const rows = await runQuery(
    Q.rawRecentErrorSpans(rawLimit, { flatFields, cachedPropagation: true }),
    earliest,
    latest,
    rawLimit,
  );
  const { kept, droppedBy } = applyFilterRulesToRaw(rows, rules);
  return {
    classes: groupErrorClasses(kept, topClasses),
    unfilteredClasses: groupErrorClasses(rows, topClasses),
    droppedBy,
  };
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
  // Numeric OTel attributes that are NOT metrics — status codes,
  // port numbers, PIDs, etc. Aggregating these produces nonsense.
  'http.status_code', 'http.flavor',
  'net.host.port', 'net.peer.port', 'net.sock.peer.port', 'net.sock.host.port',
  'process.pid',
  'rpc.grpc.status_code',
  'http.response.status_code',
  'cpu', 'partition',
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

function parseMetricType(raw: string): MetricType {
  if (raw === 'counter') return 'counter';
  if (raw === 'gauge') return 'gauge';
  if (raw === 'histogram') return 'histogram';
  return 'unknown';
}

let metricNamesCache: MetricSummary[] | null = null;

/**
 * List all metric names. Tries the cached scheduled search first
 * (criblapm__metric_catalog in $vt_results, ~1s); falls back to a
 * live query if the cache isn't populated. Result is cached in
 * memory for the session since metric names are static.
 */
export async function listMetrics(
  earliest = '-1h',
  latest = 'now',
): Promise<MetricSummary[]> {
  if (metricNamesCache) return metricNamesCache;
  // Try the pre-computed catalog from the scheduled search cache
  try {
    const cached = await listCachedMetricCatalog();
    if (cached && cached.length > 0) {
      const result = cached.map((r) => ({
        name: String(r.name ?? ''),
        samples: toNum(r.samples),
        services: toNum(r.services),
        type: parseMetricType(String(r.metric_type ?? '')),
      })).filter((m) => m.name);
      if (result.length > 0) {
        metricNamesCache = result;
        return result;
      }
    }
  } catch { /* cache miss — fall through */ }
  // Live fallback
  const rows = await runQuery(Q.listMetricNames(), earliest, latest, 500);
  const result = rows.map((r) => ({
    name: String(r.name ?? ''),
    samples: toNum(r.samples),
    services: toNum(r.services),
    type: parseMetricType(String(r.metric_type ?? '')),
  })).filter((m) => m.name);
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
