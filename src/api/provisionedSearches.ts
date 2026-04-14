/**
 * Declarative inventory of every scheduled Cribl Saved Search that
 * Cribl APM provisions and relies on at runtime. Two categories:
 *
 *  1. **Panel caches** — precomputed query outputs for the Home and
 *     System Architecture panels. Read back via $vt_results by
 *     jobName (§2b.2 in the ROADMAP). One batched $vt_results
 *     query pulls every cached panel in a single search job
 *     because jobName accepts an array.
 *
 *  2. **Op-baseline lookup** — rolling 24h per-(service, operation)
 *     p95 snapshot, written to a workspace lookup via
 *     `export mode=overwrite`. Joined against live queries by the
 *     latency anomaly detector (§2b.1).
 *
 * The provisioner at api/provisioner.ts reads this list, compares
 * it to the server's current set of criblapm__* saved searches,
 * and upserts / deletes as needed. See ROADMAP §2b for the full
 * rationale.
 *
 * IDs are prefixed with `criblapm__` (double underscore) so a
 * prefix match is enough to find app-managed rows without risk of
 * touching user-created searches.
 *
 * The query bodies are produced by calling the standard builders
 * in queries.ts. Those functions read the current dataset and
 * stream-filter state at invocation time, so if those settings
 * change the provisioner must be re-run to pick up the new
 * baked-in values. The ROADMAP caveats section covers this.
 */
import * as Q from './queries';

/** Stable prefix for every app-managed saved search ID. Used by
 * the provisioner to find and reconcile rows without stomping
 * user-created searches. */
export const CRIBLAPM_PREFIX = 'criblapm__';

/** Name of the workspace lookup the op-baseline search writes to.
 * The live anomaly detector joins against this via
 * `| lookup criblapm_op_baselines on svc, op`. Single underscore
 * intentionally — lookup names can't start with the double-
 * underscore pattern without looking weird in the UI. */
export const OP_BASELINES_LOOKUP = 'criblapm_op_baselines';

/** The subset of the Cribl saved-search object that the provisioner
 * cares about. The server fills in the rest (`user`, etc.). */
export interface ProvisionedSearch {
  id: string;
  name: string;
  description: string;
  query: string;
  earliest: string;
  latest: string;
  sampleRate?: number;
  schedule: {
    enabled: boolean;
    cronSchedule: string;
    tz: string;
    keepLastN: number;
  };
}

/**
 * Baseline query for the latency anomaly detector. Same aggregation
 * as `Q.allOperationsSummary` (with the span-level stream filter
 * applied so idle-poll noise doesn't poison the baseline), but
 * terminates with `| export mode=overwrite to lookup` so each
 * scheduled run atomically replaces the workspace lookup.
 *
 * Scope: 24h window (configured at the scheduled search level via
 * `earliest: "-24h"`). 10,000 row cap is ample — our demo has ~100
 * distinct (svc, op) pairs, production workloads typically stay
 * under 2,000.
 *
 * The query builder here is NOT exported from queries.ts because
 * it's coupled to the export-to-lookup behavior and isn't used
 * live. Keep it local.
 */
function opBaselineQuery(): string {
  const base = Q.allOperationsSummary(10_000);
  return `${base}
    | export mode=overwrite
             description="Cribl APM - rolling 24h per-op p95 baseline"
             to lookup ${OP_BASELINES_LOOKUP}`;
}

/**
 * Declarative list of every scheduled search the app needs. Order
 * doesn't matter functionally but matches the ROADMAP §2b.2 table
 * for easy cross-referencing.
 *
 * All panel caches run every five minutes (cron: "star-slash-5
 * star star star star") over a rolling 1-hour window. That matches
 * the default range users see on the Home and System Architecture
 * pages. Users who pick a non-default range (6h / 24h / 15m) fall
 * back to the live query path — graceful cache miss, not a failure.
 *
 * The op-baseline runs hourly ("0 * * * *") over a 24-hour window.
 * Baselines move slowly; running more often is wasted worker time.
 */
export function getProvisioningPlan(): ProvisionedSearch[] {
  const everyFiveMin = {
    enabled: true,
    cronSchedule: '*/5 * * * *',
    tz: 'UTC',
    keepLastN: 2,
  } as const;
  const hourly = {
    enabled: true,
    cronSchedule: '0 * * * *',
    tz: 'UTC',
    keepLastN: 2,
  } as const;

  return [
    // ── Home panel caches ───────────────────────────────────
    {
      id: 'criblapm__home_service_summary',
      name: 'Cribl APM - home service summary',
      description:
        'Cribl APM: per-service rate / errors / p50 / p95 / p99 for the Home catalog. Read via $vt_results.',
      query: Q.serviceSummary(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...everyFiveMin },
    },
    {
      id: 'criblapm__home_service_time_series',
      name: 'Cribl APM - home service time series',
      description:
        'Cribl APM: per-service request/error/p95 buckets for Home sparklines (60s bins). Read via $vt_results.',
      query: Q.serviceTimeSeries(60),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...everyFiveMin },
    },
    {
      id: 'criblapm__home_slow_traces',
      name: 'Cribl APM - home slow trace classes',
      description:
        'Cribl APM: raw slow-trace rows (root svc/op + trace duration) for the Slowest Trace Classes panel. Read via $vt_results.',
      query: Q.rawSlowestTraces(500),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...everyFiveMin },
    },
    {
      id: 'criblapm__home_error_spans',
      name: 'Cribl APM - home error spans',
      description:
        'Cribl APM: recent error spans for the Home Error Classes panel. Read via $vt_results.',
      query: Q.rawRecentErrorSpans(300),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...everyFiveMin },
    },
    // ── System Architecture panel caches ────────────────────
    {
      id: 'criblapm__sysarch_dependencies',
      name: 'Cribl APM - system architecture RPC dependencies',
      description:
        'Cribl APM: service→service RPC edges via parent_span_id self-join. Read via $vt_results.',
      query: Q.dependencies(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...everyFiveMin },
    },
    {
      id: 'criblapm__sysarch_messaging_deps',
      name: 'Cribl APM - system architecture messaging dependencies',
      description:
        'Cribl APM: kafka / messaging edges aggregated by (service, topic, operation). Read via $vt_results.',
      query: Q.messagingDependencies(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...everyFiveMin },
    },
    // ── Op baseline lookup ──────────────────────────────────
    {
      id: 'criblapm__op_baselines',
      name: 'Cribl APM - per-op 24h latency baselines',
      description:
        'Cribl APM: rolling 24h per-(service, operation) p50/p95/p99 baseline, materialized as the criblapm_op_baselines lookup for the anomaly detector.',
      query: opBaselineQuery(),
      earliest: '-24h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...hourly },
    },
  ];
}

/** Convenience: return just the IDs, in the order the plan
 * declares them. Used by the batched $vt_results panel-read
 * verb so the client sends them all in one jobName array. */
export function getHomePanelJobNames(): string[] {
  return [
    'criblapm__home_service_summary',
    'criblapm__home_service_time_series',
    'criblapm__home_slow_traces',
    'criblapm__home_error_spans',
  ];
}

/** Companion for the System Architecture page. */
export function getSystemArchPanelJobNames(): string[] {
  return [
    'criblapm__sysarch_dependencies',
    'criblapm__sysarch_messaging_deps',
    // Home-shared panels reused on the arch page
    'criblapm__home_service_summary',
    'criblapm__home_service_time_series',
  ];
}
