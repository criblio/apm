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
} from './provisionedSearches';
import { groupSlowTraceClasses, groupErrorClasses } from './search';
import { toDependencyEdges, toMessagingEdges } from './transform';
import type {
  ServiceSummary,
  ServiceBucket,
  SlowTraceClass,
  ErrorClass,
  DependencyEdge,
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
export interface CachedPanels {
  serviceSummaries: ServiceSummary[] | null;
  serviceBuckets: ServiceBucket[] | null;
  slowClasses: SlowTraceClass[] | null;
  errorClasses: ErrorClass[] | null;
  dependencies: DependencyEdge[] | null;
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
export async function listCachedHomePanels(): Promise<CachedPanels> {
  const names = getHomePanelJobNames();
  const partitions = await readCachedPanelsRaw(names);
  return buildCachedPanels(partitions);
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

/** Shared partition → typed-struct builder. Any panel not present
 * in the partition map stays null. */
function buildCachedPanels(
  partitions: Map<string, Record<string, unknown>[]>,
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

  return {
    serviceSummaries: summaryRows ? parseServiceSummaries(summaryRows) : null,
    serviceBuckets: timeSeriesRows ? parseServiceBuckets(timeSeriesRows) : null,
    slowClasses: slowRows ? groupSlowTraceClasses(slowRows) : null,
    errorClasses: errorRows ? groupErrorClasses(errorRows) : null,
    dependencies: mergeDependencyEdges(depRows, msgDepRows),
    lastUpdatedMs,
  };
}
