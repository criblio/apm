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
import { getSearchCadenceCron, getSearchCadence } from '@cribl/app-utils/cadence';
import { getMetricsEmit } from './metricsEmit';
import { getServerInvestigations } from './serverInvestigations';
import type { BackfillEmitter } from './metricsBackfill';
import {
  METRIC_REQUESTS_TOTAL,
  METRIC_EDGE_CALLS_TOTAL,
  METRIC_MESSAGING_TOTAL,
  METRIC_STATUS_CLASS_TOTAL,
  METRIC_REQUEST_LATENCY_MS,
  METRIC_OP_LATENCY_MS,
  METRIC_EDGE_LATENCY_MS,
  METRIC_MSG_LATENCY_MS,
  LATENCY_QUANTILES,
} from './metricNames';

/**
 * Backfill sample rate for the per-span request-duration histogram — the
 * dominant emit volume. 0.25 (first 4 hex chars of span_id) cuts backfill
 * export volume ~4× while preserving percentile shape (see
 * sampleFirstHexClause). The LIVE scheduled search stays unsampled.
 */
export const BACKFILL_HISTOGRAM_SAMPLE_RATE = 0.25;

export type { ProvisionedSearch };

/** Stable prefix for every app-managed saved search ID. Used by
 * the provisioner to find and reconcile rows without stomping
 * user-created searches. */
export const CRIBLAPM_PREFIX = 'criblapm__';

/** The webhook notification target the alert-notify search fires at.
 *  Created/updated by scripts/provision.ts from the CELL_URL /
 *  CELL_WEBHOOK_BEARER env when serverInvestigations is on. */
export const CELL_WEBHOOK_TARGET_ID = 'criblapm_cell_webhook';

/** Name of the workspace lookup the op-baseline search writes to.
 * The live anomaly detector joins against this via
 * `| lookup criblapm_op_baselines on svc, op`. Single underscore
 * intentionally — lookup names can't start with the double-
 * underscore pattern without looking weird in the UI. */
export const OP_BASELINES_LOOKUP = 'criblapm_op_baselines';
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

/** Live (non-closed) incident membership, one row per (incident_id,
 * svc) — the incident grouper's attach-join surface (P4.4). Written
 * by criblapm__incidents_export from the state fold's $vt_results;
 * closed incidents are excluded so a fire on their services opens a
 * fresh incident. Rows are sorted newest-incident-first before export
 * because `lookup ... on svc` returns the first matching row. */
export const INCIDENTS_LOOKUP = 'criblapm_incidents';

/** Lookup tables that must exist before scheduled searches that
 * `lookup` against them can be created. The framework provisioner
 * probes each by name and runs the seed query if absent.
 *
 * Seeds start with `print` — not `dataset="otel" | limit 1 | project`
 * — so they emit their sentinel row deterministically. The older
 * dataset-derived pattern produced *zero* rows on a fresh install
 * whose otel dataset had not yet received any events. When the
 * export tail then ran on empty input, some Cribl versions wrote a
 * header-only CSV (safe) and others did not create the file at all
 * (fatal — downstream `| lookup <name> on <col>` fails with
 * "Unknown lookup table name"). `print` sidesteps the branch by
 * always producing exactly one row. */
export const SEED_LOOKUPS: SeedLookup[] = [
  {
    name: ALERT_PREV_LOOKUP,
    seedQuery: `print svc="__init__", prev_req=tolong(0), prev_err=tolong(0), prev_err_rate=todouble(0.0), prev_p95_us=tolong(0) | export mode=overwrite description="Cribl APM - prev window init" to lookup ${ALERT_PREV_LOOKUP}`,
  },
  {
    name: TRACE_ORIGINATORS_LOOKUP,
    seedQuery: `print root_svc="__init__", type="unknown", total=tolong(0), n_browser=tolong(0), n_loadtest=tolong(0), n_probe=tolong(0), n_msg=tolong(0), n_name_user=tolong(0), n_name_service=tolong(0) | export mode=overwrite description="Cribl APM - trace originators init" to lookup ${TRACE_ORIGINATORS_LOOKUP}`,
  },
  {
    name: ATTR_CATALOG_LOOKUP,
    seedQuery: `print svc="__init__", attr_name="__init__", n_spans_with_key=tolong(0) | export mode=overwrite description="Cribl APM - attr catalog init" to lookup ${ATTR_CATALOG_LOOKUP}`,
  },
  {
    name: ERROR_RATE_HISTORY_LOOKUP,
    seedQuery: `print svc="__init__", d1_pct=todouble(0.0), d2_pct=todouble(0.0), d3_pct=todouble(0.0), d4_pct=todouble(0.0), d5_pct=todouble(0.0), d6_pct=todouble(0.0), d1_total=tolong(0), d2_total=tolong(0), d3_total=tolong(0), d4_total=tolong(0), d5_total=tolong(0), d6_total=tolong(0) | export mode=overwrite description="Cribl APM - error rate history init" to lookup ${ERROR_RATE_HISTORY_LOOKUP}`,
  },
  {
    name: INCIDENTS_LOOKUP,
    seedQuery: `print incident_id="__init__", svc="__init__", status="closed", severity="sev4", root_service="__init__", opened_at=tolong(0), last_fire_at=tolong(0), title="__init__" | export mode=overwrite description="Cribl APM - incidents init" to lookup ${INCIDENTS_LOOKUP}`,
  },
  {
    // Was missing from the seed list until v0.10.2 — traceable via
    // `| lookup criblapm_op_baselines on op` in the latency anomaly
    // detector. Same failure shape as the other lookups: if the
    // baseline scheduled search hadn't yet run once at query time
    // the lookup was "Unknown". Fresh installs now boot with the
    // sentinel row present.
    name: OP_BASELINES_LOOKUP,
    seedQuery: `print svc="__init__", op="__init__", requests=tolong(0), p50_us=todouble(0.0), p95_us=todouble(0.0), p99_us=todouble(0.0) | export mode=overwrite description="Cribl APM - op baselines init" to lookup ${OP_BASELINES_LOOKUP}`,
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
  // Sentinel-first union — see prevWindowSummary() for the Cribl
  // planner quirk. Sentinel svc/op values cant collide with a real
  // service so lookup on op is unaffected.
  return `print svc="__sentinel__", op="__sentinel__", requests=tolong(0), p50_us=todouble(0.0), p95_us=todouble(0.0), p99_us=todouble(0.0)
    | union (
        ${base}
      )
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
  // Sentinel-first union — see prevWindowSummary() for the Cribl
  // planner quirk. root_svc="__sentinel__" never collides with a
  // real service so lookup on root_svc is unaffected.
  return `print root_svc="__sentinel__", type="unknown", total=tolong(0), n_browser=tolong(0), n_loadtest=tolong(0), n_probe=tolong(0), n_msg=tolong(0), n_name_user=tolong(0), n_name_service=tolong(0)
    | union (
        ${Q.traceOriginators()}
      )
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
function attrCatalogComputeQuery(): string {
  // Sample 500 spans. The bag_keys + mv-expand pass blows the row
  // count up by the per-span key count (~20). 5000 input was hitting
  // Cribl's `"Unexpected 'reset' signal"` on every run; 1000 still
  // failed; 500 alone wasn't enough either.
  //
  // Root cause turned out to be a Cribl planner bug: `mv-expand`
  // anywhere upstream of `| export to lookup` consistently fails the
  // `func:store` write stage, regardless of row count, lookup
  // schema, or whether mv-expand-output ever reaches the export.
  // We confirmed via MCP that ad-hoc queries with the same shape
  // succeed without the export, and ad-hoc queries without
  // mv-expand succeed WITH the export — only the combination fails.
  //
  // Workaround: split into two scheduled searches. This one runs
  // the mv-expand and lets its output land in $vt_results
  // (the standard scheduled-search cache). The companion
  // criblapm__attr_catalog_export search below reads $vt_results
  // and writes the lookup with no mv-expand in its pipeline.
  return Q.attrCatalog(500);
}

function attrCatalogExportQuery(): string {
  // Sentinel-first union — see prevWindowSummary() for rationale.
  // The $vt_results scan yields 0 rows until criblapm__attr_catalog
  // has produced its first result; putting the sentinel first
  // keeps the export tail running.
  return `print svc="__sentinel__", attr_name="__sentinel__", n_spans_with_key=tolong(0)
    | union (
        dataset="$vt_results"
        | where jobName == "criblapm__attr_catalog"
        | project svc, attr_name, n_spans_with_key
      )
    | export mode=overwrite
             description="Cribl APM - attribute name catalog"
             to lookup ${ATTR_CATALOG_LOOKUP}`;
}

/** 6-day per-service error-rate history snapshot. Runs once per
 * day; six of the seven days the previous version recomputed each
 * hour were immutable, so 23/24 of that work was wasted. */
function errorRateHistoryExportQuery(): string {
  // Sentinel-first union — see prevWindowSummary() for rationale.
  // Fresh install may not have 6 days of history yet; sentinel
  // guarantees the lookup CSV is populated regardless.
  return `print svc="__sentinel__", d1_pct=todouble(0.0), d2_pct=todouble(0.0), d3_pct=todouble(0.0), d4_pct=todouble(0.0), d5_pct=todouble(0.0), d6_pct=todouble(0.0), d1_total=tolong(0), d2_total=tolong(0), d3_total=tolong(0), d4_total=tolong(0), d5_total=tolong(0), d6_total=tolong(0)
    | union (
        ${Q.errorRateHistory()}
      )
    | export mode=overwrite
             description="Cribl APM - 6-day per-service error-rate history (yesterday..-6d), pivoted one row per svc"
             to lookup ${ERROR_RATE_HISTORY_LOOKUP}`;
}

/**
 * Incidents lookup export — copies the latest incident-state fold run
 * from $vt_results into the criblapm_incidents lookup (P4.4). Split
 * from the fold for the same reason as the attr catalog: one search
 * can either leave rows in $vt_results (the app's list read) or
 * consume them with an export, not both.
 *
 * The latest-jobId self-join keeps a slow or skipped fold run from
 * mixing two runs' rows into the lookup: $vt_results retains
 * keepLastN=2 runs, and jobId's fixed-width epoch-millis prefix makes
 * max(jobId) the newest. Closed incidents are dropped so a new fire on
 * their services opens a fresh incident (the state machine's "only a
 * closed incident lets a new fire open fresh" rule). No sort before
 * the export — `| sort` after a join pipeline can silently drop every
 * row (see skill.md), so when a service appears in two live incidents
 * the grouper's first-match `lookup on svc` picks arbitrarily.
 */
function incidentsExportQuery(): string {
  // Sentinel-first union — see prevWindowSummary() for the planner
  // quirk. The sentinel row is also what the grouper's lookup join
  // sees on a fresh install (svc="__init__" never matches).
  return `print incident_id="__init__", svc="__init__", status="closed", severity="sev4", root_service="__init__", opened_at=tolong(0), last_fire_at=tolong(0), title="__init__"
    | union (
        dataset="$vt_results"
        | where jobName == "criblapm__incidents_state"
        | join kind=inner (
            dataset="$vt_results"
            | where jobName == "criblapm__incidents_state"
            | summarize jobId=max(tostring(jobId))
          ) on jobId
        | where tostring(status) != "closed"
        | project incident_id=tostring(incident_id), svc=tostring(svc),
                  status=tostring(status), severity=tostring(severity),
                  root_service=tostring(root_service),
                  opened_at=tolong(opened_at), last_fire_at=tolong(last_fire_at),
                  title=tostring(title)
      )
    | export mode=overwrite
             description="Cribl APM - live incident membership (grouper join surface)"
             to lookup ${INCIDENTS_LOOKUP}`;
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
  // Alert-notify runs 2 minutes after the panels (1 after the
  // evaluator) so the firing events it selects are already committed.
  const notifyCronSchedule = cronSchedule.replace(/^\*\/(\d+)/, (_m: string, n: string) => `2-59/${n}`).replace(/^\* /, '2 ');
  // Incident pipeline (P4.4): grouper 3 min after the panels (2 after
  // the evaluator, so firing transitions are committed); the state
  // fold 1 min after the grouper; the lookup export rides the base
  // panel cadence, which fires 1 min after the fold.
  const incidentGrouperCron = cronSchedule.replace(/^\*\/(\d+)/, (_m: string, n: string) => `3-59/${n}`).replace(/^\* /, '3 ');
  const incidentFoldCron = cronSchedule.replace(/^\*\/(\d+)/, (_m: string, n: string) => `4-59/${n}`).replace(/^\* /, '4 ');
  const hourly = {
    enabled: true,
    cronSchedule: '0 * * * *',
    tz: 'UTC',
    keepLastN: 2,
  } as const;

  // Metric emitter window: minute-aligned (`@m`) and matched to the
  // cadence so consecutive scheduled runs cover DISJOINT bins. The
  // metrics store is NOT idempotent — re-emitting a bin double-counts
  // (validated 2026-07-23) — so the window must never overlap and
  // `latest=@m` (not `now`) so the partial current minute isn't counted
  // now and re-counted next run. See docs/metrics-migration-plan.md.
  const metricEmitEarliest = `-${getSearchCadence()}@m`;

  const plan: ProvisionedSearch[] = [
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
    {
      id: 'criblapm__error_propagation',
      name: 'Cribl APM - error propagation rollup',
      description:
        'Cribl APM: per-(trace_id, parent_span_id) rollup of error-status spans with a non-empty parent. Used by errorClassificationJoins (via opts.cachedPropagation = true) to skip the 3rd full-dataset scan that the inline path requires. Output stays in $vt_results, read by UI callers of rawRecentErrorSpans / serviceSummary. See HEURISTICS.md §"Error propagation detection".',
      query: Q.errorPropagationRollup(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...panelCadence },
    },
    // ── Alert pipeline: prev summary → immutable evaluator commit
    //
    // prev_summary maintains the comparison baseline. The evaluator
    // reads its prior state from immutable generated events, emits one
    // versioned snapshot per alert, and uses `export tee=true to search`
    // so that the exact committed rows also populate $vt_results for the
    // UI. No same-cron consumer can race a mutable state lookup.
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
        'Cribl APM: computes health and debounce state from the latest immutable evaluator event, exports a versioned snapshot to the dataset, and retains that exact commit in $vt_results via export tee=true to search.',
      query: Q.alertEvaluator(),
      // -15m window so fresh fault-injection bursts on low-traffic
      // services aren't diluted by healthy traffic from the prior
      // 53 minutes. Baseline (prev) is still -2h to -1h via the
      // criblapm_alert_prev lookup.
      earliest: '-15m',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...evalCadence },
    },
    {
      id: 'criblapm__alert_history',
      name: 'Cribl APM - alert history rollup',
      description:
        'Cribl APM: -7d rollup of alert firing/resolved transitions (the "Alert incidents" timeline). Read via $vt_results by the Alerts page instead of a live 24h search on every load; transitions are sparse curated events, so the wide window is cheap. See ROADMAP P4.5.',
      query: Q.alertHistory(2000, undefined, 'asc'),
      earliest: '-7d',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...panelCadence },
    },
    // ── Incident pipeline (P4.4 Phase 1) ────────────────────
    //
    // Alerts→incidents grouping + state fold, Cribl-Search-native
    // (works with the investigator off). See the builder docstrings
    // in queries.ts and docs/research/server-investigations/
    // incidents-and-lifecycle.md.
    {
      id: 'criblapm__incident_grouper',
      name: 'Cribl APM - incident grouper',
      description:
        'Cribl APM: groups firing alert transitions into incidents (attach via the criblapm_incidents lookup + dependency-graph adjacency, else open a new time-binned incident) and appends opened/attached incident events to the dataset. Deterministic event ids + leftanti dedup make re-runs no-ops. Runs 3 min after the panels so the evaluator commit is visible.',
      query: Q.incidentGrouper(),
      earliest: '-30m',
      latest: 'now',
      sampleRate: 1,
      schedule: {
        enabled: true,
        cronSchedule: incidentGrouperCron,
        tz: 'UTC',
        keepLastN: 2,
      },
    },
    {
      id: 'criblapm__incidents_state',
      name: 'Cribl APM - incidents state fold',
      description:
        'Cribl APM: incrementally folds incident events into the current read model — one row per (incident_id, svc) with derived status/severity (human events win). Merges its own previous $vt_results output with a -1h event delta (high-water dedup) instead of replaying history, keeping every dataset scan short. Read via $vt_results by the Incidents list; the companion export search copies non-closed rows into the criblapm_incidents lookup.',
      query: Q.incidentStateFold(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: {
        enabled: true,
        cronSchedule: incidentFoldCron,
        tz: 'UTC',
        keepLastN: 2,
      },
    },
    {
      id: 'criblapm__incidents_export',
      name: 'Cribl APM - incidents lookup export',
      description:
        'Cribl APM: copies the latest incidents state-fold run from $vt_results into the criblapm_incidents lookup (non-closed rows only) so the grouper can attach follow-on fires. Split from the fold because a search cannot both leave rows in $vt_results and export them.',
      query: incidentsExportQuery(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...panelCadence },
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
        'Cribl APM: pre-computed metric name catalog with sample counts and service coverage. Reads the _metric field on each generic_metrics record and summarizes by name. Read via $vt_results by the Metrics page picker. Hourly cadence — metric names rarely appear/disappear within an hour.',
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
    //
    // Two-step pipeline because `mv-expand` upstream of `| export
    // to lookup` triggers a Cribl planner bug (see comments in
    // attrCatalogComputeQuery). Step 1 computes the catalog and
    // lets the result land in $vt_results. Step 2, scheduled 2
    // minutes later, reads $vt_results and writes the lookup with
    // no mv-expand in the export pipeline.
    {
      id: 'criblapm__attr_catalog',
      name: 'Cribl APM - attribute name catalog compute',
      description:
        'Cribl APM: enumerates the attribute names observed on spans per service via bag_keys + mv-expand on a recent sample. Result lands in $vt_results; companion criblapm__attr_catalog_export writes the lookup.',
      query: attrCatalogComputeQuery(),
      earliest: '-5m',
      latest: 'now',
      sampleRate: 1,
      // Hourly is enough — attribute names don't change minute to
      // minute, and the bag_keys+mv-expand pass is per-row expensive.
      schedule: { ...hourly },
    },
    {
      id: 'criblapm__attr_catalog_export',
      name: 'Cribl APM - attribute name catalog export',
      description:
        'Cribl APM: reads the latest criblapm__attr_catalog run from $vt_results and writes the criblapm_attr_catalog lookup. Split from the compute step to work around the mv-expand → export-to-lookup planner bug.',
      query: attrCatalogExportQuery(),
      earliest: '-10m',
      latest: 'now',
      sampleRate: 1,
      // Runs 2 minutes after the compute step so its $vt_results
      // are written.
      schedule: { ...hourly, cronSchedule: '2 * * * *' },
    },
    // ── Deploy / change correlation events (P2.2 phase 1) ───
    //
    // Detects new (service.name, service.version) tuples and emits
    // a criblapm_deploy event to the dataset via `export to search`. Read-side
    // surfaces (Investigator context, Service Detail markers,
    // "deployed Nm before alert" chip in Detected Issues) land in
    // follow-up PRs. Cadence: every 30 min so a fresh deploy
    // becomes correlatable within at most 30 minutes — fast enough
    // for the "what changed?" RCA question without taxing workers.
    {
      id: 'criblapm__deploy_events',
      name: 'Cribl APM - deploy change correlation events',
      description:
        'Cribl APM: detects new (service.name, service.version) tuples in the last hour and emits criblapm_deploy events via `export to search` so the deploy history is searchable from the dataset. Read by Investigator context and (eventually) Service Detail RED-chart markers.',
      query: Q.deployEventsSend(),
      earliest: '-1h',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...hourly, cronSchedule: '*/30 * * * *' },
    },
    // ── Noise budget (P1.1) ─────────────────────────────────
    //
    // Aggregates transition snapshots emitted by criblapm__home_alerts
    // into per-(svc, day) fire counts. Read at provision-time by `npm run eval` to
    // include "fires-per-week on flag-off traffic" alongside scenario
    // recall, so threshold changes are accepted only when both
    // numbers move in the right direction. Daily cadence — the
    // aggregation is over completed days and is immutable once the
    // day has passed.
    {
      id: 'criblapm__noise_budget',
      name: 'Cribl APM - alert noise budget',
      description:
        'Cribl APM: counts alert-firing events per (service, day) over the last 7 days, separating persistent fires (real problems) from noisy fires (over-sensitive thresholds). Read by the eval harness as the acceptance metric for threshold changes (P1.1). Output in $vt_results; runs daily at 00:35 UTC.',
      query: Q.noiseBudgetByService(),
      earliest: '-7d',
      latest: 'now',
      sampleRate: 1,
      schedule: { ...hourly, cronSchedule: '35 0 * * *' },
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

  // ── Span-derived metric emitters (M3) ───────────────────────
  //
  // Gated behind metricsEmit (default off). When on, these `export to
  // metrics` scheduled searches feed the fast PromQL store, which the
  // dark dual-read seam (metricsRead) will eventually serve RED panels
  // from — taking those reads off the search worker pool. Additive:
  // they run alongside the $vt_results caches, so turning emit on is
  // safe and reversible. See docs/metrics-migration-plan.md.
  if (getMetricsEmit()) {
    plan.push(
      {
        id: 'criblapm__metric_requests',
        name: 'Cribl APM - request and error metric emitter',
        description:
          'Cribl APM: emits criblapm_requests_total (per-minute DELTA counter, labels svc + outcome∈{ok,error}) to the fast metrics store via `export to metrics`. Read totals with sum_over_time — NOT rate() (delta storage). Minute-aligned non-overlapping window (store is not idempotent).',
        query: Q.metricRequestsExport(),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      },
      // NOTE: criblapm_request_duration_ms (per-span latency histogram) is
      // no longer emitted — every latency read migrated to the precomputed
      // percentile GAUGES below (fast + correct for bimodal latency). The
      // histogram was the heaviest emitter (only per-span export) and now
      // unread, so it's dropped. Same for the edge/messaging duration
      // histograms further down.
      {
        id: 'criblapm__metric_edge_calls',
        name: 'Cribl APM - RPC edge call metric emitter',
        description:
          'Cribl APM: emits criblapm_edge_calls_total (counter, labels parent + child + outcome) via the parent_span_id self-join. Drives the System Architecture graph. Heaviest emitter (self-join) but incremental-window only.',
        query: Q.metricEdgeCallsExport(),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      },
      {
        id: 'criblapm__metric_edge_lat_p95',
        name: 'Cribl APM - RPC edge latency p95 gauge emitter',
        description:
          'Cribl APM: emits criblapm_edge_latency_ms (gauge, labels parent + child + quantile="p95") = percentile(dur_ms, 95) per edge per minute. Replaces the edge-duration histogram read.',
        query: Q.metricEdgeLatencyP95Export(),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      },
      {
        id: 'criblapm__metric_messaging',
        name: 'Cribl APM - messaging edge metric emitter',
        description:
          'Cribl APM: emits criblapm_messaging_total (counter, labels svc + dest + op + system + outcome) for kafka/messaging edges. Read side pairs producer/consumer per topic.',
        query: Q.metricMessagingExport(),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      },
      {
        id: 'criblapm__metric_msg_lat_p95',
        name: 'Cribl APM - messaging latency p95 gauge emitter',
        description:
          'Cribl APM: emits criblapm_msg_latency_ms (gauge, labels svc + dest + op + system + quantile="p95") = percentile(dur_ms, 95) per messaging edge per minute. Replaces the messaging-duration histogram read.',
        query: Q.metricMessagingLatencyP95Export(),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      },
      {
        id: 'criblapm__metric_status_class',
        name: 'Cribl APM - HTTP and gRPC status-class metric emitter',
        description:
          'Cribl APM: emits criblapm_status_class_total (counter, labels svc + status_class∈{ok,4xx,500,502,503,504,other_5xx,grpc_err}) for the Service Detail Status mix chart. Read with sum_over_time (delta storage).',
        query: Q.metricStatusClassExport(),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      },
    );

    // Precomputed latency-percentile GAUGES (p50/p95/p99), per service and
    // per operation. These replace the histogram_quantile reads, which were
    // slow AND wrong for bimodal latency. One search per (family, quantile).
    for (const { q, label } of LATENCY_QUANTILES) {
      plan.push({
        id: `criblapm__metric_req_lat_${label}`,
        name: `Cribl APM - request latency ${label} gauge emitter`,
        description:
          `Cribl APM: emits ${METRIC_REQUEST_LATENCY_MS} (gauge, labels svc + quantile="${label}") = percentile(dur_ms, ${q}) of entry spans per svc per minute. Read as a gauge (fast + accurate) instead of histogram_quantile.`,
        query: Q.metricLatencyPercentileExport(q),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      });
      plan.push({
        id: `criblapm__metric_op_lat_${label}`,
        name: `Cribl APM - operation latency ${label} gauge emitter`,
        description:
          `Cribl APM: emits ${METRIC_OP_LATENCY_MS} (gauge, labels svc + operation + quantile="${label}") = percentile(dur_ms, ${q}) per (svc, operation) per minute. Powers the Top Operations table.`,
        query: Q.metricLatencyPercentileExport(q, { byOperation: true }),
        earliest: metricEmitEarliest,
        latest: '@m',
        sampleRate: 1,
        schedule: { ...panelCadence },
      });
    }
  }

  // ── Server-side investigation trigger ───────────────────────────
  //
  // Gated behind serverInvestigations (default off). Selects firing
  // alerts in the last 15m and fires the investigator-cell webhook
  // (CELL_WEBHOOK_TARGET_ID, provisioned by scripts/provision.ts) with
  // the rows inlined. The cell builds a seed from each row and dedupes
  // on event_id. Off ⇒ this search doesn't exist, so nothing ever
  // fires at the cell — that's the feature's provision-time on/off.
  if (getServerInvestigations()) {
    plan.push({
      id: 'criblapm__alert_notify',
      name: 'Cribl APM - alert notify server investigations',
      description:
        'Cribl APM: firing alerts in the last 15m; fires the investigator-cell webhook to auto-investigate. Gated behind serverInvestigations. Runs 2 min after the evaluator so firing events are committed.',
      query: Q.alertNotify(),
      earliest: '-15m',
      latest: 'now',
      sampleRate: 1,
      schedule: {
        enabled: true,
        cronSchedule: notifyCronSchedule,
        tz: 'UTC',
        keepLastN: 2,
        // Structure mirrors a known-good Cribl saved-search notification
        // exactly. The API SILENTLY stores `{}` (dropping the whole
        // notification) if any of these are missing: a unique `items[].id`,
        // `items[].disabled`, `conf.savedQueryId`, and `targetConfigs[].id`.
        notifications: {
          disabled: false,
          items: [
            {
              disabled: false,
              condition: 'search',
              targets: [CELL_WEBHOOK_TARGET_ID],
              conf: {
                triggerType: 'resultsCount',
                triggerComparator: '>',
                triggerCount: 0,
                savedQueryId: 'criblapm__alert_notify',
                message: 'Cribl APM: firing alert(s) — triggering server-side investigation.',
              },
              targetConfigs: [
                {
                  id: CELL_WEBHOOK_TARGET_ID,
                  conf: { includeResults: true, attachmentType: 'inline' },
                },
              ],
              group: 'default_search',
              id: 'criblapm__alert_notify_Notification_1',
            },
          ],
        },
      },
    });
  }

  return plan;
}

/**
 * The metric emitter (id, query) pairs, in provisioning order. Shared by
 * the provisioning plan (above) and the backfill runner
 * (src/api/metricsBackfill.ts) so both emit the exact same KQL. Kept in
 * sync with the plan entries by a unit test.
 */
/**
 * Emitter registry for BACKFILL — carries each metric's name (for the
 * coverage probe), aggregation kind (window strategy), and the query to run
 * (histograms use the SAMPLED variant; counters/joins run full). The live
 * scheduled searches are defined separately above and stay unsampled.
 */
export function getMetricEmitters(): BackfillEmitter[] {
  // Duration histograms are no longer emitted/read — RED latency comes from
  // the precomputed percentile gauges below.
  return [
    { id: 'criblapm__metric_requests', metricName: METRIC_REQUESTS_TOTAL, kind: 'counter', backfillQuery: Q.metricRequestsExport() },
    { id: 'criblapm__metric_edge_calls', metricName: METRIC_EDGE_CALLS_TOTAL, kind: 'counter', backfillQuery: Q.metricEdgeCallsExport() },
    { id: 'criblapm__metric_messaging', metricName: METRIC_MESSAGING_TOTAL, kind: 'counter', backfillQuery: Q.metricMessagingExport() },
    { id: 'criblapm__metric_status_class', metricName: METRIC_STATUS_CLASS_TOTAL, kind: 'counter', backfillQuery: Q.metricStatusClassExport() },
    // Latency-percentile gauges: aggregated (percentile-per-minute) emit, so
    // they backfill like counters (big windows). The coverage probe uses
    // `count()` — a gauge, not a histogram, so the counter path is correct.
    ...LATENCY_QUANTILES.flatMap(({ q, label }) => [
      { id: `criblapm__metric_req_lat_${label}`, metricName: `${METRIC_REQUEST_LATENCY_MS}{quantile="${label}"}`, kind: 'counter' as const, backfillQuery: Q.metricLatencyPercentileExport(q) },
      { id: `criblapm__metric_op_lat_${label}`, metricName: `${METRIC_OP_LATENCY_MS}{quantile="${label}"}`, kind: 'counter' as const, backfillQuery: Q.metricLatencyPercentileExport(q, { byOperation: true }) },
    ]),
    { id: 'criblapm__metric_edge_lat_p95', metricName: `${METRIC_EDGE_LATENCY_MS}{quantile="p95"}`, kind: 'counter', backfillQuery: Q.metricEdgeLatencyP95Export() },
    { id: 'criblapm__metric_msg_lat_p95', metricName: `${METRIC_MSG_LATENCY_MS}{quantile="p95"}`, kind: 'counter', backfillQuery: Q.metricMessagingLatencyP95Export() },
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
