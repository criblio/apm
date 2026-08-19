/**
 * Panel cache reader — uses `$vt_results` with a `jobName=[...]`
 * array to batch-read every Cribl APM Home and System Architecture
 * panel in a single Cribl Search job. Partitions the mixed result
 * stream client-side by the auto-populated `jobName` column on
 * each row and hands each partition to the existing grouping /
 * parsing helpers in `search.ts`.
 *
 * Why this exists: the live panel queries are expensive (full
 * span aggregation per page load) AND each one pays ~500 ms of
 * queue wait in the Cribl Search worker pool, so a home page with
 * 5 panels used to cost 8–15 s end-to-end. The scheduled searches
 * set up by the provisioner persist the aggregated rows into
 * `$vt_results`; this reader serves them back in ~1 s total.
 *
 * Cache miss semantics: if the scheduled search hasn't run yet
 * (fresh install, dataset just changed) or the range on the page
 * isn't the 1h default the searches are scheduled for, the
 * reader returns `null` for that panel and the caller falls back
 * to the live query. Cache miss is a graceful degradation, not
 * an error.
 *
 * See ROADMAP §2b.2 for the full rationale and
 * `docs/research/cribl-saved-searches.md` for empirical timing
 * numbers that motivate this design.
 */
import { runQuery } from './cribl';
import {
  getHomePanelJobNames,
  getSystemArchPanelJobNames,
  getSvcDetailPanelJobNames,
} from './provisionedSearches';
import { groupSlowTraceClasses, groupErrorClasses } from './search';
import { applyFilterRulesToRaw, DEFAULT_FILTER_RULES } from './errorFilter';
import { toDependencyEdges, toMessagingEdges } from './transform';
import type {
  ServiceSummary,
  ServiceBucket,
  SlowTraceClass,
  ErrorClass,
  DependencyEdge,
  OperationSummary,
  TraceBrief,
} from './types';

/** Panels any Cribl APM page can pull from the cache. When a
 * page only needs a subset (e.g. Home doesn't need dependency
 * edges) it simply ignores the extra keys.
 *
 * The `dependencies` field is the pre-merged DependencyEdge[] —
 * RPC edges (via Q.dependencies) + messaging edges (via
 * Q.messagingDependencies) glued together the same way
 * `search.ts::getDependencies` does at runtime. The cache
 * consumer gets the exact same shape as the live path. */
/** Per-service health + alert state from the alerts scheduled search.
 *  Includes both the health metrics and the state machine output. */
export interface CachedAlertRow {
  service: string;
  currRequests: number;
  currErrors: number;
  currErrorRate: number;
  prevRequests: number;
  prevErrors: number;
  prevErrorRate: number;
  alertId: string;
  signalType: string;
  isBad: boolean;
  isPersistent: boolean;
  alertStatus: string;
  consecutiveBad: number;
  consecutiveGood: number;
  fireCount: number;
  transitionedTo: string;
}

export interface CachedPanels {
  serviceSummaries: ServiceSummary[] | null;
  serviceBuckets: ServiceBucket[] | null;
  slowClasses: SlowTraceClass[] | null;
  errorClasses: ErrorClass[] | null;
  /** Same grouping as errorClasses but without the default filter
   * rules applied — used by the "show unfiltered" toggle on Home. */
  unfilteredErrorClasses: ErrorClass[] | null;
  /** Per-rule drop counts feeding the panel's "N hidden" affordance. */
  errorDroppedBy: Record<string, number> | null;
  dependencies: DependencyEdge[] | null;
  alertRows: CachedAlertRow[] | null;
  /** Latest bucket timestamp observed across the cached panels,
   * in milliseconds since epoch. Used by the UI to render a
   * "Cached N s ago" indicator. Null if nothing cached. */
  lastUpdatedMs: number | null;
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Issue a single $vt_results query covering every panel in
 * `jobNames`, then partition the mixed row stream by the
 * auto-populated `jobName` column. Returns a Map keyed by
 * jobName (with arrays of raw rows as values) so the caller
 * can decide what to do with each partition.
 */
async function readCachedPanelsRaw(
  jobNames: string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  if (jobNames.length === 0) return new Map();
  // Build the jobName `in (...)` clause. Quotes are safe because
  // job names match ^[a-zA-Z0-9 _-]+$.
  //
  // NOTE on syntax: the docs at docs.cribl.io/search/vt_results
  // advertise `jobName=["a","b"]` as an inline array literal,
  // but Cribl KQL does not actually parse that form in the
  // top-of-pipeline position (verified empirically — it returns
  // `no viable alternative at input 'jobName=['`). The working
  // equivalent is a `| where jobName in (...)` filter, which
  // returns the correct union of rows across all named searches.
  const jobNameList = jobNames.map((n) => `"${n}"`).join(', ');
  // The $vt_results dataset is global — no datasetClause() needed.
  // Latest bucket timestamp across all scheduled runs lives in the
  // events, so we don't need a long earliest window. Still, allow
  // up to 1h in case a schedule slipped.
  const query = `dataset="$vt_results" | where jobName in (${jobNameList})`;
  // Panel caches can be large: the time-series panel alone is ~60
  // buckets × ~20 services = 1,200 rows. Seven panels together can
  // push 3,000+ rows. Use a generous limit so nothing is truncated.
  const rows = await runQuery(query, '-1h', 'now', 10_000);

  const out = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const jn = String(row.jobName ?? '');
    if (!jn) continue;
    let bucket = out.get(jn);
    if (!bucket) {
      bucket = [];
      out.set(jn, bucket);
    }
    bucket.push(row);
  }
  return out;
}

/** Parse the service-summary partition into ServiceSummary[]. */
function parseServiceSummaries(
  rows: Record<string, unknown>[],
): ServiceSummary[] {
  return rows.map((r) => {
    const requests = toNum(r.requests);
    const errors = toNum(r.errors);
    return {
      service: String(r.svc ?? 'unknown'),
      requests,
      errors,
      errorRate: toNum(r.error_rate),
      p50Us: toNum(r.p50_us),
      p95Us: toNum(r.p95_us),
      p99Us: toNum(r.p99_us),
    };
  });
}

/** Parse the service-time-series partition into ServiceBucket[]. */
function parseServiceBuckets(
  rows: Record<string, unknown>[],
): ServiceBucket[] {
  return rows.map((r) => ({
    service: String(r.svc ?? 'unknown'),
    bucketMs: toNum(r.bucket) * 1000,
    requests: toNum(r.requests),
    errors: toNum(r.errors),
    p50Us: toNum(r.p50_us),
    p95Us: toNum(r.p95_us),
    p99Us: toNum(r.p99_us),
  }));
}

/** Parse + merge RPC and messaging dependency partitions into
 * the same DependencyEdge[] shape `search.ts::getDependencies`
 * returns. Either partition may be null if that scheduled
 * search hasn't run yet; callers get a partial edge list in
 * that case rather than an error. */
function mergeDependencyEdges(
  rpcRows: Record<string, unknown>[] | null,
  msgRows: Record<string, unknown>[] | null,
): DependencyEdge[] | null {
  if (!rpcRows && !msgRows) return null;
  const rpc = rpcRows ? toDependencyEdges(rpcRows) : [];
  const msg = msgRows ? toMessagingEdges(msgRows) : [];
  return [...rpc, ...msg];
}

/**
 * Read all Home panel caches in one batched $vt_results query.
 * Returns a `CachedPanels` struct with populated fields for every
 * panel that had cached rows, and `null` for panels whose
 * scheduled search hasn't run yet. The caller falls back to the
 * live query path for any null field.
 */
// NOTE: RED panels (service summary, time series, dependencies) are read
// metrics-first at the source functions in search.ts — NOT here. This
// cache reader serves only the non-metric-shaped panels the pages need
// (slow trace classes, error classes, alerts). Pages fetch it
// **non-blocking** so it never gates the fast metrics-backed RED panels.
// See docs/metrics-migration-plan.md.

export async function listCachedHomePanels(
  rules: import('./errorFilter').ErrorFilterRule[] = DEFAULT_FILTER_RULES,
): Promise<CachedPanels> {
  const names = getHomePanelJobNames();
  const partitions = await readCachedPanelsRaw(names);
  return buildCachedPanels(partitions, rules);
}

/** Same pattern for the System Architecture view. Includes the
 * Home-shared service summary + time series panels because the
 * arch page reuses them; this way both pages benefit from the
 * same scheduled runs. */
export async function listCachedSysarchPanels(): Promise<CachedPanels> {
  const names = getSystemArchPanelJobNames();
  const partitions = await readCachedPanelsRaw(names);
  return buildCachedPanels(partitions);
}

function parseAlertRows(rows: Record<string, unknown>[]): CachedAlertRow[] {
  return rows.map((r) => ({
    service: String(r.svc ?? 'unknown'),
    currRequests: toNum(r.curr_requests),
    currErrors: toNum(r.curr_errors),
    currErrorRate: toNum(r.curr_error_rate),
    prevRequests: toNum(r.prev_requests),
    prevErrors: toNum(r.prev_errors),
    prevErrorRate: toNum(r.prev_error_rate),
    alertId: String(r.alert_id ?? ''),
    signalType: String(r.signal_type ?? 'none'),
    isBad: r.is_bad === true || r.is_bad === 'true',
    isPersistent: r.is_persistent === true || r.is_persistent === 'true',
    alertStatus: String(r.alert_status ?? 'ok'),
    consecutiveBad: toNum(r.consecutive_bad),
    consecutiveGood: toNum(r.consecutive_good),
    fireCount: toNum(r.fire_count),
    transitionedTo: String(r.transitioned_to ?? ''),
  }));
}

/** Shared partition → typed-struct builder. Any panel not present
 * in the partition map stays null. */
function buildCachedPanels(
  partitions: Map<string, Record<string, unknown>[]>,
  rules: import('./errorFilter').ErrorFilterRule[] = DEFAULT_FILTER_RULES,
): CachedPanels {
  let lastUpdatedMs: number | null = null;
  for (const rows of partitions.values()) {
    for (const row of rows) {
      const t = toNum(row._time) * 1000;
      if (t > 0 && (lastUpdatedMs === null || t > lastUpdatedMs)) {
        lastUpdatedMs = t;
      }
    }
  }

  const get = (name: string): Record<string, unknown>[] | null => {
    const rows = partitions.get(name);
    return rows && rows.length > 0 ? rows : null;
  };

  const summaryRows = get('criblapm__home_service_summary');
  const timeSeriesRows = get('criblapm__home_service_time_series');
  const slowRows = get('criblapm__home_slow_traces');
  const errorRows = get('criblapm__home_error_spans');
  const depRows = get('criblapm__sysarch_dependencies');
  const msgDepRows = get('criblapm__sysarch_messaging_deps');
  const alertsRows = get('criblapm__home_alerts');

  // Compute the filter once and reuse for all three error-related
  // fields. groupErrorClasses is cheap (linear over ≤300 rows).
  const errorFilter = errorRows ? applyFilterRulesToRaw(errorRows, rules) : null;

  return {
    serviceSummaries: summaryRows ? parseServiceSummaries(summaryRows) : null,
    serviceBuckets: timeSeriesRows ? parseServiceBuckets(timeSeriesRows) : null,
    slowClasses: slowRows ? groupSlowTraceClasses(slowRows) : null,
    errorClasses: errorFilter ? groupErrorClasses(errorFilter.kept) : null,
    unfilteredErrorClasses: errorRows ? groupErrorClasses(errorRows) : null,
    errorDroppedBy: errorFilter ? errorFilter.droppedBy : null,
    dependencies: mergeDependencyEdges(depRows, msgDepRows),
    alertRows: alertsRows ? parseAlertRows(alertsRows) : null,
    lastUpdatedMs,
  };
}

// ── Errors-page focused cache reader ─────────────────────────
//
// The ErrorsPage only needs `criblapm__home_error_spans` — pulling
// the full home-panel bundle (summary + time series + slow traces
// + alerts) over the wire just to discard everything else is
// wasted work. This reader fetches the single panel and runs the
// filter + grouping inline.
//
// Falls back to live query on the caller side when the cache is
// stale or unavailable (returns `null`).

export interface CachedErrorClasses {
  classes: ErrorClass[];
  unfilteredClasses: ErrorClass[];
  droppedBy: Record<string, number>;
  lastUpdatedMs: number | null;
}

export async function listCachedErrorClasses(
  rules: import('./errorFilter').ErrorFilterRule[] = DEFAULT_FILTER_RULES,
): Promise<CachedErrorClasses | null> {
  const partitions = await readCachedPanelsRaw(['criblapm__home_error_spans']);
  const rows = partitions.get('criblapm__home_error_spans');
  if (!rows || rows.length === 0) return null;
  // Track the most recent _time across all returned rows so the UI
  // can show a freshness indicator ("cache updated 2m ago").
  let lastUpdatedMs: number | null = null;
  for (const r of rows) {
    const t = toNum(r._time) * 1000;
    if (t > 0 && (lastUpdatedMs === null || t > lastUpdatedMs)) {
      lastUpdatedMs = t;
    }
  }
  const { kept, droppedBy } = applyFilterRulesToRaw(rows, rules);
  return {
    classes: groupErrorClasses(kept),
    unfilteredClasses: groupErrorClasses(rows),
    droppedBy,
    lastUpdatedMs,
  };
}

/**
 * Alert firing/resolved transitions from the `criblapm__alert_history`
 * scheduled search — a wide (-7d) rollup materialized into $vt_results, so
 * the Alerts page reads it here instead of firing a live 24h search on
 * every load (P4.5). Transitions are sparse, so the wide window is cheap.
 * Returns null when the cache hasn't populated yet (caller falls back to a
 * live search). Rows are raw; the caller filters to the selected range and
 * maps them (same shape as the live `Q.alertHistory` result).
 */
export async function readCachedAlertHistory(): Promise<Record<string, unknown>[] | null> {
  const partitions = await readCachedPanelsRaw(['criblapm__alert_history']);
  const rows = partitions.get('criblapm__alert_history');
  return rows && rows.length > 0 ? rows : null;
}

// ── Incidents cache (P4.4) ───────────────────────────────────

/**
 * Read the incident state fold (`criblapm__incidents_state`) from
 * $vt_results and assemble one IncidentSummary per incident from its
 * per-(incident, service) rows. Returns null when the fold hasn't run
 * yet. keepLastN retains two runs, so rows are first narrowed to the
 * newest jobId (fixed-width epoch-millis prefix makes the string max
 * the latest run).
 */
export async function listCachedIncidents(): Promise<
  import('./types').IncidentSummary[] | null
> {
  const partitions = await readCachedPanelsRaw(['criblapm__incidents_state']);
  const rows = partitions.get('criblapm__incidents_state');
  if (!rows || rows.length === 0) return null;

  let latestJob = '';
  for (const r of rows) {
    const id = String(r.jobId ?? '');
    if (id > latestJob) latestJob = id;
  }
  const latest = rows.filter((r) => String(r.jobId ?? '') === latestJob);

  const byIncident = new Map<string, import('./types').IncidentSummary>();
  for (const r of latest) {
    const incidentId = String(r.incident_id ?? '');
    const service = String(r.svc ?? '');
    if (!incidentId || !service || incidentId === '__init__') continue;
    const member = {
      service,
      firstSeenMs: toNum(r.first_seen) * 1000,
      lastFireMs: toNum(r.last_fire_at) * 1000,
      fireCount: toNum(r.fire_n),
    };
    let inc = byIncident.get(incidentId);
    if (!inc) {
      inc = {
        incidentId,
        title: String(r.title ?? incidentId),
        status: String(r.status ?? 'open') as import('./types').IncidentSummary['status'],
        severity: String(r.severity ?? 'sev4') as import('./types').IncidentSummary['severity'],
        services: [],
        rootService: '',
        openedAtMs: toNum(r.opened_at) * 1000,
        lastFireMs: toNum(r.inc_last_fire) * 1000,
      };
      byIncident.set(incidentId, inc);
    }
    inc.services.push(member);
  }

  const incidents = Array.from(byIncident.values());
  for (const inc of incidents) {
    inc.services.sort((a, b) => a.firstSeenMs - b.firstSeenMs);
    inc.rootService = inc.services[0]?.service ?? '';
  }
  incidents.sort((a, b) => b.lastFireMs - a.lastFireMs);
  return incidents;
}

// ── ServiceDetail panel cache ─────────────────────────────────

export interface CachedSvcDetailPanels {
  summary: ServiceSummary | null;
  buckets: ServiceBucket[] | null;
  operations: OperationSummary[] | null;
  recentErrors: TraceBrief[] | null;
  dependencies: DependencyEdge[] | null;
  lastUpdatedMs: number | null;
}

function parseOperationSummaries(
  rows: Record<string, unknown>[],
  serviceName: string,
): OperationSummary[] {
  return rows
    .filter((r) => String(r.svc ?? '') === serviceName)
    .map((r) => ({
      operation: String(r.name ?? 'unknown'),
      requests: toNum(r.requests),
      errors: toNum(r.errors),
      errorRate: toNum(r.error_rate),
      p50Us: toNum(r.p50_us),
      p95Us: toNum(r.p95_us),
      p99Us: toNum(r.p99_us),
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 50);
}

function parseRecentErrorTraces(
  rows: Record<string, unknown>[],
  serviceName: string,
): TraceBrief[] {
  const byTrace = new Map<string, { traceID: string; startTime: number; errorCount: number }>();
  for (const r of rows) {
    if (String(r.svc ?? '') !== serviceName) continue;
    const tid = String(r.trace_id ?? '');
    if (!tid) continue;
    const t = toNum(r._time) * 1_000_000;
    let acc = byTrace.get(tid);
    if (!acc) {
      acc = { traceID: tid, startTime: t, errorCount: 0 };
      byTrace.set(tid, acc);
    }
    acc.errorCount += 1;
    if (t > acc.startTime) acc.startTime = t;
  }
  return Array.from(byTrace.values())
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, 20)
    .map((a) => ({
      traceID: a.traceID,
      durationUs: 0,
      startTime: a.startTime,
      errorCount: a.errorCount,
    }));
}

/**
 * Read the ServiceDetail panels from the cache. Reuses five of the
 * six existing Home + SysArch scheduled searches — their data is
 * already per-service, just unfiltered. The reader applies the
 * service-name filter client-side. Only one new scheduled search
 * is needed: `criblapm__svc_operations` for per-(service, op)
 * rollups.
 */
export async function listCachedSvcDetailPanels(
  serviceName: string,
): Promise<CachedSvcDetailPanels> {
  const names = getSvcDetailPanelJobNames();
  const partitions = await readCachedPanelsRaw(names);

  let lastUpdatedMs: number | null = null;
  for (const rows of partitions.values()) {
    for (const row of rows) {
      const t = toNum(row._time) * 1000;
      if (t > 0 && (lastUpdatedMs === null || t > lastUpdatedMs)) {
        lastUpdatedMs = t;
      }
    }
  }

  const get = (name: string): Record<string, unknown>[] | null => {
    const rows = partitions.get(name);
    return rows && rows.length > 0 ? rows : null;
  };

  const summaryRows = get('criblapm__home_service_summary');
  const timeSeriesRows = get('criblapm__home_service_time_series');
  const errorSpanRows = get('criblapm__home_error_spans');
  const opsRows = get('criblapm__svc_operations');
  const depRows = get('criblapm__sysarch_dependencies');
  const msgDepRows = get('criblapm__sysarch_messaging_deps');

  const allSummaries = summaryRows ? parseServiceSummaries(summaryRows) : null;
  const summary = allSummaries?.find((s) => s.service === serviceName) ?? null;
  const allBuckets = timeSeriesRows ? parseServiceBuckets(timeSeriesRows) : null;
  const buckets = allBuckets?.filter((b) => b.service === serviceName) ?? null;

  return {
    summary,
    buckets,
    operations: opsRows ? parseOperationSummaries(opsRows, serviceName) : null,
    recentErrors: errorSpanRows ? parseRecentErrorTraces(errorSpanRows, serviceName) : null,
    dependencies: mergeDependencyEdges(depRows, msgDepRows),
    lastUpdatedMs,
  };
}

// ── Metric catalog cache ──────────────────────────────────

/**
 * Read the cached metric sample records from $vt_results. Returns
 * the raw rows so the caller can run discoverMetricNames(). Returns
 * null if the scheduled search hasn't run yet.
 */
export async function listCachedMetricCatalog(): Promise<Record<string, unknown>[] | null> {
  const partitions = await readCachedPanelsRaw(['criblapm__metric_catalog']);
  const rows = partitions.get('criblapm__metric_catalog');
  return rows && rows.length > 0 ? rows : null;
}
