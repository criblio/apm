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
import type { ProvisionedSearch, SeedLookup } from '@cribl/app-utils/provisioner';
import * as Q from './queries';
import { getSearchCadenceCron } from '@cribl/app-utils/cadence';

export type { ProvisionedSearch };

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
export const ALERT_STATES_LOOKUP = 'criblapm_alert_states';
export const ALERT_PREV_LOOKUP = 'criblapm_alert_prev';
/** Trace-originator classification lookup — joined by the error
 * filter to tag each error span with the kind of actor that
 * initiated its trace (user / service / unknown). See
 * docs/research/error-filter-design.md for the signal priority
 * and Phase 0 validation against staging. */
export const TRACE_ORIGINATORS_LOOKUP = 'criblapm_trace_originators';

/** Per-(svc, attr_name) catalog of attribute names observed in
 * recent spans. Foundation for the cardinality / leak-fingerprint
 * detection pipeline — once we know what attributes exist per
 * service, a follow-up cardinality search computes dcount for
 * each. See HEURISTICS.md §"Cardinality detection". */
export const ATTR_CATALOG_LOOKUP = 'criblapm_attr_catalog';

/** 7-day per-service daily error-rate history. Read by the
 * Investigator to compute multi-day slope in one cheap query
 * (rather than scanning raw spans, which times out at 7d). The
 * alert pipeline can also surface a "drift" signal from this. */
/** Per-service 6-day error-rate history pivoted to one row per
 * service (columns d1..d6 = yesterday through 6 days ago). Read
 * by the Investigator leak-fingerprint playbook. The pivot is
 * essential — Cribl `lookup ... on svc` returns only the first
 * matching row, so a per-day-row schema would be unreadable. */
export const ERROR_RATE_HISTORY_LOOKUP = 'criblapm_error_rate_history';

/** Lookup tables that must exist before scheduled searches that
 * `lookup` against them can be created. The framework provisioner
 * probes each by name and runs the seed query if absent. */
export const SEED_LOOKUPS: SeedLookup[] = [
  {
    name: ALERT_STATES_LOOKUP,
    seedQuery: `dataset="otel" | limit 1 | project alert_id="__init__", alert_status="ok", consecutive_bad=0, consecutive_good=0, fire_count=0 | export mode=overwrite description="Cribl APM - alert state init" to lookup ${ALERT_STATES_LOOKUP}`,
  },
  {
    name: ALERT_PREV_LOOKUP,
    seedQuery: `dataset="otel" | limit 1 | project svc="__init__", prev_req=0, prev_err=0, prev_err_rate=0.0, prev_p95_us=0 | export mode=overwrite description="Cribl APM - prev window init" to lookup ${ALERT_PREV_LOOKUP}`,
  },
  {
    name: TRACE_ORIGINATORS_LOOKUP,
    seedQuery: `dataset="otel" | limit 1 | project root_svc="__init__", type="unknown", total=0, n_browser=0, n_loadtest=0, n_probe=0, n_msg=0, n_name_user=0, n_name_service=0 | export mode=overwrite description="Cribl APM - trace originators init" to lookup ${TRACE_ORIGINATORS_LOOKUP}`,
  },
  {
    name: ATTR_CATALOG_LOOKUP,
    seedQuery: `dataset="otel" | limit 1 | project svc="__init__", attr_name="__init__", n_spans_with_key=0, last_seen=0 | export mode=overwrite description="Cribl APM - attr catalog init" to lookup ${ATTR_CATALOG_LOOKUP}`,
  },
  {
    name: ERROR_RATE_HISTORY_LOOKUP,
    seedQuery: `dataset="otel" | limit 1 | project svc="__init__", d1_pct=0.0, d2_pct=0.0, d3_pct=0.0, d4_pct=0.0, d5_pct=0.0, d6_pct=0.0, d1_total=0, d2_total=0, d3_total=0, d4_total=0, d5_total=0, d6_total=0 | export mode=overwrite description="Cribl APM - error rate history init" to lookup ${ERROR_RATE_HISTORY_LOOKUP}`,
  },
];

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
 * Trace-originator classification, wrapped with the export tail
 * that lands rows in the criblapm_trace_originators lookup. The
 * underlying classification logic lives in Q.traceOriginators()
 * so it stays testable in isolation; this wrapper exists only to
 * tack the | export on. Same pattern as opBaselineQuery() above.
 */
function traceOriginatorsExportQuery(): string {
  return `${Q.traceOriginators()}
    | export mode=overwrite
             description="Cribl APM - trace originator classification"
             to lookup ${TRACE_ORIGINATORS_LOOKUP}`;
}

/**
 * Attribute-name catalog wrapper — same pattern. Q.attrCatalog()
 * holds the bag_keys discovery logic; this function adds export.
 * Cardinality (dcount per (svc, attr_name)) is a follow-up that
 * generates its KQL at provision time from the catalog contents.
 */
function attrCatalogExportQuery(): string {
  // Sample 1000 spans (down from 5000). The bag_keys + mv-expand
  // pass blows the row count up by the per-span key count (~20),
  // i.e. 5000 input → 100K intermediate rows. The 2026-05-19
  // baseline showed this search hitting Cribl's `"Unexpected
  // 'reset' signal"` (resource exhaustion / saturation kill) on
  // every scheduled run. 1000 input → 20K intermediate is still
  // plenty for discovering attribute names but lets the run finish.
  return `${Q.attrCatalog(1000)}
    | export mode=overwrite
             description="Cribl APM - attribute name catalog"
             to lookup ${ATTR_CATALOG_LOOKUP}`;
}

/** 6-day per-service error-rate history snapshot. Runs once per
 * day; six of the seven days the previous version recomputed each
 * hour were immutable, so 23/24 of that work was wasted. */
function errorRateHistoryExportQuery(): string {
  return `${Q.errorRateHistory()}
    | export mode=overwrite
             description="Cribl APM - 6-day per-service error-rate history (yesterday..-6d), pivoted one row per svc"
             to lookup ${ERROR_RATE_HISTORY_LOOKUP}`;
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
  const cronSchedule = getSearchCadenceCron();
  const panelCadence = {
    enabled: true,
    cronSchedule,
    tz: 'UTC',
    keepLastN: 2,
  } as const;
  // Alert evaluator runs 1 minute after the panel searches so their
  // $vt_results and lookup exports are available.
  const evalCronSchedule = cronSchedule.replace(/^\*\/(\d+)/, (_m: string, n: string) => `1-59/${n}`).replace(/^\* /, '1 ');
  const evalCadence = {
    enabled: true,
    cronSchedule: evalCronSchedule,
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
      schedule: { ...panelCadence },
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
      schedule: { ...panelCadence },
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
      schedule: { ...panelCadence },
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
      schedule: { ...panelCadence },
    },
    // ── Alert pipeline: prev summary → evaluator → state export
    //
    // Three searches run in sequence each cadence cycle:
    //  1. prev_summary: exports previous-window metrics to a lookup
    //  2. alert_eval: reads current from $vt_results + prev from
    //     lookup, applies state machine, outputs to $vt_results
    //  3. alert_state_export: same as eval but exports state to
    //     lookup for the next cycle
    //
    // The evaluator runs 1 minute after the summaries so their
    // results are available.
    {
      id: 'criblapm__home_alerts_prev',
      name: 'Cribl APM - previous window summary',
      description:
        'Cribl APM: service summary for the previous hour. Exports to the criblapm_alert_prev lookup so the alert evaluator can compare current vs previous without a pivot.',
      query: Q.prevWindowSummary(),
      earliest: '-2h',
      latest: '-1h',
      sampleRate: 1,
      schedule: { ...panelCadence },
    },
    {
      id: 'criblapm__home_alerts',
      name: 'Cribl APM - alert evaluator',
      description:
        'Cribl APM: reads current service summary from $vt_results, joins previous from lookup, computes health + debounce state machine. Output includes alert_status (ok/pending/firing/resolving) and transitioned_to.',
      query: Q.alertEvaluator(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...evalCadence },
    },
    {
      id: 'criblapm__alert_state_export',
      name: 'Cribl APM - alert state export',
      description:
        'Cribl APM: exports alert state machine columns to the criblapm_alert_states lookup for persistence across evaluation cycles.',
      query: Q.alertEvaluatorExportState(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...evalCadence },
    },
    {
      id: 'criblapm__alert_history_send',
      name: 'Cribl APM - alert history send',
      description:
        'Cribl APM: sends alert state transitions (firing/resolved) back to the dataset as searchable history via | send group="search".',
      query: Q.alertHistorySend(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...evalCadence },
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
      schedule: { ...panelCadence },
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
      schedule: { ...panelCadence },
    },
    // ── Service Detail panel cache ──────────────────────────
    {
      id: 'criblapm__svc_operations',
      name: 'Cribl APM - per-service top operations',
      description:
        'Cribl APM: per-(service, operation) request/error/percentile rollup for the ServiceDetail Top Operations table. Read via $vt_results, client-filtered to the viewed service.',
      query: Q.allServiceOperations(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...panelCadence },
    },
    // ── Metric catalog ──────────────────────────────────────
    {
      id: 'criblapm__metric_catalog',
      name: 'Cribl APM - metric name catalog',
      description:
        'Cribl APM: pre-computed metric name catalog with sample counts and service coverage. Extracts metric field names from _raw via regex (wide-column schema). Read via $vt_results by the Metrics page picker. Hourly cadence — metric names rarely appear/disappear within an hour, and the regex pass costs ~4s per run.',
      query: Q.listMetricNames(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      // Was every 5min (panelCadence) — saves ~48s/hr.
      schedule: { ...hourly, cronSchedule: '7 * * * *' },
    },
    // ── Op baseline lookup ──────────────────────────────────
    {
      id: 'criblapm__op_baselines',
      name: 'Cribl APM - per-op 24h latency baselines',
      description:
        'Cribl APM: rolling 24h per-(service, operation) p50/p95/p99 baseline, materialized as the criblapm_op_baselines lookup for the anomaly detector. Every 6h — baselines move slowly, and this is the second-heaviest search in the pack (~43s p50).',
      query: opBaselineQuery(),
      earliest: '-24h',
      latest: 'now',
      sampleRate: 1,
      // Was hourly — saves ~35s/hr.
      schedule: { ...hourly, cronSchedule: '23 */6 * * *' },
    },
    // ── Trace originator classification ─────────────────────
    {
      id: 'criblapm__trace_originators',
      name: 'Cribl APM - trace originator classification',
      description:
        'Cribl APM: classifies each captured trace-root service as user-origin (real or synthetic user) or service-origin (cron, queue consumer) by user-agent value, messaging.system, and span-name patterns. Output goes to the criblapm_trace_originators lookup, joined by the error filter at query time. See docs/research/error-filter-design.md. Hourly — originator type for a service changes ~never.',
      query: traceOriginatorsExportQuery(),
      earliest: '-15m',
      latest: 'now',
      sampleRate: 1,
      // Was every 5min — saves ~12s/hr.
      schedule: { ...hourly, cronSchedule: '11 * * * *' },
    },
    // ── Attribute-name catalog (leak detection foundation) ──
    {
      id: 'criblapm__attr_catalog',
      name: 'Cribl APM - attribute name catalog',
      description:
        'Cribl APM: enumerates the attribute names observed on spans per service via bag_keys + mv-expand on a recent sample. Output is the foundation for the cardinality / leak-fingerprint pipeline. See HEURISTICS.md §"Cardinality detection".',
      query: attrCatalogExportQuery(),
      earliest: '-5m',
      latest: 'now',
      sampleRate: 1,
      // Hourly is enough — attribute names don't change minute to
      // minute, and the bag_keys+mv-expand pass is per-row expensive.
      schedule: { ...hourly },
    },
    // ── 6-day per-service error-rate history (drift) ─────────
    {
      id: 'criblapm__error_rate_history',
      name: 'Cribl APM - 6-day per-service error-rate history',
      description:
        'Cribl APM: per-service error-rate snapshot for yesterday + 5 prior days, pivoted one row per service (d1..d6 columns). Read by the Investigator playbook (leak signature, ingredient #1) to compute multi-day slope in ONE cheap lookup query. Runs ONCE per day at 00:30 UTC — completed-day rows are immutable, so hourly recompute was wasted work (was 134s/hr; now 134s/day).',
      query: errorRateHistoryExportQuery(),
      earliest: '-7d',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...hourly, cronSchedule: '30 0 * * *' },
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
    'criblapm__home_alerts',  // alert evaluator output (health + state)
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

/** Service Detail page. Reuses every Home + SysArch panel (they
 *  already contain per-service data — the reader filters client-side)
 *  plus the new per-(svc, op) rollup for the Top Operations table. */
export function getSvcDetailPanelJobNames(): string[] {
  return [
    'criblapm__home_service_summary',
    'criblapm__home_service_time_series',
    'criblapm__home_error_spans',
    'criblapm__svc_operations',
    'criblapm__sysarch_dependencies',
    'criblapm__sysarch_messaging_deps',
  ];
}
