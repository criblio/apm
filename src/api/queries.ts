/**
 * KQL query builders for the Jaeger-clone views.
 *
 * Every query targets the current dataset (see api/dataset.ts). The dataset
 * is injected via datasetBase() rather than a baked-in constant so the
 * Settings page can switch it at runtime without a reload.
 *
 * Spans are identified by isnotnull(end_time_unix_nano).
 */
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import { streamFilterKqlClause, streamFilterSpanKqlClause } from './streamFilter';
import { getLowVolumeMode } from './lowVolumeMode';
import {
  METRIC_REQUESTS_TOTAL,
  METRIC_REQUEST_DURATION_MS,
  METRIC_EDGE_CALLS_TOTAL,
  METRIC_EDGE_DURATION_MS,
  METRIC_MESSAGING_TOTAL,
  METRIC_MESSAGING_DURATION_MS,
  METRIC_STATUS_CLASS_TOTAL,
  METRIC_REQUEST_LATENCY_MS,
  METRIC_OP_LATENCY_MS,
  METRIC_EDGE_LATENCY_MS,
  METRIC_MSG_LATENCY_MS,
} from './metricNames';
import { DEFAULT_FILTER_RULES, compileFilterRulesToKql } from './errorFilter';
import {
  ALERT_EVENT_DATATYPE,
  DEPLOY_EVENT_DATATYPE,
  GENERATED_EVENT_SCHEMA_VERSION,
  INCIDENT_GROUPER_PRODUCER,
  eventIdExpr,
  generatedDatatypePredicate,
} from './generatedEventContract';
import {
  assertKqlPredicate,
  kqlBracketField,
  kqlDatasetId,
  kqlFieldKey,
  kqlFiniteNumber,
  kqlInteger,
  kqlStringLiteral,
  kqlTraceId,
} from './kqlSafety';

function quoteDataset(): string {
  return kqlDatasetId(getCurrentDataset());
}

function datasetClause(): string {
  return `dataset="${quoteDataset()}"`;
}

/**
 * KQL predicate that keeps only the spans a service handles as a request
 * ENTRY POINT: inbound SERVER spans (kind 2 — HTTP/gRPC) and CONSUMER
 * spans (kind 5 — message processing). Excludes CLIENT (3), PRODUCER (4),
 * and INTERNAL (1) spans, which are outbound calls or sub-operations.
 *
 * Without this, RED "duration" and "requests" aggregate EVERY span kind,
 * so services with many fast client spans read far too low — e.g.
 * checkout's true server p95 is ~4.4s but the all-spans p95 was ~0.28s
 * (its 14k client spans @ 277ms swamped its 1.4k server spans). Scoping to
 * entry-point spans makes duration = request-handling latency and requests
 * = inbound request count, which is the RED convention. Kinds are stored
 * numerically (`tostring(kind)` → "2"/"5"). Pure consumers (accounting,
 * fraud-detection) have only kind 5, so CONSUMER must be included.
 */
function entrySpanKindClause(): string {
  return `| where tostring(kind) in ("2", "5")`;
}

const HEX_DIGITS = '0123456789abcdef';

/**
 * Deterministic per-span sampling clause for BACKFILL histogram emits. The
 * first hex char of `span_id` is uniformly distributed (verified ~1/16
 * each), so keeping spans whose first char falls in the first
 * `round(rate*16)` hex digits yields an unbiased `rate` sample. Percentiles
 * are preserved (the distribution SHAPE is unchanged by unbiased sampling),
 * only the per-bucket counts shrink — which is exactly what makes backfill
 * fast. `rate >= 1` (or ≤0) → no clause (full fidelity, used by the LIVE
 * scheduled searches). Must appear BEFORE `span_id` is projected away.
 */
function sampleFirstHexClause(rate: number): string {
  if (!(rate > 0) || rate >= 1) return '';
  const k = Math.min(16, Math.max(1, Math.round(rate * 16)));
  const chars = HEX_DIGITS.slice(0, k).split('').map((c) => `"${c}"`).join(', ');
  return `| where substring(tolower(tostring(span_id)), 0, 1) in (${chars})`;
}

function spansBase(): string {
  return `${datasetClause()} | where isnotnull(end_time_unix_nano)`;
}

/**
 * Field-access helpers — pick between the flat acceleration columns
 * (when the dataset-ruleset + acceleratedFields are provisioned,
 * see src/api/datasetProvisioner.ts) and the dotted-path fallbacks
 * for unprovisioned installs.
 *
 * Both paths return values of the same shape, so callers can
 * substitute the chosen expression into any predicate, projection,
 * group-by, or extend without re-shaping the rest of the query.
 *
 * Default is the dotted path so unprovisioned installs keep
 * working; callers that have already probed via featureDetect can
 * opt into the flat form by passing `flatFields: true`.
 */
export interface QueryOpts {
  /** When true, queries read top-level `service_name` / `status_code`
   *  instead of the dotted nested paths. Caller is responsible for
   *  having confirmed the fields are populated (see featureDetect). */
  flatFields?: boolean;
  /**
   * When true, `errorClassificationJoins()` (and queries that
   * transitively use it — \`rawRecentErrorSpans\`, \`serviceSummary\`)
   * reads the propagation rollup from \`$vt_results\` of the
   * \`criblapm__error_propagation\` scheduled search instead of
   * computing it inline. Cuts one full-dataset scan out of the
   * 3-scan join graph.
   *
   * UI callers should pass \`true\` — the staleness window of the
   * scheduled search (~5 min) is well within the freshness budget
   * for the Errors / Service Detail panels. Scheduled-search
   * callers leave the default \`false\` to keep the inline path,
   * avoiding a circular dependency on a search that runs on a
   * different cadence.
   */
  cachedPropagation?: boolean;
}

function svcExpr(opts?: QueryOpts): string {
  return opts?.flatFields
    ? `service_name`
    : `tostring(resource.attributes['service.name'])`;
}

function statusCodeExpr(opts?: QueryOpts): string {
  return opts?.flatFields
    ? `tostring(status_code)`
    : `tostring(status.code)`;
}

/**
 * Pushdown-friendly error predicate. Used in `| where` clauses
 * placed BEFORE the per-row `extend` block — the engine then
 * eliminates non-error spans using the indexed `status_code`
 * column (when accelerated) before any per-row work happens. For
 * a workspace with 1% error rate this is roughly a 100× reduction
 * in the work done by downstream extends / projections.
 *
 * The flat form drops the `tostring()` wrapper because
 * `status_code` is stored as a string in the accelerated column —
 * leaving the predicate on the raw column lets Cribl push it
 * down. The dotted form keeps `tostring()` because `status.code`
 * is a nested-object access that needs coercion.
 */
function errorPredicate(opts?: QueryOpts): string {
  return opts?.flatFields
    ? `status_code == "2"`
    : `tostring(status.code) == "2"`;
}

/**
 * Shared KQL fragment that joins each span to its trace's root, looks
 * up the originator classification, and detects propagation. Output
 * columns added by this fragment, on top of whatever the caller
 * already projected:
 *   trace_origin     ('user' | 'service' | 'unknown')
 *   root_svc         (string)
 *   has_error_child  (bool)
 *
 * The caller must have already projected `trace_id` and `sid`
 * (= span_id as string) before piping into this fragment.
 *
 * Right side of both joins is small enough to dodge the Cribl KQL
 * leftouter truncation we hit in Phase 0 — trace_origins is one row
 * per captured trace, error_parents is pre-aggregated to one row
 * per (trace_id, parent_span_id) pair.
 *
 * Used by both `rawRecentErrorSpans` (display) and `serviceSummary`
 * / `prevWindowSummary` (metrics) so a single change to the
 * heuristic flows to alerts and panel together. See
 * docs/research/error-filter-design.md + HEURISTICS.md.
 */
/**
 * The propagation half of errorClassificationJoins, as a standalone
 * query: scans every span, identifies error-status spans with a
 * non-empty parent, rolls up to (trace_id, child_parent) counts.
 *
 * Used by:
 *   - The `criblapm__error_propagation` scheduled search (computes
 *     the rollup, output lands in $vt_results for live consumers).
 *   - errorClassificationJoins, conditionally, when the caller is
 *     OK with the inline path. Most UI callers want the cached path
 *     (read from $vt_results) instead — it's the same data without
 *     the scan cost.
 */
export function errorPropagationRollup(opts?: QueryOpts): string {
  // Predicate pushed before extend so the accelerated status_code
  // column does the heavy filter, same as rawRecentErrorSpans.
  return `${spansBase()}
    | where ${errorPredicate(opts)}
    | extend child_parent=tostring(parent_span_id)
    | where isnotempty(child_parent)
    | summarize n_error_children=count() by trace_id, child_parent`;
}

function errorClassificationJoins(opts?: QueryOpts): string {
  const propagationJoin = opts?.cachedPropagation
    ? `
    | join kind=leftouter (
        dataset="$vt_results"
        | where jobName == "criblapm__error_propagation"
        | project trace_id, child_parent, n_error_children
      ) on trace_id, $left.sid == $right.child_parent`
    : `
    | join kind=leftouter (
        ${errorPropagationRollup(opts)}
      ) on trace_id, $left.sid == $right.child_parent`;
  return `
    | join kind=leftouter (
        ${spansBase()}
        | where tostring(parent_span_id) == ""
        | extend root_svc=${svcExpr(opts)}
        | project trace_id, root_svc
        | lookup criblapm_trace_originators on root_svc
      ) on trace_id
    | extend trace_origin=coalesce(type, "unknown")${propagationJoin}
    | extend has_error_child=isnotnull(n_error_children)`;
}

/**
 * KQL boolean expression that returns `true` for spans the default
 * filter rules would drop. Compiled once at module load — adding a
 * default rule in errorFilter.ts automatically flows here. See
 * HEURISTICS.md for the cross-layer consistency principle.
 *
 * References columns produced by `errorClassificationJoins()` plus
 * the `http_status` / `grpc_status` / `span_kind` columns the
 * caller is expected to project.
 */
const DEFAULT_FILTER_KQL = compileFilterRulesToKql(DEFAULT_FILTER_RULES);

/**
 * Metrics base: Cribl tags OTel metric records with
 * `datatype == "generic_metrics"`. That's the cleanest single filter
 * to separate them from spans and logs in the same dataset. Metric
 * records have a flat shape:
 *   - `_metric` — metric name
 *   - `_value` — numeric value (mean for histograms, latest for gauges,
 *     cumulative for counters)
 *   - `_time` — timestamp
 *   - `['service.name']` / `['host.name']` / ... — resource attributes
 *     at the TOP LEVEL, not nested under resource.attributes like
 *     spans and logs. Use the bracket-quoted syntax to access them.
 */
function metricsBase(): string {
  return `${datasetClause()} | where datatype == "generic_metrics"`;
}

/** Bracket-quoted field reference for wide-column metric names. */
function mf(metric: string): string {
  return kqlBracketField(metric);
}

/** All distinct service names. */
export function services(opts?: QueryOpts): string {
  return `${spansBase()}
    | extend svc=${svcExpr(opts)}
    | summarize by svc
    | sort by svc asc`;
}

/** Operations for a given service. */
export function operations(service: string, opts?: QueryOpts): string {
  const s = kqlStringLiteral(service);
  return `${spansBase()}
    | extend svc=${svcExpr(opts)}
    | where svc==${s}
    | summarize by name
    | sort by name asc`;
}

export interface FindTracesParams {
  service?: string;
  operation?: string;
  tags?: string; // free-form "key=value key2=value2"
  /** Pre-built KQL predicate composed with the rest of the per-span
   *  filters via `and`. Used by the typed FilterBuilder and the raw
   *  KqlEditor escape hatch on SearchPage. */
  predicateKql?: string;
  minDurationUs?: number; // microseconds (trace-level)
  maxDurationUs?: number; // microseconds (trace-level)
  limit?: number;
  opts?: QueryOpts;
}

/**
 * Find traces where the chosen service / operation participates (any depth,
 * not just the root). Returns one row per matching trace_id with the
 * earliest timestamp seen for that trace, sorted by recency.
 *
 * The caller follows up with traceSpans() for these IDs and computes the
 * actual root span client-side. This matches Jaeger's "find traces" semantics
 * — Jaeger lets you search by participating service even when that service
 * is not the root of the trace.
 */
export function findTraces(params: FindTracesParams): string {
  // Per-span filters — applied BEFORE the summarize. These match "traces
  // where a span with this (service, operation, tag) participated."
  const spanFilters: string[] = [];

  if (params.service) {
    spanFilters.push(`svc==${kqlStringLiteral(params.service)}`);
  }
  if (params.operation) {
    spanFilters.push(`name==${kqlStringLiteral(params.operation)}`);
  }

  // Tag filters: "error=true http.status_code=500"
  if (params.tags) {
    for (const pair of params.tags.split(/\s+/).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const k = kqlFieldKey(pair.slice(0, eq));
      const v = kqlStringLiteral(pair.slice(eq + 1));
      spanFilters.push(`tostring(attributes${kqlBracketField(k)})==${v}`);
    }
  }

  // Pre-built KQL predicate from FilterBuilder + KqlEditor on
  // SearchPage. Wrapped in parens so any internal `and`/`or` doesn't
  // bind across the surrounding spanFilters.join().
  if (params.predicateKql && params.predicateKql.trim()) {
    spanFilters.push(`(${assertKqlPredicate(params.predicateKql)})`);
  }

  // Trace-level filters — applied AFTER the summarize. Duration is the
  // full (max_end − min_start) window of the spans that survived the per-span
  // filter, matching Jaeger's semantics ("traces where X took ≥ N ms").
  const traceFilters: string[] = [];
  if (params.minDurationUs != null) {
    traceFilters.push(`trace_dur_us >= ${kqlFiniteNumber(params.minDurationUs, { min: 0 })}`);
  }
  if (params.maxDurationUs != null) {
    traceFilters.push(`trace_dur_us <= ${kqlFiniteNumber(params.maxDurationUs, { min: 0 })}`);
  }

  const spanWhere = spanFilters.length ? `| where ${spanFilters.join(' and ')}` : '';
  const traceWhere = traceFilters.length ? `| where ${traceFilters.join(' and ')}` : '';
  const lim = kqlInteger(params.limit ?? 20, { min: 1, max: 10_000 });

  return `${spansBase()}
    | extend svc=${svcExpr(params.opts)}
    ${spanWhere}
    | summarize first_seen=min(_time),
                trace_start_ns=min(start_time_unix_nano),
                trace_end_ns=max(end_time_unix_nano)
      by trace_id
    | extend trace_dur_us=(toreal(trace_end_ns)-toreal(trace_start_ns))/1000.0
    ${traceWhere}
    | sort by first_seen desc
    | limit ${lim}`;
}

/**
 * Get all spans for a set of trace IDs. Used both for search result expansion
 * and the single-trace detail view.
 */
export function traceSpans(traceIds: string[], opts?: QueryOpts): string {
  if (traceIds.length === 0 || traceIds.length > 1_000) {
    throw new Error('traceSpans requires between 1 and 1000 trace IDs');
  }
  const inList = traceIds.map((id) => kqlStringLiteral(kqlTraceId(id))).join(', ');
  return `${spansBase()}
    | where trace_id in (${inList})
    | project _time, trace_id, span_id, parent_span_id, name, kind,
              start_time_unix_nano, end_time_unix_nano,
              attributes, events, links,
              status_code=${statusCodeExpr(opts)}, status_message=tostring(status.message),
              service_name=${svcExpr(opts)},
              resource_attributes=resource.attributes
    | sort by start_time_unix_nano asc`;
}

/**
 * Per-service summary aggregated over the whole time window: request count,
 * error count, duration percentiles. Powers the Home page service catalog.
 *
 * Optional `service` filter: when set, scope the query to a single
 * service BEFORE the summarize step. ServiceDetailPage uses this
 * (twice — current + previous window) and only cares about one row;
 * without the filter, each call reads and aggregates every span in
 * the dataset, which becomes very slow under load (tens of seconds
 * during kafka/flood scenarios). With the filter, the scan is
 * proportional to just that service's traffic.
 *
 * Applies the span-level stream filter (dropping spans > 30s) when
 * enabled, so streaming and idle-wait spans don't distort the
 * service percentiles. See api/streamFilter.ts.
 */
/**
 * Branch-B subquery: filtered error counts per service, computed by
 * scanning ONLY is_error=true spans through the trace-origin +
 * has-error-child joins. Result joins back to branch A on svc.
 *
 * Why split: the joins inside `errorClassificationJoins()` scan all
 * spans in the right side. Applied to the full span set (branch A),
 * the work was triple — one primary scan plus the two inside the
 * leftouter subqueries. On the previous-window query (-2h to -1h,
 * ~200K spans) the triple-scan was hitting Cribl's resource ceiling
 * and the search was failing with `"Unexpected 'reset' signal"` on
 * every run. Restricting the joins to the error subset (typically
 * <5% of spans) gets the same answer with a fraction of the work.
 */
function filteredErrorsBranch(svcFilter: string, opts?: QueryOpts): string {
  // Predicate pushed BEFORE the extend block — same rationale as
  // rawRecentErrorSpans. The svc filter follows immediately so
  // both pushdowns can fire on the indexed columns.
  return `${spansBase()}
    | where ${errorPredicate(opts)}
    | extend svc=${svcExpr(opts)},
             span_kind=tostring(kind),
             http_status=toint(attributes['http.response.status_code']),
             grpc_status=toint(attributes['rpc.grpc.status_code']),
             sid=tostring(span_id)
    ${svcFilter}
    ${errorClassificationJoins(opts)}
    | extend counts_as_error = not(${DEFAULT_FILTER_KQL})
    | where counts_as_error
    | summarize filtered_errors=count() by svc`;
}

export function serviceSummary(service?: string, opts?: QueryOpts): string {
  const svcFilter = service
    ? `| where svc==${kqlStringLiteral(service)}`
    : '';
  // Two branches. Branch A counts requests + percentiles + raw
  // errors without ANY joins (fast). Branch B computes the
  // filter-rule-honoring error count by running the joins only
  // on is_error=true spans (small subset). Final left-outer
  // merge on svc; services with no filtered errors get 0.
  //
  // `errors` counts only spans that the default filter rules
  // would KEEP — propagation and user-trace caller-faults are
  // excluded so the error_rate this metric feeds (alert
  // evaluator → auto:error_rate alerts) agrees with what the
  // Home panel shows. See HEURISTICS.md.
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    ${svcFilter}
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                raw_errors=countif(is_error),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99),
                last_seen=max(_time)
      by svc
    | join kind=leftouter (
        ${filteredErrorsBranch(svcFilter, opts)}
      ) on svc
    | extend errors=coalesce(filtered_errors, tolong(0))
    | extend error_rate=iff(requests > 0, toreal(errors)/toreal(requests), 0.0)
    | project svc, requests, errors, raw_errors,
              p50_us, p95_us, p99_us, last_seen, error_rate
    | sort by requests desc`;
}

/**
 * Previous-window service summary — identical to serviceSummary()
 * but scheduled with earliest=-2h, latest=-1h so it captures the
 * window immediately before the current one. Exports to a lookup
 * so the alert evaluator can join against it without a pivot.
 */
export function prevWindowSummary(): string {
  // Same branch-split pattern as serviceSummary (see comment there
  // for the reasoning). The triple-scan version of this query was
  // failing on every scheduled run on staging — `"Unexpected
  // 'reset' signal"` from Cribl's lakehouse pipeline, almost
  // certainly because -2h to -1h is a wider span set than -1h to
  // now and the joins hit a resource ceiling. Limiting the joins
  // to is_error=true spans gets the same numbers with a fraction
  // of the work; validated via MCP at ~3.5s vs the failing
  // 60+ s monolithic.
  // Sentinel-first pattern: the sentinel is the base pipeline and
  // the real aggregation is unioned in as a branch. If we tried the
  // reverse (real pipeline first, sentinel unioned in) the Cribl
  // planner skips the `| export` tail whenever the base scan
  // returns 0 rows — verified against staging. Putting `print`
  // first guarantees 1 row reaches the export, so the CSV is
  // always created even on a fresh install whose otel dataset has
  // no spans yet.
  return `print svc="__sentinel__", prev_req=tolong(0), prev_err=tolong(0), prev_raw_err=tolong(0), prev_p95_us=todouble(0.0), prev_err_rate=todouble(0.0)
    | union (
        ${spansBase()}
        | extend svc=tostring(resource.attributes['service.name']),
                dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
                is_error=(tostring(status.code)=="2")
        ${streamFilterSpanKqlClause()}
        | summarize prev_req=count(),
                    prev_raw_err=countif(is_error),
                    prev_p95_us=percentile(dur_us, 95)
          by svc
        | join kind=leftouter (
            ${filteredErrorsBranch('')}
          ) on svc
        | extend prev_err=coalesce(filtered_errors, tolong(0))
        | extend prev_err_rate=iff(prev_req > 0, toreal(prev_err)/toreal(prev_req), 0.0)
        | project svc, prev_req, prev_err, prev_raw_err, prev_p95_us, prev_err_rate
      )
    | export mode=overwrite
             description="Cribl APM - previous window service summary"
             to lookup criblapm_alert_prev`;
}

/**
 * Join the latest immutable evaluator snapshot for each alert.  The previous
 * implementation joined a mutable lookup that three same-cron searches raced
 * to overwrite.  Snapshot events are append-only, and selecting the newest
 * event makes retry and queue order irrelevant.  Legacy transition rows are
 * accepted during the upgrade window; v1 evaluation rows are the steady-state
 * source of truth.
 */
function priorAlertStateJoin(): string {
  return `
    | join kind=leftouter (
        ${datasetClause()}
        | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
        | where isnull(is_canary) or tostring(is_canary) != "true"
        | where isnull(record_kind) or tostring(record_kind) == "evaluation"
        | where isnotempty(alert_id)
        | join kind=inner (
            ${datasetClause()}
            | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
            | where isnull(is_canary) or tostring(is_canary) != "true"
            | where isnull(record_kind) or tostring(record_kind) == "evaluation"
            | where isnotempty(alert_id)
            | summarize persisted_time=max(_time) by alert_id
          ) on alert_id
        | where _time == persisted_time
        | summarize persisted_evaluation_id=max(tostring(evaluation_id)),
                    persisted_status=max(tostring(alert_status)),
                    persisted_bad=max(tolong(consecutive_bad)),
                    persisted_good=max(tolong(consecutive_good)),
                    persisted_fire_count=max(tolong(fire_count))
          by alert_id
      ) on alert_id`;
}

/**
 * Alert evaluator and immutable commit. It computes health, joins the latest
 * persisted evaluator event, applies the state machine, then writes the exact
 * result rows back to the dataset with `| export tee=true to search`. The
 * export is the durable state/history write and `tee=true` makes those same
 * rows available in $vt_results for the UI. There is no second state-machine
 * execution or mutable state export for another same-cron job to race.
 *
 * Runs 1 minute after the summary searches so their results are
 * available.
 */
export function alertEvaluator(): string {
  const FIRE_AFTER = 2;
  const CLEAR_AFTER = 3;
  // Low-volume mode (P1.2): when on, inject a fourth detection
  // arm matching the older chaos-eval thresholds. Read at query-
  // build time so toggling requires a re-provision (the alert
  // search bakes in its KQL at scheduled-search creation).
  const lowVol = getLowVolumeMode();
  const lowVolArm = lowVol
    ? 'curr_errors >= 2 and curr_err_pct >= 1, "error_rate",\n               '
    : '';
  const lowVolBoolArm = lowVol
    ? 'or (curr_errors >= 2 and curr_err_pct >= 1)\n               '
    : '';

  // curr_* are computed DIRECTLY from spans over the search's
  // earliest window (-15m), NOT from home_service_summary's -1h
  // $vt_results. Why: a 7-min flag-on burst on a low-traffic
  // service was getting diluted by 53 minutes of healthy traffic
  // in the -1h window, dropping the error rate below the 1%
  // threshold even when the burst itself was much higher. The
  // -15m window keeps the signal fresh. Baseline (prev) stays on
  // the -1h lookup so the alert evaluator still compares against
  // a longer healthy reference.
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
             is_error=(tostring(status.code)=="2")
    | summarize curr_requests=toreal(count()),
                curr_errors=toreal(countif(is_error)) by svc
    | extend curr_error_rate=iff(curr_requests > 0, curr_errors/curr_requests, 0.0)
    | lookup criblapm_alert_prev on svc
    // Service-level p95 in a subquery join, NOT inline in the summarize
    // above: the baseline (prevWindowSummary) computes p95 with the
    // >30s streaming-span filter applied, so the current side must
    // match or services with idle-wait roots (accounting) would show
    // a fake 10x. The request/error counts above stay unfiltered —
    // changing them would silently shift months of threshold tuning.
    | join kind=leftouter (
        ${spansBase()}
        | extend svc=tostring(resource.attributes['service.name']),
                 dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
        ${streamFilterSpanKqlClause()}
        | summarize curr_p95_us=percentile(dur_us, 95) by svc
      ) on svc
    | extend prev_requests=iff(isnotnull(prev_req), toreal(prev_req), 0.0),
             prev_errors=iff(isnotnull(prev_err), toreal(prev_err), 0.0),
             prev_error_rate=iff(isnotnull(prev_err_rate), toreal(prev_err_rate), 0.0),
             curr_p95=iff(isnotnull(curr_p95_us), toreal(curr_p95_us), 0.0),
             prev_p95=iff(isnotnull(prev_p95_us), toreal(prev_p95_us), 0.0)
    | extend curr_err_pct=curr_error_rate * 100,
             prev_err_pct=prev_error_rate * 100,
             // is_persistent is informational — used by notification
             // logic to suppress repeat pings, NOT by detection.
             // A 25% error rate that's been 25% for an hour is still
             // a real problem that should be visible.
             is_persistent=(prev_error_rate * 100 >= 1 and (curr_error_rate * 100 - prev_error_rate * 100) < 2),
             // traffic_ratio normalizes to requests-per-minute so the
             // -15m curr window and -60m prev window compare on the
             // same scale. Without normalization a healthy service
             // would look like it's at 25% of prior traffic (15/60).
             traffic_ratio=iff(prev_requests >= 50,
                               (curr_requests / 15.0) / (prev_requests / 60.0),
                               1.0)
    // Three error_rate paths, tuned for production noise tolerance.
    // The prior ≥1% / ≥2-error floors were over-fit to chaos-
    // engineered eval scenarios (llmRateLimit, recommendationCache)
    // and fired on normal background error rates of real services.
    //   1. High absolute rate — ≥5% with ≥20 spans. Paging-worthy
    //      regardless of baseline.
    //   2. Sharp deviation from a stable baseline — current rate
    //      ≥3× prev AND ≥2% absolute AND prev window had ≥100
    //      requests (baseline is statistically meaningful).
    //   3. Catastrophic ramp on previously-clean service — ≥10
    //      errors when the prior window had effectively zero,
    //      gated on ≥50 current requests to distinguish "real
    //      service just broke" from low-volume background noise.
    // Tradeoff: silences chaos scenarios on ultra-low-volume
    // services (llmRateLimit / recommendationCache product-reviews).
    // The low-volume-mode setting (P1.2) re-enables an older arm
    // for those — opt-in only since it costs precision on noisier
    // workloads.
    // Service-level p95 regression arm (the P2 detection gap, found
    // 2026-08-18): the per-op latency arm's 250ms floor sat above
    // real regressions on fast services — recommendationCacheFailure
    // degrades recommendation from ~45ms to ~140ms p95 (3.5x, "both
    // chips fire" per FAILURE-SCENARIOS) and never alerted. Service
    // p95 over all spans runs lower than op-level entry-span p95, so
    // the floor here is 100ms with the same 3x ratio; volume gates
    // match the sharp-deviation error arm. Baseline caveat: prev is
    // the -2h..-1h window, so a degradation older than ~2h has
    // normalized into the baseline and only FRESH regressions fire.
    | extend signal_type=case(
               curr_requests == 0 and prev_requests >= 50, "silent",
               curr_err_pct >= 5 and curr_requests >= 20, "error_rate",
               curr_err_pct >= 2 and curr_err_pct >= prev_err_pct * 3
                 and prev_requests >= 100, "error_rate",
               curr_errors >= 10 and prev_errors < 1
                 and curr_requests >= 50, "error_rate",
               curr_p95 >= prev_p95 * 3 and curr_p95 >= 100000
                 and prev_p95 > 0 and curr_requests >= 20
                 and prev_requests >= 100, "latency",
               ${lowVolArm}traffic_ratio <= 0.5 and prev_requests >= 50, "traffic_drop",
               "none"),
             is_bad=(
               (curr_requests == 0 and prev_requests >= 50)
               or (curr_err_pct >= 5 and curr_requests >= 20)
               or (curr_err_pct >= 2 and curr_err_pct >= prev_err_pct * 3
                   and prev_requests >= 100)
               or (curr_errors >= 10 and prev_errors < 1
                   and curr_requests >= 50)
               or (curr_p95 >= prev_p95 * 3 and curr_p95 >= 100000
                   and prev_p95 > 0 and curr_requests >= 20
                   and prev_requests >= 100)
               ${lowVolBoolArm}or (traffic_ratio <= 0.5 and prev_requests >= 50))
    // alert_id is STABLE per service (doesn't include signal_type).
    // Why: when a service recovers, signal_type rotates from
    // "error_rate" → "none", so an signal_type-keyed alert_id
    // would change too. The state export uses mode=overwrite, so
    // the old "auto:error_rate:svc" row gets wiped before the
    // state machine ever sees prev_status="firing" on the new
    // "auto:none:svc" key — meaning the resolving→ok walk never
    // fires, no "resolved" event is emitted, and the Alert Timeline
    // shows the alert as "ongoing" forever. Stable key fixes this.
    | extend alert_id=strcat("auto:health:", svc),
             evaluation_id=strcat("criblapm-eval:", tostring(bin(now(), 5m)))
    ${priorAlertStateJoin()}
    | extend is_retry=iff(isnotnull(persisted_evaluation_id) and persisted_evaluation_id == evaluation_id, true, false),
             prev_status=iff(isnotnull(persisted_status), persisted_status, "ok"),
             prev_bad=iff(isnotnull(persisted_bad), persisted_bad, 0),
             prev_good=iff(isnotnull(persisted_good), persisted_good, 0),
             prev_fire_count=iff(isnotnull(persisted_fire_count), persisted_fire_count, 0)
    | extend new_bad=iff(is_bad, prev_bad + 1, 0),
             new_good=iff(is_bad, 0, prev_good + 1)
    | extend alert_status=case(
               is_bad and prev_status == "ok", "pending",
               is_bad and prev_status == "pending" and new_bad >= ${FIRE_AFTER}, "firing",
               is_bad and prev_status == "pending", "pending",
               is_bad and prev_status == "firing", "firing",
               is_bad and prev_status == "resolving", "firing",
               not(is_bad) and prev_status == "pending", "ok",
               not(is_bad) and prev_status == "firing", "resolving",
               not(is_bad) and prev_status == "resolving" and new_good >= ${CLEAR_AFTER}, "ok",
               not(is_bad) and prev_status == "resolving", "resolving",
               "ok"),
             consecutive_bad=new_bad,
             consecutive_good=new_good,
             fire_count=iff(is_bad and prev_status == "pending" and new_bad >= ${FIRE_AFTER}, prev_fire_count + 1, prev_fire_count),
             transitioned_to=case(
               is_bad and prev_status == "pending" and new_bad >= ${FIRE_AFTER}, "firing",
               not(is_bad) and prev_status == "resolving" and new_good >= ${CLEAR_AFTER}, "resolved",
               "")
    | project svc, curr_requests, curr_errors, curr_error_rate,
              prev_requests, prev_errors, prev_error_rate,
              alert_id, evaluation_id, is_retry,
              signal_type, is_bad, is_persistent,
              alert_status, consecutive_bad, consecutive_good,
              fire_count, transitioned_to
    | union (
        dataset="$vt_results"
        | where jobName == "criblapm__svc_operations"
        | project svc, op=name, curr_p95_us=toreal(p95_us), curr_requests=toreal(requests)
        | lookup criblapm_op_baselines on svc, op
        | extend prev_p95_us=iff(isnotnull(p95_us), toreal(p95_us), 0.0),
                 prev_op_requests=iff(isnotnull(requests), toreal(requests), 0.0)
        // Thresholds tuned for gradual-drift scenarios. The
        // 2026-05-31 third eval scored emailMemoryLeak at 0.30
        // with 5x ratio + 500ms floor — drift over 7 min didn't
        // get there. Loosened to 3x ratio + 250ms floor with a
        // 20-span volume gate to keep the noise tolerable. Item
        // 1e in ROADMAP.
        | where isnotnull(prev_p95_us) and prev_p95_us > 0
                and curr_p95_us >= prev_p95_us * 3
                and curr_p95_us >= 250000
                and prev_op_requests >= 20
        | extend alert_id=strcat("auto:latency:", svc, ":", op),
                 evaluation_id=strcat("criblapm-eval:", tostring(bin(now(), 5m))),
                 signal_type="latency",
                 is_bad=true,
                 is_persistent=false,
                 curr_errors=0.0, curr_error_rate=0.0,
                 prev_requests=prev_op_requests, prev_errors=0.0, prev_error_rate=0.0
        ${priorAlertStateJoin()}
        | extend is_retry=iff(isnotnull(persisted_evaluation_id) and persisted_evaluation_id == evaluation_id, true, false),
                 prev_status=iff(isnotnull(persisted_status), persisted_status, "ok"),
                 prev_bad=iff(isnotnull(persisted_bad), persisted_bad, 0),
                 prev_good=iff(isnotnull(persisted_good), persisted_good, 0),
                 prev_fire_count=iff(isnotnull(persisted_fire_count), persisted_fire_count, 0)
        | extend new_bad=prev_bad + 1, new_good=0
        | extend alert_status=case(
                   prev_status == "ok", "pending",
                   prev_status == "pending" and new_bad >= ${FIRE_AFTER}, "firing",
                   prev_status == "pending", "pending",
                   prev_status == "firing", "firing",
                   prev_status == "resolving", "firing",
                   "ok"),
                 consecutive_bad=new_bad,
                 consecutive_good=0,
                 fire_count=iff(prev_status == "pending" and new_bad >= ${FIRE_AFTER}, prev_fire_count + 1, prev_fire_count),
                 transitioned_to=iff(prev_status == "pending" and new_bad >= ${FIRE_AFTER}, "firing", "")
        | project svc, curr_requests, curr_errors, curr_error_rate,
                  prev_requests, prev_errors, prev_error_rate,
                  alert_id, evaluation_id, is_retry,
                  signal_type, is_bad, is_persistent,
                  alert_status, consecutive_bad, consecutive_good,
                  fire_count, transitioned_to
    )
    // A platform retry inside the same scheduled cadence bucket must not
    // advance the state machine again. The first successful send is already
    // durable; suppressing a retry at the producer is stronger than merely
    // deduplicating conflicting rows at each reader.
    | where not(is_retry)
    | extend evaluated_at=bin(now(), 5m),
             schema_version=tolong(${GENERATED_EVENT_SCHEMA_VERSION}),
             producer="criblapm__home_alerts", record_kind="evaluation",
             event_type=iff(transitioned_to != "", transitioned_to, "evaluated")
    | extend event_id=strcat("criblapm:alert:", evaluation_id, ":", alert_id)
    | project _time=now(), dataset="${quoteDataset()}",
              datatype="${ALERT_EVENT_DATATYPE}", schema_version,
              event_id, producer, record_kind, evaluation_id, evaluated_at,
              event_type, alert_id, alert_status, svc,
              signal_type, is_bad, is_persistent,
              curr_error_rate, prev_error_rate,
              curr_requests, prev_requests,
              fire_count, consecutive_bad, consecutive_good
    | export tee=true to search "${quoteDataset()}"`;
}

/** Transition history, deduplicated by stable event ID with legacy dual-read. */
export function alertHistory(
  limit = 500,
  service?: string,
  order: 'asc' | 'desc' = 'desc',
): string {
  const safeLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  const serviceFilter = service
    ? `| where svc == ${kqlStringLiteral(service)}`
    : '';
  const logicalId = eventIdExpr(['alert_id', '_time', 'event_type']);
  return `${datasetClause()}
    | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
    | where event_type in ("firing", "resolved")
    | where isnull(is_canary) or tostring(is_canary) != "true"
    ${serviceFilter}
    | extend logical_event_id=${logicalId}
    | summarize _time=max(_time)
      by logical_event_id, schema_version, evaluation_id, event_type,
         alert_id, alert_status, svc, signal_type, curr_error_rate,
         prev_error_rate, curr_requests, prev_requests, fire_count
    | project _time, event_id=logical_event_id, schema_version,
              evaluation_id, event_type, alert_id, alert_status,
              svc, signal_type, curr_error_rate, prev_error_rate,
              curr_requests, prev_requests, fire_count
    | sort by _time ${order}
    | limit ${safeLimit}`;
}

/**
 * Server-side investigation lifecycle events committed by the
 * investigator cell (record_kind='investigation'). The Alerts page
 * joins these to incidents by alert_id + time to render
 * "Investigating…"/"Investigated" badges and the drill-in link
 * (investigation_id). Latest event per investigation wins.
 */
export function investigationEvents(limit = 200, service?: string): string {
  const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  const serviceFilter = service
    ? `| where svc == ${kqlStringLiteral(service)}`
    : '';
  return `${datasetClause()}
    | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
    | where record_kind == "investigation"
    | where isnull(is_canary) or tostring(is_canary) != "true"
    ${serviceFilter}
    | summarize _time=max(_time)
      by event_id, schema_version, event_type, alert_id,
         investigation_id, trigger_event_id, svc, signal_type, conclusion
    | project _time, event_id, schema_version, event_type, alert_id,
              investigation_id, trigger_event_id, svc, signal_type, conclusion
    | sort by _time desc
    | limit ${safeLimit}`;
}

/**
 * Trigger query for the server-side investigator. Selects the firing
 * alert events in the search's window (run with `earliest=-15m`) and
 * projects exactly the fields the cell's `FiringAlert` / seed builder
 * need. The `criblapm__alert_notify` scheduled search runs this; when
 * it returns rows, its notification target POSTs them to the cell's
 * `/alerts/fire`, which dedupes on `event_id`. Canaries excluded.
 */
export function alertNotify(): string {
  return `${datasetClause()}
    | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
    | where record_kind == "evaluation"
    | where event_type == "firing"
    | where isnull(is_canary) or tostring(is_canary) != "true"
    | summarize _time=max(_time)
      by event_id, alert_id, svc, signal_type, curr_error_rate, fire_count
    | project event_id, alert_id, svc, signal_type, curr_error_rate, fire_count, _time
    | sort by _time desc
    | limit 50`;
}

// ── Incidents (P4.4 Phase 1) ─────────────────────────────────
//
// Alerts→incidents grouping + state fold, entirely Cribl-Search-
// native (no cell). Three cooperating scheduled searches (see
// provisionedSearches.ts):
//
//   1. incidentGrouper()   — appends opened/attached incident events
//   2. incidentStateFold() — folds events → one row per (incident, svc)
//                            in $vt_results (the app's list read)
//   3. incidents export    — copies the fold's non-closed rows into
//                            the criblapm_incidents lookup (the
//                            grouper's join surface)
//
// Design: docs/research/server-investigations/incidents-and-lifecycle.md.

/** An incident resolves when no member alert is bad and the last firing
 * transition is at least this old (guards flapping). */
export const INCIDENT_RESOLVE_DEBOUNCE_MIN = 10;
/** A resolved incident closes (archives) after this quiet period. Only a
 * closed incident lets a new fire open a fresh incident. */
export const INCIDENT_CLOSE_AFTER_HOURS = 24;
/** Fires with no live incident to attach to are grouped by this time
 * bin — one new incident per bin. Deliberately coarse: a cascade whose
 * services first fire within the same bin collapses to one incident
 * even before the grouping lookup has caught up. */
export const INCIDENT_OPEN_BIN = '15m';

/**
 * Shared grouper base: one row per firing transition in the window,
 * annotated with the incident it should attach to (direct membership
 * first, then single-hop graph adjacency) or, failing both, the
 * deterministic id of a new incident. Used by both event arms of
 * incidentGrouper() — same KQL-duplication pattern as the alert
 * evaluator's two arms.
 *
 * Attach path 2 (adjacency) resolves *neighbor → live incident* in a
 * subquery so the neighbor value can sit in a column literally named
 * `svc` for the `| lookup criblapm_incidents on svc` join, then
 * renames back to join against the fire row's own svc.
 */
function incidentGrouperBase(): string {
  return `${datasetClause()}
    | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
    | where record_kind == "evaluation" and event_type == "firing"
    | where isnull(is_canary) or tostring(is_canary) != "true"
    | extend svc=tostring(svc)
    | summarize fire_time=max(_time)
      by trigger_event_id=tostring(event_id), svc
    | lookup criblapm_incidents on svc
    | extend direct_incident_id=iff(isnotempty(incident_id) and tostring(incident_id) != "__init__",
                                    tostring(incident_id), "")
    | project fire_time, trigger_event_id, svc, direct_incident_id
    | join kind=leftouter (
        dataset="$vt_results"
        | where jobName == "criblapm__sysarch_dependencies"
        | project fire_svc=tostring(child), svc=tostring(parent)
        | union (
            dataset="$vt_results"
            | where jobName == "criblapm__sysarch_dependencies"
            | project fire_svc=tostring(parent), svc=tostring(child)
          )
        | lookup criblapm_incidents on svc
        | where isnotempty(incident_id) and tostring(incident_id) != "__init__"
        // Adjacency attaches only to OPEN incidents. A resolved-not-
        // closed incident stays reachable through its own members (a
        // member refire reopens it), but a mere graph neighbor firing
        // is a new problem, not a resurrection — observed live
        // 2026-08-19: a background frontend flap reopened the prior
        // night's resolved payment incident through adjacency.
        | where tostring(status) == "open"
        | summarize adj_incident_id=max(tostring(incident_id)) by fire_svc
        | project svc=fire_svc, adj_incident_id
      ) on svc
    | extend attach_incident_id=iff(isnotempty(direct_incident_id), direct_incident_id,
                                    iff(isnotnull(adj_incident_id), tostring(adj_incident_id), ""))
    | extend incident_id=iff(isnotempty(attach_incident_id), attach_incident_id,
                             strcat("inc:", tostring(bin(fire_time, ${INCIDENT_OPEN_BIN})))),
             is_new=isempty(attach_incident_id)`;
}

/**
 * Alerts→incidents grouping search. Appends `record_kind:'incident'`
 * events — `opened` (one per new incident) and `attached` (one per
 * firing transition) — through the same `export tee=true to search`
 * boundary as the evaluator. Every emitted event_id is deterministic
 * (derived from incident_id + the firing evaluation's event_id) and
 * the final leftanti join drops rows already committed, so re-runs
 * and platform retries over the same window are no-ops.
 *
 * Incident *resolution* is deliberately NOT an event here — the state
 * fold derives it from live alert state (all-clear + debounce). A
 * `resolved` notify event lands with P4.4 Phase 5.
 *
 * Runs a few minutes after the evaluator so firing transitions are
 * committed; earliest=-30m so a reprocessed fire always sees its own
 * prior emission inside the dedup subquery's window.
 */
export function incidentGrouper(): string {
  const ds = quoteDataset();
  return `${incidentGrouperBase()}
    | where is_new
    // opened — collapse same-bin fires into the one new incident. min(svc)
    // is a deterministic placeholder root; the fold recomputes root as the
    // first-firing member.
    | summarize fire_time=min(fire_time), root_service=min(svc),
                services=min(svc), alert_event_id=min(trigger_event_id)
      by incident_id
    | extend event_type="opened", status="open",
             title=strcat("Service health incident: ", root_service),
             event_id=strcat(incident_id, ":opened")
    | project fire_time, incident_id, event_id, event_type, status,
              root_service, services, alert_event_id, title
    | union (
        ${incidentGrouperBase()}
        | extend event_type="attached", status="", root_service="",
                 services=svc, alert_event_id=trigger_event_id, title="",
                 event_id=strcat(incident_id, ":attach:", trigger_event_id)
        | project fire_time, incident_id, event_id, event_type, status,
                  root_service, services, alert_event_id, title
      )
    | join kind=leftanti (
        ${datasetClause()}
        | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
        | where record_kind == "incident"
        | project event_id=tostring(event_id)
      ) on event_id
    // Sort barrier — assigning _time from a column after a union
    // silently nulls it on rows from the union's subquery branch
    // unless a materializing operator sits in between (verified on
    // staging 2026-08-18; see the KQL caveats in
    // docs/cribl-app-skill/skill.md).
    | sort by fire_time asc, event_id asc
    | project _time=fire_time, dataset="${ds}",
              datatype="${ALERT_EVENT_DATATYPE}",
              schema_version=tolong(${GENERATED_EVENT_SCHEMA_VERSION}),
              event_id, producer="${INCIDENT_GROUPER_PRODUCER}",
              record_kind="incident", event_type, incident_id,
              author="system", status, severity="", root_service, services,
              note="", investigation_id="", alert_event_id, title
    | export tee=true to search "${ds}"`;
}

/** Incident-event base for the fold's subqueries. */
function incidentEventsBase(): string {
  return `${datasetClause()}
    | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
    | where record_kind == "incident"
    | where isnull(is_canary) or tostring(is_canary) != "true"
    | extend incident_id=tostring(incident_id)`;
}

/** How long a closed incident's rows stay in the fold output (and so
 * in the Incidents list) before being pruned. The append-only events
 * in the dataset remain the durable history beyond this. */
export const INCIDENT_FOLD_RETENTION_DAYS = 7;

/**
 * Incident state fold — INCREMENTAL, evaluator-style: each run merges
 * its own previous output (read back from $vt_results, latest jobId)
 * with a short window of new incident events, instead of replaying
 * -7d of history. A full-history recompute needed ~8 wide dataset
 * scans every cadence — measured >60s per scan on staging — which
 * would have saturated the worker pool P4.5 just relieved.
 *
 * Output: one row per (incident_id, svc) membership, denormalized
 * with the incident-level state. Lands in $vt_results (the app's
 * incident list read); the companion export search copies non-closed
 * rows into the criblapm_incidents lookup for the grouper's join.
 *
 * Merge discipline:
 *   - New attach events are deduped by event_id (export retries can
 *     double-commit rows) and gated on a per-member high-water mark
 *     (_time strictly newer than the carried last_fire_at), so window
 *     overlap across runs never double-counts fire_n.
 *   - Human/agent status & severity override events are folded with a
 *     plain max() over the delta window — exact ordering of multiple
 *     overrides inside one window is a Phase 2 (warroom UI) concern;
 *     no writer emits them yet.
 *   - Incident-level rollups (n_svcs, all-clear) come from the
 *     PREVIOUS run's members — ≤1 cadence stale, which only delays a
 *     severity bump; liveness is fresh via criblapm__home_alerts.
 *
 * Status derivation (recomputed every run, so reopen-on-refire is
 * automatic):
 *   - any member service currently bad, or a firing transition newer
 *     than the debounce window            → open
 *   - all clear, quiet ≥ debounce         → resolved
 *   - resolved and quiet ≥ close age      → closed (archived)
 *   - a human/agent status_change or closed event newer than the last
 *     fire wins over the derived status; severity overrides always win.
 *
 * Known limitation: state carried through $vt_results survives only
 * within the search window (-1h) — if the fold is paused longer, the
 * list rebuilds from ongoing fires only (the event log in the dataset
 * stays complete). A slow daily reconciliation search can land with
 * P4.4 Phase 3 if this bites.
 */
export function incidentStateFold(): string {
  const debounceSec = INCIDENT_RESOLVE_DEBOUNCE_MIN * 60;
  const closeSec = INCIDENT_CLOSE_AFTER_HOURS * 3600;
  const pruneSec = INCIDENT_FOLD_RETENTION_DAYS * 86400;
  // Previous run's member rows, read back from $vt_results. The
  // latest-jobId self-join keeps a keepLastN=2 retention from mixing
  // two runs (jobId's fixed-width epoch-millis prefix makes the
  // string max the newest run).
  const prevMembers = `dataset="$vt_results"
        | where jobName == "criblapm__incidents_state"
        | join kind=inner (
            dataset="$vt_results"
            | where jobName == "criblapm__incidents_state"
            | summarize jobId=max(tostring(jobId))
          ) on jobId
        | project incident_id=tostring(incident_id), svc=tostring(svc),
                  first_seen=toreal(first_seen), last_fire_at=toreal(last_fire_at),
                  fire_n=tolong(fire_n), opened_at=toreal(opened_at),
                  title=tostring(title), root_service=tostring(root_service),
                  o_status=tostring(o_status), o_status_time=toreal(o_status_time),
                  o_severity=tostring(o_severity)`;
  // Strictly-newer attach events per (incident, svc): event_id dedup
  // first, then the high-water gate against the carried state.
  const attachDelta = `${incidentEventsBase()}
        | where event_type == "attached"
        | extend svc=tostring(services)
        | summarize _time=max(_time) by event_id=tostring(event_id), incident_id, svc
        | join kind=leftouter (
            ${prevMembers}
            | project incident_id, svc, prev_last=last_fire_at
          ) on incident_id, svc
        | where _time > iff(isnotnull(prev_last), prev_last, toreal(0))
        | summarize d_first=min(_time), d_last=max(_time), d_n=count()
          by incident_id, svc`;
  const liveBadBySvc = `dataset="$vt_results"
        | where jobName == "criblapm__home_alerts"
        | extend svc=tostring(svc)
        | summarize live_bad=countif(tostring(alert_status) in ("pending", "firing", "resolving")) by svc`;
  return `${prevMembers}
    | join kind=leftouter (
        ${attachDelta}
      ) on incident_id, svc
    | extend first_seen=iff(first_seen > 0, first_seen, iff(isnotnull(d_first), toreal(d_first), toreal(0))),
             last_fire_at=iff(isnotnull(d_last) and d_last > last_fire_at, toreal(d_last), last_fire_at),
             fire_n=fire_n + iff(isnotnull(d_n), tolong(d_n), tolong(0))
    | project incident_id, svc, first_seen, last_fire_at, fire_n,
              opened_at, title, root_service, o_status, o_status_time, o_severity
    | union (
        ${attachDelta}
        | join kind=leftanti (
            ${prevMembers}
          ) on incident_id, svc
        | project incident_id, svc, first_seen=toreal(d_first),
                  last_fire_at=toreal(d_last), fire_n=tolong(d_n),
                  opened_at=toreal(0), title="", root_service="",
                  o_status="", o_status_time=toreal(0), o_severity=""
      )
    | join kind=leftouter (
        ${incidentEventsBase()}
        | where event_type == "opened"
        | summarize n_opened_at=min(_time), n_title=max(tostring(title)),
                    n_root=max(tostring(root_service))
          by incident_id
      ) on incident_id
    | extend opened_at=iff(opened_at > 0, opened_at,
                           iff(isnotnull(n_opened_at), toreal(n_opened_at), first_seen)),
             title=iff(isnotempty(title), title,
                       iff(isnotnull(n_title) and isnotempty(tostring(n_title)),
                           tostring(n_title), strcat("Incident ", incident_id))),
             root_service=iff(isnotempty(root_service), root_service,
                              iff(isnotnull(n_root) and isnotempty(tostring(n_root)),
                                  tostring(n_root), svc))
    | join kind=leftouter (
        ${incidentEventsBase()}
        | where event_type in ("status_change", "closed") and isnotempty(status)
        | summarize d_status=max(tostring(status)), d_status_time=max(_time)
          by incident_id
      ) on incident_id
    | extend o_status=iff(isnotnull(d_status) and d_status_time > o_status_time,
                          tostring(d_status), o_status),
             o_status_time=iff(isnotnull(d_status_time) and d_status_time > o_status_time,
                               toreal(d_status_time), o_status_time)
    | join kind=leftouter (
        ${incidentEventsBase()}
        | where event_type == "severity_change" and isnotempty(severity)
        | summarize d_severity=max(tostring(severity)) by incident_id
      ) on incident_id
    | extend o_severity=iff(isnotnull(d_severity) and isnotempty(tostring(d_severity)),
                            tostring(d_severity), o_severity)
    // Own-service liveness, joined per member row. The incident-level
    // rollup below only sees PREVIOUS-run members, so on the very first
    // fold of a new incident it is empty — without this per-row join a
    // brand-new incident whose services are actively firing would
    // derive "resolved" (observed live 2026-08-18).
    | join kind=leftouter (
        ${liveBadBySvc}
      ) on svc
    | extend own_bad=iff(isnotnull(live_bad) and live_bad > 0, 1, 0)
    | join kind=leftouter (
        ${prevMembers}
        | join kind=leftouter (
            ${liveBadBySvc}
          ) on svc
        | extend bad=iff(isnotnull(live_bad) and live_bad > 0, 1, 0)
        | summarize prev_inc_last=max(last_fire_at), n_svcs_prev=dcount(svc),
                    inc_bad=sum(bad), prev_title=max(title),
                    prev_root=max(root_service)
          by incident_id
      ) on incident_id
    // Members attached after the opened event left the delta window
    // would otherwise carry the "Incident <id>" fallback title and
    // their own svc as root (observed live 2026-08-19). The carried
    // rows are authoritative for incident-level fields: prev wins.
    | extend title=iff(isnotnull(prev_title) and isnotempty(tostring(prev_title))
                       and not(tostring(prev_title) == strcat("Incident ", incident_id)),
                       tostring(prev_title), title),
             root_service=iff(isnotnull(prev_root) and isnotempty(tostring(prev_root)),
                              tostring(prev_root), root_service)
    | extend inc_last_fire=iff(isnotnull(prev_inc_last) and prev_inc_last > last_fire_at,
                               toreal(prev_inc_last), last_fire_at),
             inc_bad_n=iff(isnotnull(inc_bad), tolong(inc_bad), tolong(0)),
             n_svcs=iff(isnotnull(n_svcs_prev) and n_svcs_prev > 0, tolong(n_svcs_prev), tolong(1))
    | extend derived_status=case(
               own_bad > 0 or inc_bad_n > 0, "open",
               inc_last_fire >= toreal(now()) - ${debounceSec}, "open",
               inc_last_fire >= toreal(now()) - ${closeSec}, "resolved",
               "closed"),
             derived_severity=case(n_svcs >= 3, "sev2", n_svcs == 2, "sev3", "sev4")
    | extend status=iff(isnotempty(o_status) and o_status_time >= inc_last_fire,
                        o_status, derived_status),
             severity=iff(isnotempty(o_severity), o_severity, derived_severity)
    | where not(status == "closed" and inc_last_fire < toreal(now()) - ${pruneSec})
    // NO trailing sort: a "| sort" after this join pipeline silently
    // drops every row (verified live 2026-08-18 — 3 rows in, 0 out,
    // single- or multi-key alike; see skill.md). Readers order
    // client-side.
    | project incident_id, svc, status, severity, opened_at, first_seen,
              last_fire_at, fire_n, n_svcs, inc_last_fire, root_service, title,
              o_status, o_status_time, o_severity`;
}

/**
 * Incident timeline read — the append-only warroom log for one
 * incident (or the most recent events across all of them). Same
 * dedup-by-event_id discipline as the other generated-event readers.
 */
export function incidentEvents(incidentId?: string, limit = 500): string {
  const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  const idFilter = incidentId
    ? `| where incident_id == ${kqlStringLiteral(incidentId)}`
    : '';
  return `${incidentEventsBase()}
    ${idFilter}
    | summarize _time=max(_time)
      by event_id, event_type, incident_id, author, status, severity,
         root_service, services, note, investigation_id, alert_event_id,
         title, producer
    | project _time, event_id, event_type, incident_id, author, status,
              severity, root_service, services, note, investigation_id,
              alert_event_id, title, producer
    | sort by _time asc
    | limit ${safeLimit}`;
}

/**
 * Noise-budget aggregation (P1.1) — per-service fire counts read
 * from the alert-history events already in the dataset. Powers the
 * "is this threshold causing too many false alarms?" question that
 * every detection change should answer.
 *
 * Output schema: one row per (svc, day) with counts of how many
 * times an alert fired AND how many alerts were "persistent" (the
 * `is_persistent` flag set by alertEvaluator means the current and
 * prior windows were both elevated — usually a real problem, not
 * a noise event). A high fires count with low persistent count is
 * the signature of an over-sensitive threshold.
 *
 * The query lives here (not in provisionedSearches.ts) because
 * other surfaces — the eval harness, an admin-only debug page —
 * may want to run it ad-hoc against a shorter window.
 *
 * Window: 7d. Day bucket is `bin(_time, 1d)`. The default scheduled
 * cadence in provisionedSearches.ts runs this daily and exports to
 * $vt_results for later reads.
 */
export function noiseBudgetByService(): string {
  const logicalId = eventIdExpr(['alert_id', '_time', 'event_type']);
  return `${datasetClause()}
    | where ${generatedDatatypePredicate(ALERT_EVENT_DATATYPE)}
    | where event_type == "firing"
    | where isnull(is_canary) or tostring(is_canary) != "true"
    | extend logical_event_id=${logicalId},
             persistent_int=iff(tostring(is_persistent)=="true", 1, 0)
    | summarize event_time=max(_time), persistent_int=max(persistent_int)
      by logical_event_id, svc, alert_id
    | extend day=bin(event_time, 1d)
    | summarize fires=count(),
                persistent_fires=countif(persistent_int==1),
                services_distinct_alerts=dcount(alert_id)
      by svc, day
    | extend noisy_fires=fires - persistent_fires
    | project svc, day, fires, persistent_fires, noisy_fires, services_distinct_alerts
    | sort by day desc, fires desc`;
}

/**
 * Deploy / change correlation detector (P2.2 phase 1).
 *
 * "What changed?" is the first RCA question — for an alert at 14:32
 * on payment, the most useful one-line context is "payment deployed
 * 12m before this alert." OTel resources already carry
 * `service.version`; this scheduled search detects when a new
 * (svc, version) tuple first appears in the recent window and emits
 * a `criblapm_deploy` event to the dataset via the same immutable,
 * versioned generated-event contract as alert evaluation snapshots.
 *
 * Window / cadence (see provisionedSearches.ts): scheduled every
 * 30 min over a -1h window. `first_seen` filter selects only
 * versions whose earliest observed span is within the last ~30 min,
 * so a stable version doesn't re-emit every cycle. Initial run on
 * a fresh install emits every currently-active version once —
 * that's fine, it gives the Investigator a baseline of "what's
 * deployed right now."
 *
 * Event schema:
 *   _time           : emission timestamp (= now() at search run)
 *   dataset         : the lakehouse dataset name (current store)
 *   datatype        : "criblapm_deploy" (stored by the platform as
 *                     data_datatype; readers use the shared dual-read)
 *   svc             : service.name
 *   version         : service.version
 *   first_seen      : min(_time) of spans carrying this (svc, version)
 *                     in the search window
 *   n_spans         : count of spans for that tuple in the window
 *
 * Read-side: a follow-up PR adds the Investigator context hook
 * ("deployed Nm before this alert") and Service Detail RED-chart
 * markers. This PR ships only the data pipeline.
 */
export function deployEventsSend(): string {
  const ds = quoteDataset();
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
             version=tostring(resource.attributes['service.version'])
    | where isnotempty(svc) and isnotempty(version)
    | summarize first_seen=min(_time), n_spans=count() by svc, version
    // Emit only newly-appeared (svc, version) tuples. The
    // 30-minute window is intentionally narrower than the search's
    // cadence so a stable version's first_seen (≈ start-of-window,
    // ~ -1h) never trips this filter again after its first emission.
    | where first_seen >= datetime_add('minute', -30, now())
    | extend schema_version=tolong(${GENERATED_EVENT_SCHEMA_VERSION}),
             producer="criblapm__deploy_events", record_kind="deploy",
             event_id=strcat("criblapm:deploy:", svc, ":", version, ":", tostring(first_seen))
    | project _time=now(), dataset="${ds}",
              datatype="${DEPLOY_EVENT_DATATYPE}", schema_version,
              event_id, producer, record_kind,
              svc, version, first_seen, n_spans
    | export tee=true to search "${ds}"`;
}

/** Recent generated deploy events, with v0 dual-read and logical deduplication. */
export function recentDeployEvents(limit = 25): string {
  const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  const logicalId = eventIdExpr(['svc', 'version', 'first_seen']);
  return `${datasetClause()}
    | where ${generatedDatatypePredicate(DEPLOY_EVENT_DATATYPE)}
    | where isnull(is_canary) or tostring(is_canary) != "true"
    | extend logical_event_id=${logicalId},
             svc=tostring(svc), version=tostring(version),
             first_seen_num=toreal(first_seen), n_spans_num=tolong(n_spans)
    | summarize first_seen_ms=max(first_seen_num)*1000,
                n_spans_total=max(n_spans_num)
      by logical_event_id, svc, version
    | sort by first_seen_ms desc
    | limit ${safeLimit}`;
}

/**
 * Time-bucketed request count + p95 per service. Powers service-row
 * sparklines on the Home page and the RED charts on the Service detail page.
 *
 * binSeconds controls the bucket width — 60 for 1m bins, 300 for 5m, etc.
 * Callers typically pick a width that gives ~30–60 buckets across their
 * time range so the sparklines have enough resolution without being noisy.
 */
export function serviceTimeSeries(
  binSeconds: number,
  service?: string,
  opts?: QueryOpts,
): string {
  const svcFilter = service ? `| where svc==${kqlStringLiteral(service)}` : '';
  const bin = kqlInteger(binSeconds, { min: 1, max: 86_400 });
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    ${svcFilter}
    ${entrySpanKindClause()}
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                errors=countif(is_error),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99)
      by svc, bucket=bin(_time, ${bin}s)
    | sort by svc asc, bucket asc`;
}

/**
 * Per-minute HTTP status-code mix for one service. Powers the Service
 * Detail "Status mix" chart that breaks the flat "errors" total apart
 * into 503 (capacity), 504 (upstream timeout), 500 (upstream bug),
 * and the surrounding 4xx / 502 / other_5xx classes.
 *
 * Why this exists: in the 2026-05-20 misdiagnosis, a 503-dominant mix
 * (envoy "no healthy upstream") was the actual evidence that the
 * frontend was capacity-bound, but the existing Errors chart flattened
 * everything into one rate. See docs/sessions/2026-05-20-smooth-climb-misdiagnosis.md.
 *
 * Coalesces `http.response.status_code` (modern semconv) and
 * `http.status_code` (legacy) — the demo's stock spans use the legacy
 * field for envoy / next.js while newer SDKs use the modern one.
 * gRPC failures fold into a `grpc_err` bucket so non-HTTP services
 * still produce a useful mix.
 */
export function serviceStatusCodeMix(binSeconds: number, service: string, opts?: QueryOpts): string {
  const s = kqlStringLiteral(service);
  const bin = kqlInteger(binSeconds, { min: 1, max: 86_400 });
  // dur_us is computed for streamFilterSpanKqlClause(); without it
  // the injected `| where dur_us < ...` filters every row out.
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
             dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
             http_status=coalesce(toint(attributes['http.response.status_code']),
                                  toint(attributes['http.status_code'])),
             grpc_status=toint(attributes['rpc.grpc.status_code'])
    | where svc==${s}
    ${streamFilterSpanKqlClause()}
    | extend status_class=case(
        http_status == 503, "503",
        http_status == 504, "504",
        http_status == 502, "502",
        http_status == 500, "500",
        http_status >= 500 and http_status < 600, "other_5xx",
        http_status >= 400 and http_status < 500, "4xx",
        isnotnull(grpc_status) and grpc_status != 0, "grpc_err",
        "ok")
    | summarize n=count() by status_class, bucket=bin(_time, ${bin}s)
    | sort by bucket asc, status_class asc`;
}

/**
 * Top operations for a service, sorted by volume. Each row includes counts,
 * error rate, and percentile latencies — the core table on Service detail.
 */
export function serviceOperations(service: string, opts?: QueryOpts): string {
  const s = kqlStringLiteral(service);
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    | where svc==${s}
    ${entrySpanKindClause()}
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                errors=countif(is_error),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99)
      by name
    | extend error_rate=toreal(errors)/toreal(requests)
    | sort by requests desc
    | limit 50`;
}

/**
 * Per-instance RED metrics for one service. Groups by
 * `service.instance.id` instead of operation name. Powers the
 * Instances section on ServiceDetail so per-pod failures (memory
 * leak, slow start, noisy-neighbor) are visible instead of diluted
 * into the service-level aggregate.
 */
export function serviceInstances(service: string, opts?: QueryOpts): string {
  const s = kqlStringLiteral(service);
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            instance_id=tostring(resource.attributes['service.instance.id']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    | where svc==${s}
    ${entrySpanKindClause()}
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                errors=countif(is_error),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99)
      by instance_id
    | extend error_rate=toreal(errors)/toreal(requests)
    | sort by requests desc`;
}

/**
 * All-services variant of serviceOperations — groups by (svc, name)
 * instead of just name, with no service filter. Scheduled as
 * `criblapm__svc_operations` so ServiceDetail can read the Top
 * Operations table from $vt_results instead of scanning every span
 * in the window at page-load time.
 */
export function allServiceOperations(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2")
    ${entrySpanKindClause()}
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                errors=countif(is_error),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99)
      by svc, name
    | extend error_rate=toreal(errors)/toreal(requests)
    | sort by svc asc, requests desc`;
}

/**
 * Per-(service, operation) latency summary across the full window —
 * every op in the dataset, stream filter applied. Used by the
 * latency-anomaly detector on the Home page: we run this twice
 * (current window + prior window) and flag ops whose current p95
 * is significantly higher than their baseline.
 *
 * The stream filter stays ON. Without it, the query's p95 would be
 * dominated by idle-poll spans on consumer ops, which poisons both
 * the anomaly signal and the baseline. Genuine latency anomalies
 * still show up because the non-filtered portion of the spans
 * (≤ 30s) still dwarfs the healthy baseline (~100ms for most ops).
 */
export function allOperationsSummary(limit: number = 1000): string {
  const safeLimit = kqlInteger(limit, { min: 1, max: 10_000 });
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99)
      by svc, op=name
    | sort by requests desc
    | limit ${safeLimit}`;
}

/**
 * Traces sorted by trace duration descending — "slow traces" panel on
 * the Home page. Optionally scoped to a service. Applies the same
 * long-poll / idle-wait filter as rawSlowestTraces() — see
 * api/streamFilter.ts. Includes `root_op` in the summarize so the
 * stream filter's kafka consumer exemption can reference it.
 */
export function slowestTraces(service?: string, opts?: QueryOpts): string {
  const svcFilter = service ? `| where svc==${kqlStringLiteral(service)}` : '';
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            parent=tostring(parent_span_id),
            is_root=(parent=="" or isempty(parent)),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
    ${svcFilter}
    | summarize span_count=count(),
                first_seen=min(_time),
                trace_start_ns=min(start_time_unix_nano),
                trace_end_ns=max(end_time_unix_nano),
                max_non_root_dur_us=maxif(dur_us, is_root == false),
                root_op=minif(name, is_root)
      by trace_id
    | extend trace_dur_us=(toreal(trace_end_ns)-toreal(trace_start_ns))/1000.0
    ${streamFilterKqlClause()}
    | sort by trace_dur_us desc
    | limit 20`;
}

/**
 * Raw slow-trace rows enriched with the root span's (service, operation)
 * for client-side class grouping. Returns up to `limit` of the slowest
 * traces in the window, each tagged with its root svc/op so the UI can
 * collapse repeating classes (e.g. 40 identical 600s streaming traces
 * become 1 row with count=40).
 *
 * root_svc/root_op are picked via minif(col, is_root) — Cribl KQL doesn't
 * have arg_min/arg_max, but minif(col, predicate) picks the min value
 * among rows satisfying the predicate, which for a single-root trace is
 * just "the root span's value."
 *
 * Long-poll / idle-wait filter: see api/streamFilter.ts for the full
 * rationale. In short, traces dominated by root self-time (no single
 * child accounts for a meaningful fraction of the duration) are either
 * persistent streaming connections or idle consumer-poll loops — in
 * both cases they can't be diagnosed from trace data so we hide them.
 * Controlled by a user setting, default on. The query always computes
 * `max_non_root_dur_us` so the filter clause can be appended or not
 * without changing the summarize shape.
 */
export function rawSlowestTraces(limit: number = 500): string {
  const safeLimit = kqlInteger(limit, { min: 1, max: 10_000 });
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            parent=tostring(parent_span_id),
            is_root=(parent=="" or isempty(parent)),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
    | summarize span_count=count(),
                trace_start_ns=min(start_time_unix_nano),
                trace_end_ns=max(end_time_unix_nano),
                max_non_root_dur_us=maxif(dur_us, is_root == false),
                root_svc=minif(svc, is_root),
                root_op=minif(name, is_root)
      by trace_id
    | extend trace_dur_us=(toreal(trace_end_ns)-toreal(trace_start_ns))/1000.0
    | where isnotnull(root_svc)
    ${streamFilterKqlClause()}
    | sort by trace_dur_us desc
    | limit ${safeLimit}`;
}

/**
 * Raw error span rows enriched with service, operation, status.message,
 * and trace-origin context for client-side filtering and grouping.
 * Returns up to `limit` of the most recent error spans.
 *
 * Each row is joined to the per-trace root via parent_span_id=="", and
 * the root's service is looked up in criblapm_trace_originators to
 * attach a `trace_origin` tag (`user` | `service` | `unknown`). The
 * error filter uses this to scope rules — same status code means
 * different things depending on whether a user or a service started
 * the trace. See docs/research/error-filter-design.md for the design.
 *
 * Output columns: _time, svc, name, span_kind, http_status, grpc_status,
 * msg, trace_id, root_svc, trace_origin.
 *
 * The right side of the leftouter join is one row per captured trace
 * (not per span), bounded by the time window — small enough to dodge
 * the Cribl KQL join-truncation behavior we hit during Phase 0.
 */
export function rawRecentErrorSpans(limit: number = 300, opts?: QueryOpts): string {
  const safeLimit = kqlInteger(limit, { min: 1, max: 10_000 });
  // Predicate pushed BEFORE the extend block — the accelerated
  // `status_code` column filters out ~99% of spans before any
  // per-row work happens. The extend block then computes 7
  // fields only on the error subset.
  return `${spansBase()}
    | where ${errorPredicate(opts)}
    | extend svc=${svcExpr(opts)},
             span_kind=tostring(kind),
             msg=tostring(status.message),
             http_status=toint(attributes['http.response.status_code']),
             grpc_status=toint(attributes['rpc.grpc.status_code']),
             sid=tostring(span_id)
    | sort by _time desc
    | limit ${safeLimit}
    | project _time, svc, name, span_kind, http_status, grpc_status, msg, trace_id, sid
    ${errorClassificationJoins(opts)}
    | project _time, svc, name, span_kind, http_status, grpc_status,
              msg, trace_id, root_svc, trace_origin, has_error_child`;
}

/**
 * Trace-originator classification. For each captured trace's root
 * span (parent_span_id == ""), record the originator's service and
 * classify it as `user` (real or synthetic user) or `service` (cron,
 * queue consumer, scheduled task) or `unknown`. Classification reads
 * the user-agent value, messaging.system, and span-name patterns —
 * none of which are tied to a specific app or OTel demo. See
 * docs/research/error-filter-design.md for the signal priority and
 * Phase 0 v2 validation findings.
 *
 * Output columns: root_svc, type, total, n_browser, n_loadtest,
 * n_probe, n_msg, n_name_user, n_name_service. The signal counts
 * surface in Settings so users can see *why* a service was
 * classified the way it was, and override if the classification
 * doesn't fit their deployment.
 *
 * This function returns the underlying classification logic, not
 * the `| export to lookup` tail. The provisionedSearches wrapper
 * adds export. Calling this directly is useful for ad-hoc
 * inspection and unit testing.
 */
/**
 * Per-pod start time + uptime for a service. The k8s.pod.start_time
 * resource attribute is stamped on every span, so this is cheap —
 * a 1h window is enough to see all currently-emitting pods.
 *
 * Used by the Investigator's leak-fingerprint check (ingredient #3:
 * "Pod has been up for many days without restart") and by the
 * Service Detail UI to surface uptime chips per instance.
 *
 * Output: (pod, start_iso, uptime_hours, current_iso).
 */
export function podUptime(svc?: string, opts?: QueryOpts): string {
  const svcFilter = svc
    ? `| where svc == ${kqlStringLiteral(svc)}`
    : '';
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
             pod=tostring(resource.attributes['k8s.pod.name']),
             start_iso=tostring(resource.attributes['k8s.pod.start_time'])
    | where isnotempty(pod) and isnotempty(start_iso)
    ${svcFilter}
    | summarize start_iso=max(start_iso), last_seen=max(_time) by svc, pod
    | extend uptime_hours=abs(datetime_diff('hour', todatetime(start_iso), unixtime_seconds_todatetime(toreal(last_seen))))
    | project svc, pod, start_iso, uptime_hours, last_seen
    | sort by uptime_hours desc`;
}

/**
 * Per-service error-rate history for the last 6 *completed* days
 * (yesterday through 6 days ago). Pivoted so the lookup output is
 * **one row per service** with `d1..d6` columns — necessary because
 * Cribl `lookup ... on svc` returns only the FIRST matching row, so
 * a per-day-row schema is unreadable by consumers (see "Blocked on
 * Cribl" in ROADMAP.md).
 *
 * Today's number deliberately isn't in this snapshot: today is
 * partial and changes by the hour, so the "now" data point comes
 * from `criblapm__home_service_summary` (5-min cadence on -1h) when
 * the Investigator needs it. Two lookups, two readers, one cheap
 * read each.
 *
 * Cluster reality: a 7d window with DAILY bins completes in ~60-70s
 * on staging — would time out at HOURLY bins, never mind smaller.
 * The scheduled-search wrapper runs this **once per day** (was
 * hourly; 24x worker-time saving). See
 * docs/sessions/2026-05-19-search-perf-baseline.md for the
 * before-numbers.
 *
 * Output columns: svc, d1_pct..d6_pct, d1_total..d6_total. `d1` is
 * yesterday, `d6` is 6 days ago. Naming matches the pattern an
 * operator would say out loud ("look at the last week, day by day").
 */
export function errorRateHistory(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
             is_error=(tostring(status.code)=="2")
    | summarize total=count(), errs=countif(is_error) by svc, day=bin(_time, 1d)
    | where total >= 100
    | extend day_offset=tolong((toreal(bin(now(), 1d)) - toreal(day)) / 86400.0)
    | where day_offset between (1 .. 6)
    | summarize
        d1_total=sum(iff(day_offset == 1, total, tolong(0))),
        d1_errs=sum(iff(day_offset == 1, errs, tolong(0))),
        d2_total=sum(iff(day_offset == 2, total, tolong(0))),
        d2_errs=sum(iff(day_offset == 2, errs, tolong(0))),
        d3_total=sum(iff(day_offset == 3, total, tolong(0))),
        d3_errs=sum(iff(day_offset == 3, errs, tolong(0))),
        d4_total=sum(iff(day_offset == 4, total, tolong(0))),
        d4_errs=sum(iff(day_offset == 4, errs, tolong(0))),
        d5_total=sum(iff(day_offset == 5, total, tolong(0))),
        d5_errs=sum(iff(day_offset == 5, errs, tolong(0))),
        d6_total=sum(iff(day_offset == 6, total, tolong(0))),
        d6_errs=sum(iff(day_offset == 6, errs, tolong(0)))
      by svc
    | extend
        d1_pct=iff(d1_total > 0, round(100.0 * todouble(d1_errs) / todouble(d1_total), 2), 0.0),
        d2_pct=iff(d2_total > 0, round(100.0 * todouble(d2_errs) / todouble(d2_total), 2), 0.0),
        d3_pct=iff(d3_total > 0, round(100.0 * todouble(d3_errs) / todouble(d3_total), 2), 0.0),
        d4_pct=iff(d4_total > 0, round(100.0 * todouble(d4_errs) / todouble(d4_total), 2), 0.0),
        d5_pct=iff(d5_total > 0, round(100.0 * todouble(d5_errs) / todouble(d5_total), 2), 0.0),
        d6_pct=iff(d6_total > 0, round(100.0 * todouble(d6_errs) / todouble(d6_total), 2), 0.0)
    | project svc,
              d1_pct, d2_pct, d3_pct, d4_pct, d5_pct, d6_pct,
              d1_total, d2_total, d3_total, d4_total, d5_total, d6_total
    | sort by svc asc`;
}

/**
 * Attribute-name catalog. Enumerates every (svc, attr_name) pair
 * observed in the recent span sample via `bag_keys(attributes)` →
 * `mv-expand`. The catalog is the foundation for cardinality / leak
 * detection — once we know what attribute names exist per service,
 * a follow-up search computes dcount for each (auto-generated KQL).
 *
 * Output schema: root-style with one row per (svc, attr_name):
 *   svc, attr_name, n_spans_with_key, last_seen
 *
 * Filter at the lookup level: rows with `n_spans_with_key >= 5`
 * stay (a name has to appear on ≥5 spans in the window to count
 * as "present"). At a 500-span sample with ~15 services, that's a
 * lenient enough threshold to keep all real attribute names while
 * filtering one-off trace attributes.
 *
 * Bag-keys is the only reliable way to enumerate attribute names
 * dynamically in Cribl KQL — `foldkeys` output is opaque,
 * `extract_all` on `_raw` returns empty arrays on real spans
 * (regex size limit), and dynamic indexing `attributes[col]` is
 * not supported. See HEURISTICS.md §1 for the rationale.
 *
 * Cadence: hourly (attribute names change slowly). Window: 5m
 * sample — bag_keys + mv-expand is heavy per row; keep the input
 * set tiny.
 *
 * The export-to-lookup is *not* tacked onto this query — Cribl's
 * planner consistently fails the `func:store` write stage when
 * mv-expand is anywhere upstream of `| export to lookup`. The
 * scheduled search runs this query, the result lands in
 * $vt_results, and a companion search reads $vt_results and
 * writes the lookup. See provisionedSearches.ts §attr-catalog.
 */
export function attrCatalog(sampleSpans: number = 5000): string {
  return `${spansBase()}
    | limit ${sampleSpans}
    | extend svc=tostring(resource.attributes['service.name']),
             ks=bag_keys(attributes)
    | mv-expand attr_name=ks
    | extend attr_name=tostring(attr_name)
    | where isnotempty(attr_name)
    | summarize n_spans_with_key=count() by svc, attr_name
    | where n_spans_with_key >= 5
    | project svc, attr_name, n_spans_with_key`;
}

export function traceOriginators(): string {
  return `${spansBase()}
    | where tostring(parent_span_id) == ""
    | extend root_svc=tostring(resource.attributes['service.name']),
             ua=tostring(attributes['http.user_agent']),
             msg_sys=tostring(attributes['messaging.system']),
             span_name=tostring(name)
    // Character-class alternation instead of (?i): the inline flag
    // upstream of export-to-lookup makes the func:store write stage
    // emit a CSV that reports totalEventsOut correctly but is not
    // joinable — lookup-on-root_svc returns no matches. Same bug
    // family as the mv-expand/export incompatibility in
    // attrCatalogComputeQuery. Found 2026-06-09 when the lookup
    // never repopulated after the dataset-empty wipe.
    | extend ua_browser=(ua matches regex "[Mm]ozilla|[Cc]hrome|[Ss]afari|[Ff]irefox|[Ee]dge|[Oo]pera"),
             ua_loadtest=(ua matches regex "k6|[Ll]ocust|[Jj]meter|[Gg]atling|wrk|ab/|[Ll]oadgen"),
             ua_probe=(ua matches regex "kube-probe|[Gg]o-http-client|[Hh]ealthcheck|[Ll]iveness|[Rr]eadiness"),
             has_msg=isnotempty(msg_sys),
             name_user=(span_name matches regex "(^|_)([Uu]ser|[Bb]rowse|[Vv]iew|[Cc]heckout|[Cc]art|[Ss]earch)(_|$)"),
             name_service=(span_name matches regex "(^|_)([Tt]ick|[Cc]ron|[Cc]onsume|[Pp]rocess|[Pp]oll|[Ww]orker|[Jj]ob|[Tt]ask)(_|$)")
    | summarize total=count(),
                n_browser=countif(ua_browser),
                n_loadtest=countif(ua_loadtest),
                n_probe=countif(ua_probe),
                n_msg=countif(has_msg),
                n_name_user=countif(name_user),
                n_name_service=countif(name_service)
        by root_svc
    | extend type=case(
        todouble(n_browser+n_loadtest)/todouble(total) >= 0.5, "user",
        todouble(n_probe)/todouble(total) >= 0.5, "service",
        todouble(n_msg)/todouble(total) >= 0.5, "service",
        todouble(n_name_user)/todouble(total) >= 0.5, "user",
        todouble(n_name_service)/todouble(total) >= 0.5, "service",
        "unknown")
    | where total >= 10
    | project root_svc, type, total,
              n_browser, n_loadtest, n_probe, n_msg,
              n_name_user, n_name_service`;
}

/**
 * Traces that had at least one error span — "recent errors" panel on
 * Home and Service detail. Optionally scoped to a service.
 */
export function recentErrorTraces(service?: string, opts?: QueryOpts): string {
  const svcFilter = service ? `| where svc==${kqlStringLiteral(service)}` : '';
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            is_error=(${statusCodeExpr(opts)}=="2")
    | where is_error
    ${svcFilter}
    | summarize first_seen=max(_time),
                error_count=count()
      by trace_id
    | sort by first_seen desc
    | limit 20`;
}

/** Parameters for the standalone Log Explorer query. */
export interface SearchLogsParams {
  service?: string;
  /** Minimum severity_number (OTel scale: INFO=9, WARN=13, ERROR=17). */
  minSeverity?: number;
  /** Maximum severity_number — lets you carve out "only WARN, not ERROR". */
  maxSeverity?: number;
  /** Plain-text substring to match in the log body. Case-insensitive. */
  bodyContains?: string;
  limit?: number;
}

/**
 * Standalone log search — no trace ID required. Powers the Log Explorer
 * tab. Distinct from traceLogs() in that the latter is always scoped to
 * a single trace, while this one roams across all logs in the dataset.
 *
 * Sort order is reverse-chronological so "most recent" is always at
 * the top; the UI paginates from there.
 */
export function searchLogs(params: SearchLogsParams): string {
  const filters: string[] = [
    'isnotnull(body)',
    'isnotnull(severity_number)',
  ];

  if (params.service) {
    filters.push(`tostring(resource.attributes['service.name'])==${kqlStringLiteral(params.service)}`);
  }
  // NOTE: do NOT wrap severity_number in toreal() here. The otel
  // dataset stores severity_number as an int; toreal() on an int
  // column in Cribl KQL returns zero rows instead of coercing — tested
  // empirically: `toreal(severity_number) >= 9` matches 0 events while
  // `severity_number >= 9` matches all 18k INFO logs. Compare the raw
  // int directly.
  if (params.minSeverity != null) {
    filters.push(`severity_number >= ${kqlFiniteNumber(params.minSeverity, { min: 0 })}`);
  }
  if (params.maxSeverity != null) {
    filters.push(`severity_number <= ${kqlFiniteNumber(params.maxSeverity, { min: 0 })}`);
  }
  if (params.bodyContains) {
    // Cribl's `contains` is case-insensitive by default on strings.
    filters.push(`tostring(body) contains ${kqlStringLiteral(params.bodyContains)}`);
  }

  const lim = kqlInteger(params.limit ?? 200, { min: 1, max: 10_000 });
  return `${datasetClause()}
    | where ${filters.join(' and ')}
    | project _time, trace_id, span_id, body, severity_text, severity_number,
              attributes,
              service_name=tostring(resource.attributes['service.name']),
              pod_name=tostring(resource.attributes['k8s.pod.name']),
              code_file=tostring(attributes['code.file.path']),
              code_function=tostring(attributes['code.function.name']),
              code_line=attributes['code.line.number']
    | sort by _time desc
    | limit ${lim}`;
}

/**
 * All distinct services that have emitted logs. Smaller than the span
 * services list because not every service logs structured events.
 */
export function logServices(): string {
  return `${datasetClause()}
    | where isnotnull(body) and isnotnull(severity_number)
    | extend svc=tostring(resource.attributes['service.name'])
    | summarize by svc
    | sort by svc asc`;
}

/**
 * Structured logs emitted inside a trace. Logs in the otel dataset are
 * distinguished from spans by having a body+severity and lacking
 * end_time_unix_nano.
 */
export function traceLogs(traceId: string): string {
  const t = kqlStringLiteral(kqlTraceId(traceId));
  return `${datasetClause()}
    | where isnotnull(body) and isnotnull(severity_number)
    | where trace_id==${t}
    | project _time, trace_id, span_id, body, severity_text, severity_number,
              attributes,
              service_name=tostring(resource.attributes['service.name']),
              code_file=tostring(attributes['code.file.path']),
              code_function=tostring(attributes['code.function.name']),
              code_line=attributes['code.line.number']
    | sort by _time asc
    | limit 5000`;
}

/**
 * Messaging / async dependency edges.
 *
 * OTel kafka / rabbitmq instrumentation does NOT link producer and
 * consumer spans via parent_span_id — they live in different traces.
 * Instead, each side has `messaging.destination.name` (the topic /
 * queue) and `messaging.operation` (publish/send on producer,
 * receive/process on consumer). We aggregate per
 * (service, topic, operation) and cross-product producers×consumers
 * client-side in transform.ts to synthesize edges.
 *
 * The span duration on the CONSUMER side is what captures lag
 * (kafkaQueueProblems scenario) — that's where p95 goes from ms to
 * tens of seconds — so we carry the consumer p95 through as the edge
 * latency metric.
 */
export function messagingDependencies(opts?: QueryOpts): string {
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2"),
            msg_op=tostring(attributes['messaging.operation']),
            msg_dest=tostring(attributes['messaging.destination.name']),
            msg_system=tostring(attributes['messaging.system'])
    | where isnotempty(msg_dest) and isnotempty(msg_op)
    ${streamFilterSpanKqlClause()}
    | summarize spans=count(),
                errors=countif(is_error),
                p95_us=percentile(dur_us, 95)
      by svc, msg_dest, msg_op, msg_system
    | sort by spans desc`;
}

/**
 * Service dependency edges via self-join on (trace_id, span_id↔parent_span_id).
 *
 * Each edge carries the caller → callee call count, error count, and p95
 * latency of the CHILD span — the thing the caller was waiting on. Error
 * is attributed to the child because that's where the failure happens
 * even though the edge is lit "from the caller's perspective." This is
 * what makes paymentUnreachable light up the checkout→payment edge
 * instead of just the payment node.
 */
export function dependencies(opts?: QueryOpts): string {
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            parent=tostring(parent_span_id),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    | where parent != "" and isnotempty(parent)
    ${streamFilterSpanKqlClause()}
    | project trace_id, parent, svc, dur_us, is_error
    | join kind=inner (
        ${spansBase()}
        | extend psvc=${svcExpr(opts)},
                psid=tostring(span_id)
        | project trace_id, psid, psvc
      ) on trace_id, $left.parent == $right.psid
    | where svc != psvc
    | summarize callCount=count(),
                errorCount=countif(is_error),
                p95DurUs=percentile(dur_us, 95)
      by parent=psvc, child=svc
    | sort by callCount desc`;
}

// ─────────────────────────────────────────────────────────────────
// Faceted navigation — data layer for the filter builder, facet
// panel, Spotlight, and value autocomplete on the Search page. See
// ROADMAP.md item #2 for the user-facing surface; this layer just
// provides per-attribute value-distribution and selection-vs-
// baseline-diff queries that the UI components compose.
// ─────────────────────────────────────────────────────────────────

/**
 * Attribute names Spotlight + the facet panel will probe by
 * default. Hand-picked for signal density on the OTel demo and
 * other typical OTel-instrumented workloads — the kind of
 * attributes operators actually compose filters around. The
 * trade-off: any attribute not in this list isn't visible to the
 * Search-page automatic facet panel until it gets added here.
 *
 * Order doesn't matter for correctness — the UI ranks them by
 * signal strength. It does matter for parallel-query fan-out: the
 * Spotlight engine fires one query per attribute, so keeping the
 * list to ~20 keeps cluster-queue pressure reasonable.
 *
 * Future work (ROADMAP item #10 follow-up): replace the static
 * list with a provisioner-generated one that reads
 * criblapm_attr_catalog at build time. Until then, manually keep
 * this list in sync with the attribute set the UI cares about.
 */
export const SPOTLIGHT_ATTRIBUTES: readonly string[] = [
  // Top-level span columns. `name` is the operation — typically the
  // strongest single differentiator on Service Detail's scope ("which
  // operation is failing?"). attrValueExpr() handles the bare-column
  // resolution.
  'name',
  // HTTP method / route / URL — describe the REQUEST shape, so they
  // partition errors by what was asked for, not what was returned.
  // (Response-status codes are deliberately excluded — they reflect
  // the selection rather than cause it, which makes them tautological
  // when the selection IS "errors".)
  'http.request.method',
  'http.method',
  'http.route',
  'http.target',
  'http.url',
  // RPC: who was being called.
  'rpc.system',
  'rpc.service',
  'rpc.method',
  // Messaging
  'messaging.system',
  'messaging.destination.name',
  'messaging.operation',
  // DB
  'db.system',
  'db.statement',
  // K8s (resource attrs — different access shape but same idea)
  'k8s.pod.name',
  'k8s.deployment.name',
  // User / session — the high-cardinality leak-fingerprint
  // attributes; not super useful for filtering but very useful
  // for Spotlight's "what's over-represented" lens
  'session.id',
  'user.id',
  // "Where did this span come from?" attributes — caller identity,
  // upstream peer. These often dominate the Spotlight ranking when
  // the user is investigating why a service is failing.
  'peer.service',
  'net.peer.name',
  'net.peer.port',
  // OTel-demo-specific INPUT-side attributes — the product ID, etc.
  // These are the ones that reveal which input value triggers the
  // failure (e.g. productCatalogFailure on a specific product).
  'app.product.id',
] as const;

/**
 * Curated Spotlight subset for embedded surfaces (Service Detail) that
 * fetch this ALONGSIDE the rest of a heavy page. Each attribute is one
 * live KQL span-scan; the full ~27-attr set fired on every Service Detail
 * load and dominated the worker pool (45 jobs / 12s to settle). This
 * ~9-attr set keeps the strongest "why is this service erroring?"
 * differentiators — operation, request shape, downstream peer, pod /
 * deployment, and the demo's input-side product id — and drops the
 * high-cardinality user/session and rarely-populated net.* attrs. Pair
 * with lazy (scroll-into-view) loading in SpotlightSection.
 */
export const SPOTLIGHT_ATTRIBUTES_SERVICE_DETAIL: readonly string[] = [
  'name',
  'http.route',
  'http.target',
  'rpc.method',
  'peer.service',
  'k8s.pod.name',
  'k8s.deployment.name',
  'db.system',
  'app.product.id',
] as const;

/**
 * Per-(attribute, value) row count over a filtered span set.
 * Used by the facet panel: "of the spans matching this filter,
 * what are the top values of <attr_name>?"
 *
 * `predicateKql` is the user's filter expressed as a KQL
 * predicate clause (e.g., `svc == "checkout" and status_code == "2"`).
 * The query inserts it directly after the spansBase() filter — so
 * the caller is responsible for it being a valid pre-extend
 * expression that references columns the query later projects.
 *
 * Returns one row per value: { attr_name, attr_value, n }. The
 * UI sums n across the returned rows to compute the within-top-N
 * total and derives % share client-side. (For "exact total
 * including the long tail," the caller can run a separate
 * countif query; the top-N total is enough for the panel's
 * "78% of these traces have svc=cart" rendering.)
 */
/**
 * KQL expression that yields the value of one attribute as a string.
 *
 * Resolves three flavors:
 *   - top-level columns (`name`, `kind`) → bare column
 *   - resource attributes (`k8s.*`, `service.*`) → resource.attributes['k']
 *   - everything else → attributes['k']
 */
function attrValueExpr(attrName: string): string {
  const a = kqlFieldKey(attrName);
  if (a === 'name' || a === 'kind') {
    return `tostring(${a})`;
  }
  const isResourceAttr = a.startsWith('k8s.') || a.startsWith('service.');
  return isResourceAttr
    ? `tostring(resource.attributes${kqlBracketField(a)})`
    : `tostring(attributes${kqlBracketField(a)})`;
}

export function attrValueDistribution(
  attrName: string,
  predicateKql: string,
  limit: number = 20,
): string {
  const a = kqlFieldKey(attrName);
  const pre = predicateKql ? `| where ${assertKqlPredicate(predicateKql)}` : '';
  const safeLimit = kqlInteger(limit, { min: 1, max: 1_000 });
  const valueExpr = attrValueExpr(attrName);
  return `${spansBase()}
    ${pre}
    | extend attr_value=${valueExpr}
    | where isnotempty(attr_value)
    | summarize n=count() by attr_value
    | sort by n desc
    | limit ${safeLimit}
    | extend attr_name=${kqlStringLiteral(a)}
    | project attr_name, attr_value, n`;
}

/**
 * Spotlight differential row: how does the value distribution of
 * one attribute differ between a SELECTION (typically the user's
 * current Search filter) and the BASELINE (everything else in
 * the same time window)?
 *
 * `selectionKql` is the predicate that defines the selection
 * (e.g., `status_code == "2"`). Spans not matching it form the
 * baseline. The query computes both counts in one pass using
 * countif, so it's a single scan per attribute regardless of
 * selection complexity.
 *
 * Returns one row per value: { attr_name, attr_value, sel_n,
 * base_n }. The UI sums sel_n and base_n across the returned
 * rows to compute sel_total / base_total within the top-N, and
 * derives the diff as (sel_n/sel_total) - (base_n/base_total).
 * Ranks attributes by max-abs-diff over their values.
 *
 * `top` bounds the number of values returned per attribute —
 * ranked by total (sel_n + base_n), keeping the most common.
 */
export function spotlightAttrDiff(
  attrName: string,
  selectionKql: string,
  top: number = 20,
  /**
   * Optional scope predicate. When set, BOTH the selection and the
   * baseline are restricted to spans matching this clause. The
   * differential becomes "what's different about my selection vs the
   * REST OF THE SCOPE" instead of "vs the rest of the time window".
   *
   * Use for embedded surfaces where the parent context (service,
   * service+operation, etc.) is implicit. Without it, the differential
   * is dominated by attributes that distinguish the scope itself from
   * the rest of the workload (e.g., rpc.method=Charge over-represented
   * because no other service does Charge) rather than by attributes
   * that distinguish the selection inside the scope (e.g., one pod is
   * failing while others aren't).
   */
  scopeKql?: string,
): string {
  const a = kqlFieldKey(attrName);
  const valueExpr = attrValueExpr(attrName);
  const scope = scopeKql && scopeKql.trim() ? assertKqlPredicate(scopeKql) : '';
  const selection = selectionKql ? assertKqlPredicate(selectionKql) : 'true';
  const safeTop = kqlInteger(top, { min: 1, max: 1_000 });
  const scopeWhere = scope ? `| where ${scope}` : '';
  // `not <bool>` is rejected inside countif() by Cribl's KQL
  // parser — explicit `== true` / `== false` comparisons work.
  // See https://github.com/criblio/apm DEVELOPMENT.md (or the
  // Cribl KQL gotchas section in agentContext.ts) for the
  // accumulating list of dialect quirks.
  return `${spansBase()}
    ${scopeWhere}
    | extend attr_value=${valueExpr},
             sel_match=${selection}
    | where isnotempty(attr_value)
    | summarize sel_n=countif(sel_match==true),
                base_n=countif(sel_match==false)
      by attr_value
    | extend total=sel_n+base_n
    | sort by total desc
    | limit ${safeTop}
    | extend attr_name=${kqlStringLiteral(a)}
    | project attr_name, attr_value, sel_n, base_n`;
}

// ─────────────────────────────────────────────────────────────────
// Metrics queries — see metricsBase() for the schema overview.
// ─────────────────────────────────────────────────────────────────

/**
 * Discover all metric names in the window. Reads the `_metric` field
 * that every generic_metrics record carries — one metric per row, so
 * `summarize by _metric` yields the workspace's full catalog with
 * accurate sample counts, distinct-service counts, and metric type.
 *
 * Used both as the live fallback in `listMetrics()` and as the
 * scheduled search `criblapm__metric_catalog` (results land in
 * `$vt_results`, the Metrics page reads them in ~1s).
 *
 * ## The previous approach and why it was broken
 *
 * v0.10.x used `extract("\"([a-zA-Z][a-zA-Z0-9._]*)\"\\s*:\\s*-?[0-9]",
 * 1, _raw)` — a regex that captures the first quoted-identifier /
 * colon / number pattern in the JSON. On staging every metric record
 * starts with a `scope` object whose `dropped_attributes_count` is a
 * numeric field appearing before any real metric name. `extract`
 * returns only the first match per record, so every row bucketed
 * under `dropped_attributes_count` — the picker showed one useless
 * "metric" and no real ones. Verified via MCP against the deployed
 * v0.10.2 pack (2026-07-13): 165,520 of 165,520 records have
 * `_metric` populated, and switching to `_metric` produced the
 * expected 20+ real names (system.cpu.time, k8s.*, postgresql.*,
 * traces.span.metrics.duration, ...).
 */
export function listMetricNames(): string {
  return `${metricsBase()}
    | where isnotnull(_metric)
    | extend svc=tostring(['service.name'])
    | summarize samples=count(), services=dcount(svc),
                metric_type=max(_metric_type)
      by name=tostring(_metric)
    | sort by name asc
    | limit 500`;
}

// ─────────────────────────────────────────────────────────────────
// Span-derived metric emitters — `export to metrics` into the fast
// PromQL store. These replace the read-side of the `$vt_results` RED
// panel caches; see docs/metrics-migration-plan.md. Validated live
// 2026-07-23 (session log §"Phase 0 write-path — VALIDATED").
//
// Two syntax rules baked in below (both cost a session to find):
//  1. After `summarize … by bin(_time,1m)` the time column is
//     `bin_time_1m`; rename it to `_time` or the export drops every
//     event with no error.
//  2. Histogram type is the LITERAL `type=histogram` param; counter is
//     `typeField=<field>` (the literal `type=` only accepts histogram,
//     and `"histogram"` via typeField drops as invalid_type).
// Always confirm an emit with the export output table
// (eventsOut/eventsDropped/dropReasons) — a `completed` job can drop
// 100% of events.
// ─────────────────────────────────────────────────────────────────

/**
 * Request/error counter emitter. Emits `criblapm_requests_total` as a
 * per-1-minute **delta** counter labelled by (svc, outcome) where
 * outcome ∈ {ok, error}. One metric labelled by outcome (rather than two
 * metrics) so error-rate is `{outcome="error"} / all` at read time.
 *
 * Read with `sum_over_time` — NOT `rate()`. The store keeps each emitted
 * per-bin count verbatim (delta storage), so `rate()`/`increase()` (which
 * assume a cumulative counter) return nonsense. See metricNames.ts.
 *
 * Stream filter applied so idle-poll noise doesn't inflate counts,
 * matching serviceSummary()/serviceTimeSeries().
 */
export function metricRequestsExport(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            operation=tostring(name),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            outcome=iff(tostring(status.code)=="2", "error", "ok")
    | where isnotempty(svc)
    ${entrySpanKindClause()}
    ${streamFilterSpanKqlClause()}
    | summarize value=count() by bin(_time, 1m), svc, operation, outcome
    | project-rename _time=bin_time_1m
    | extend name="${METRIC_REQUESTS_TOTAL}", type="counter"
    | export to metrics typeField=type timeField=_time nameField=name valueField=value labelFields=[svc, operation, outcome]`;
}

/**
 * HTTP/gRPC status-class counter emitter. Emits `criblapm_status_class_total`
 * as a per-1-minute delta counter labelled by (svc, status_class), powering
 * the Service Detail "Status mix" chart from metrics instead of a live KQL
 * span scan. Same entry-span scope + stream filter + status_class case as
 * the KQL `serviceStatusCodeMix()` so the two read paths agree. Read with
 * `sum_over_time` (delta storage).
 */
export function metricStatusClassExport(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            http_status=coalesce(toint(attributes['http.response.status_code']),
                                 toint(attributes['http.status_code'])),
            grpc_status=toint(attributes['rpc.grpc.status_code'])
    | where isnotempty(svc)
    ${entrySpanKindClause()}
    ${streamFilterSpanKqlClause()}
    | extend status_class=case(
        http_status == 503, "503",
        http_status == 504, "504",
        http_status == 502, "502",
        http_status == 500, "500",
        http_status >= 500 and http_status < 600, "other_5xx",
        http_status >= 400 and http_status < 500, "4xx",
        isnotnull(grpc_status) and grpc_status != 0, "grpc_err",
        "ok")
    | summarize value=count() by bin(_time, 1m), svc, status_class
    | project-rename _time=bin_time_1m
    | extend name="${METRIC_STATUS_CLASS_TOTAL}", type="counter"
    | export to metrics typeField=type timeField=_time nameField=name valueField=value labelFields=[svc, status_class]`;
}

const QUANTILE_LABEL: Record<number, string> = { 50: 'p50', 95: 'p95', 99: 'p99' };

/**
 * PRECOMPUTED latency-percentile GAUGE emitter. Computes
 * `percentile(dur_ms, q)` from raw entry spans per (svc[, operation]) per
 * minute and emits it as a gauge labelled `quantile`. One search per
 * (family, quantile) — Cribl's `export to metrics` drops rows when 3
 * percentiles are unioned into one export, but a single-percentile export
 * is clean. These REPLACE the `histogram_quantile` reads, which were slow
 * and wrong for bimodal latency (the auto-bucketed histogram lost the slow
 * tail). Read with promServiceLatencyGauge / promOpLatencyGauge.
 */
export function metricLatencyPercentileExport(
  q: 50 | 95 | 99,
  opts?: { byOperation?: boolean },
): string {
  const byOp = !!opts?.byOperation;
  const name = byOp ? METRIC_OP_LATENCY_MS : METRIC_REQUEST_LATENCY_MS;
  const groupBy = byOp ? 'bin(_time, 1m), svc, operation' : 'bin(_time, 1m), svc';
  const labels = byOp ? '[svc, operation, quantile]' : '[svc, quantile]';
  const opExtend = byOp ? '\n            operation=tostring(name),' : '';
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),${opExtend}
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            dur_ms=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000000.0
    | where isnotempty(svc) and dur_ms >= 0
    ${entrySpanKindClause()}
    ${streamFilterSpanKqlClause()}
    | summarize value=percentile(dur_ms, ${q}) by ${groupBy}
    | project-rename _time=bin_time_1m
    | extend name="${name}", type="gauge", quantile="${QUANTILE_LABEL[q]}"
    | export to metrics typeField=type timeField=_time nameField=name valueField=value labelFields=${labels}`;
}

/**
 * Latency histogram emitter. Emits `criblapm_request_duration_ms` as a
 * `hist_default` by feeding **raw per-span durations** (many rows share
 * the 1-minute `_time`, name, and svc label); the store buckets them.
 * Read percentiles with `histogram_quantile(...)`.
 *
 * Volume note: one row per span. On busy windows the search's ~50k input
 * cap can bias the histogram (dropped spans). The scheduled search runs
 * over a narrow incremental window (see provisionedSearches.ts) to stay
 * under the cap; revisit with sampling if `eventsDropped` shows up.
 */
export function metricDurationExport(opts?: { sampleRate?: number }): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            operation=tostring(name),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            dur_ms=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000000.0,
            _time=bin(_time, 1m)
    | where isnotempty(svc) and dur_ms >= 0
    ${entrySpanKindClause()}
    ${sampleFirstHexClause(opts?.sampleRate ?? 1)}
    ${streamFilterSpanKqlClause()}
    | project _time, svc, operation, dur_ms
    | extend name="${METRIC_REQUEST_DURATION_MS}"
    | export to metrics type=histogram timeField=_time nameField=name valueField=dur_ms labelFields=[svc, operation]`;
}

/**
 * Service→service RPC edge call counter. Same parent_span_id self-join
 * as dependencies() — each edge is (caller → callee) with the call count
 * split by outcome. Emitted as a delta counter labelled by (parent,
 * child, outcome); read for the System Architecture graph. The self-join
 * is the heaviest emitter, but runs over the incremental window only.
 */
export function metricEdgeCallsExport(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            parent_sid=tostring(parent_span_id),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            outcome=iff(tostring(status.code)=="2", "error", "ok")
    | where parent_sid != "" and isnotempty(parent_sid)
    ${streamFilterSpanKqlClause()}
    | project _time, trace_id, parent_sid, svc, outcome
    | join kind=inner (
        ${spansBase()}
        | extend psvc=tostring(resource.attributes['service.name']),
                psid=tostring(span_id)
        | project trace_id, psid, psvc
      ) on trace_id, $left.parent_sid == $right.psid
    | where svc != psvc
    | summarize value=count() by bin(_time, 1m), parent=psvc, child=svc, outcome
    | project-rename _time=bin_time_1m
    | extend name="${METRIC_EDGE_CALLS_TOTAL}", type="counter"
    | export to metrics typeField=type timeField=_time nameField=name valueField=value labelFields=[parent, child, outcome]`;
}

/** Edge latency histogram — child-span duration per (parent, child). */
export function metricEdgeDurationExport(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            parent_sid=tostring(parent_span_id),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            dur_ms=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000000.0,
            _time=bin(_time, 1m)
    | where parent_sid != "" and isnotempty(parent_sid) and dur_ms >= 0
    ${streamFilterSpanKqlClause()}
    | project _time, trace_id, parent_sid, svc, dur_ms
    | join kind=inner (
        ${spansBase()}
        | extend psvc=tostring(resource.attributes['service.name']),
                psid=tostring(span_id)
        | project trace_id, psid, psvc
      ) on trace_id, $left.parent_sid == $right.psid
    | where svc != psvc
    | project _time, parent=psvc, child=svc, dur_ms
    | extend name="${METRIC_EDGE_DURATION_MS}"
    | export to metrics type=histogram timeField=_time nameField=name valueField=dur_ms labelFields=[parent, child]`;
}

/** Edge latency p95 GAUGE emitter — precomputed percentile(dur_ms,95) per
 *  (parent, child) per minute. Replaces the histogram_quantile edge read. */
export function metricEdgeLatencyP95Export(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            parent_sid=tostring(parent_span_id),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            dur_ms=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000000.0,
            _time=bin(_time, 1m)
    | where parent_sid != "" and isnotempty(parent_sid) and dur_ms >= 0
    ${streamFilterSpanKqlClause()}
    | project _time, trace_id, parent_sid, svc, dur_ms
    | join kind=inner (
        ${spansBase()}
        | extend psvc=tostring(resource.attributes['service.name']),
                psid=tostring(span_id)
        | project trace_id, psid, psvc
      ) on trace_id, $left.parent_sid == $right.psid
    | where svc != psvc
    | summarize value=percentile(dur_ms, 95) by _time, parent=psvc, child=svc
    | extend name="${METRIC_EDGE_LATENCY_MS}", type="gauge", quantile="p95"
    | export to metrics typeField=type timeField=_time nameField=name valueField=value labelFields=[parent, child, quantile]`;
}

/** Messaging (kafka etc.) edge counter, labelled by (svc, dest, op,
 *  system, outcome). Mirrors messagingDependencies(). */
export function metricMessagingExport(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            outcome=iff(tostring(status.code)=="2", "error", "ok"),
            op=tostring(attributes['messaging.operation']),
            dest=tostring(attributes['messaging.destination.name']),
            system=tostring(attributes['messaging.system'])
    | where isnotempty(dest) and isnotempty(op)
    ${streamFilterSpanKqlClause()}
    | summarize value=count() by bin(_time, 1m), svc, dest, op, system, outcome
    | project-rename _time=bin_time_1m
    | extend name="${METRIC_MESSAGING_TOTAL}", type="counter"
    | export to metrics typeField=type timeField=_time nameField=name valueField=value labelFields=[svc, dest, op, system, outcome]`;
}

/** Messaging latency histogram per (svc, dest, op, system). */
export function metricMessagingDurationExport(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            dur_ms=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000000.0,
            _time=bin(_time, 1m),
            op=tostring(attributes['messaging.operation']),
            dest=tostring(attributes['messaging.destination.name']),
            system=tostring(attributes['messaging.system'])
    | where isnotempty(dest) and isnotempty(op) and dur_ms >= 0
    ${streamFilterSpanKqlClause()}
    | project _time, svc, dest, op, system, dur_ms
    | extend name="${METRIC_MESSAGING_DURATION_MS}"
    | export to metrics type=histogram timeField=_time nameField=name valueField=dur_ms labelFields=[svc, dest, op, system]`;
}

/** Messaging latency p95 GAUGE emitter — precomputed percentile(dur_ms,95)
 *  per (svc, dest, op, system) per minute. Replaces the histogram read. */
export function metricMessagingLatencyP95Export(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            dur_ms=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000000.0,
            _time=bin(_time, 1m),
            op=tostring(attributes['messaging.operation']),
            dest=tostring(attributes['messaging.destination.name']),
            system=tostring(attributes['messaging.system'])
    | where isnotempty(dest) and isnotempty(op) and dur_ms >= 0
    ${streamFilterSpanKqlClause()}
    | summarize value=percentile(dur_ms, 95) by _time, svc, dest, op, system
    | extend name="${METRIC_MSG_LATENCY_MS}", type="gauge", quantile="p95"
    | export to metrics typeField=type timeField=_time nameField=name valueField=value labelFields=[svc, dest, op, system, quantile]`;
}

/**
 * Span counts per coarse bin — the "count first" pass for metrics
 * backfill (src/api/metricsBackfill.ts). Matches the request-duration
 * emitter's input scope (all stream-filtered spans, the largest emitter)
 * so the chunk sizing is conservative for every emitter. Output columns:
 * `t` (bin start, epoch seconds) and `n` (span count).
 */
export function backfillSpanCounts(binSeconds: number): string {
  const bin = kqlInteger(binSeconds, { min: 60, max: 86_400 });
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
    | where isnotempty(svc)
    ${streamFilterSpanKqlClause()}
    | summarize n=count() by t=bin(_time, ${bin}s)
    | sort by t asc`;
}

/**
 * Raw sample records for client-side metric-name discovery as a
 * fallback when the scheduled search cache isn't populated yet.
 */
export function metricSampleRecords(limit: number = 500): string {
  return `${metricsBase()} | limit ${kqlInteger(limit, { min: 1, max: 10_000 })}`;
}

/**
 * Distinct services that emit a given metric in the window. Populates
 * the "Service" filter dropdown on the Metrics tab — scoped to what
 * actually has data, rather than the global service list which
 * includes services that don't emit this particular metric.
 */
export function metricServices(metricName: string): string {
  return `${metricsBase()}
    | where isnotnull(${mf(metricName)})
    | extend svc=tostring(['service.name'])
    | where isnotempty(svc)
    | summarize by svc
    | sort by svc asc`;
}

export interface MetricSeriesParams {
  metric: string;
  /** Optional exact service.name filter. */
  service?: string;
  /** Bucket width in seconds for the time bucket. */
  binSeconds: number;
  /** Aggregation function to apply over the bucketed values. */
  agg:
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
   * Optional group-by dimension key. When set, the summarize
   * partitions the result by that attribute (e.g. "service.name",
   * "rpc.method"). Dimension is accessed via bracket-quoted syntax
   * and stringified, matching how metric records expose top-level
   * attributes.
   */
  groupBy?: string;
}

/**
 * Translate an aggregation choice to a KQL expression over a named
 * metric field. In the wide-column schema the metric value lives in
 * a top-level field (e.g. `['postgresql.backends']`) rather than the
 * old `_value` column. `count` has no argument, `rate` is really
 * `max(field)` (client computes the delta), and `pN` goes through
 * `percentile`.
 */
function metricAggExpr(metric: string, agg: MetricSeriesParams['agg']): string {
  const field = `toreal(${mf(metric)})`;
  switch (agg) {
    case 'count':
      return 'count()';
    case 'rate':
      // Rate is computed client-side from successive bucket maxes —
      // for monotonic counters the max within a bucket is the latest
      // cumulative count, and the rate is (Δcount / Δbucket).
      return `max(${field})`;
    case 'p50':
      return `percentile(${field}, 50)`;
    case 'p75':
      return `percentile(${field}, 75)`;
    case 'p95':
      return `percentile(${field}, 95)`;
    case 'p99':
      return `percentile(${field}, 99)`;
    default:
      return `${agg}(${field})`;
  }
}

/**
 * Time-bucketed metric series. Groups by `bin(_time, Ns)` and applies
 * the chosen aggregation over `_value`. Optionally partitions by a
 * group-by dimension, producing one series per dimension value.
 *
 * Semantics:
 *
 *  - **Gauges** (e.g. `k8s.container.memory_request`): `avg` over the
 *    bucket gives the expected "value at that time" since gauges are
 *    sampled periodically.
 *  - **Histograms** (e.g. `rpc.client.duration`): `_value` is the
 *    pre-computed mean across the collector's export interval.
 *    `percentile(_value, 95)` is "p95 of per-export means" — not a
 *    true p95 across raw observations, but directionally correct and
 *    a meaningful upgrade over plain mean. A real p95 would require
 *    parsing the cumulative bucket map in `${name}_data._buckets`.
 *  - **Counters** (e.g. `traces.span.metrics.calls`): `_value` is
 *    cumulative and monotonic. `rate` asks for `max(_value)` per
 *    bucket and the client derives the per-bucket delta divided by
 *    bin width to get a human-readable per-second rate. Plain `max`
 *    shows the raw cumulative line, which climbs.
 *  - **`count`** returns the number of raw metric records in each
 *    bucket, useful for "is this metric still being emitted?" sanity
 *    checks.
 */
export function metricTimeSeries(params: MetricSeriesParams): string {
  const svcFilter = params.service
    ? `| where svc == ${kqlStringLiteral(params.service)}`
    : '';
  const aggExpr = metricAggExpr(params.metric, params.agg);
  const bin = kqlInteger(params.binSeconds, { min: 1, max: 86_400 });
  // Group-by: append a dimension column to the summarize. Dimension
  // values are accessed via bracket-quoted syntax (resource attributes
  // live at the top level of metric records) and coerced to strings.
  const groupExt = params.groupBy
    ? `, grp=tostring(${kqlBracketField(params.groupBy)})`
    : '';
  const groupBy = params.groupBy ? ', grp' : '';
  return `${metricsBase()}
    | where isnotnull(${mf(params.metric)})
    | extend svc=tostring(['service.name'])${groupExt}
    ${svcFilter}
    | summarize val=${aggExpr}
      by bucket=bin(_time, ${bin}s)${groupBy}
    | sort by bucket asc`;
}

/**
 * Fetch a single raw metric record so we can sniff its type and
 * available attribute keys. Returns `_raw` plus any top-level fields
 * the Cribl query layer materialized. Used by getMetricInfo().
 */
export function metricSampleRow(metricName: string): string {
  return `${metricsBase()}
    | where isnotnull(${mf(metricName)})
    | limit 1`;
}

// ─────────────────────────────────────────────────────────────────
// Service Detail: protocol / runtime / infra cards
// ─────────────────────────────────────────────────────────────────

/**
 * Fetch a sample of raw metric records for a given service, for
 * client-side metric-name discovery. In the wide-column schema each
 * metric is a top-level numeric field — there is no single `_metric`
 * column. The caller (search.ts) inspects the returned rows to build
 * the metric name list. Scoped by both `service.name` and
 * `k8s.deployment.name` so the k8s-cluster-receiver metrics
 * (which don't set service.name) are also picked up.
 *
 * Note: Cribl KQL doesn't accept `tostring(...)==X or tostring(...)==Y`
 * inline — it can't parse the OR of two function expressions. We
 * have to `extend` the columns first, then filter. Same pattern
 * in the other per-service queries below.
 */
export function serviceMetricSampleRecords(service: string, limit: number = 500): string {
  const s = kqlStringLiteral(service);
  const safeLimit = kqlInteger(limit, { min: 1, max: 10_000 });
  return `${metricsBase()}
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name'])
    | where svc == ${s} or dep == ${s}
    | limit ${safeLimit}`;
}

/**
 * Latest-value query for a single metric scoped to a service.
 * Uses the same service-name-or-k8s-deployment-name fallback as
 * serviceMetricSampleRecords so k8s cluster metrics (which have
 * null service.name) still correlate back to app services by
 * deployment name. Returns one row with the most recent value.
 */
export function serviceMetricLatest(
  service: string,
  metric: string,
): string {
  const s = kqlStringLiteral(service);
  return `${metricsBase()}
    | where isnotnull(${mf(metric)})
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name'])
    | where svc == ${s} or dep == ${s}
    | sort by _time desc
    | limit 1
    | project val=toreal(${mf(metric)})`;
}

/**
 * Delta query for a cumulative counter scoped to a service over
 * the current window. Used by the "restarts in the window" display
 * where what matters is "did this number change" not "what is the
 * lifetime value". Per-time-series delta (by pod/container) to
 * avoid the same mis-aggregation bug spanmetrics hit.
 */
export function serviceMetricDelta(
  service: string,
  metric: string,
): string {
  const s = kqlStringLiteral(service);
  return `${metricsBase()}
    | where isnotnull(${mf(metric)})
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name']),
             pod=tostring(['k8s.pod.name']),
             container=tostring(['k8s.container.name'])
    | where svc == ${s} or dep == ${s}
    | summarize d=max(toreal(${mf(metric)}))-min(toreal(${mf(metric)}))
      by pod, container
    | summarize delta=sum(d)`;
}

/**
 * Time-series for a service metric with the same service matching
 * fallback as serviceMetricSampleRecords. Used by the runtime/infra/protocol
 * cards to populate their sparklines. Returns (bucket, val) rows
 * where val is percentile(_value, 95) for histogram-like metrics,
 * or the aggregation the caller picks.
 */
export function serviceMetricTimeSeries(
  service: string,
  metric: string,
  binSeconds: number,
  agg: 'avg' | 'max' | 'p95' = 'p95',
): string {
  const s = kqlStringLiteral(service);
  const bin = kqlInteger(binSeconds, { min: 1, max: 86_400 });
  const field = `toreal(${mf(metric)})`;
  let aggExpr: string;
  if (agg === 'p95') {
    aggExpr = `percentile(${field}, 95)`;
  } else if (agg === 'max') {
    aggExpr = `max(${field})`;
  } else {
    aggExpr = `avg(${field})`;
  }
  return `${metricsBase()}
    | where isnotnull(${mf(metric)})
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name'])
    | where svc == ${s} or dep == ${s}
    | summarize val=${aggExpr} by bucket=bin(_time, ${bin}s)
    | sort by bucket asc`;
}

/**
 * Latency anomaly detector that joins the current-window per-op
 * p95 against the `criblapm_op_baselines` lookup maintained by
 * the scheduled baseline search (§2b.1 in the ROADMAP). The join
 * keeps the anomaly check to a single round trip and uses a
 * hash-join against a cached CSV, so the read is sub-second even
 * against an idle worker pool.
 *
 * Returns one row per anomalous (service, operation). Each row
 * has: svc, op, curr_p95_us, prev_p95_us, ratio, requests.
 *
 * Filter chain:
 *   - `isnotnull(prev_p95_us)` drops ops that aren't in the
 *     baseline lookup (new ops since the last scheduled run).
 *     Cache miss is NOT an anomaly — wait a schedule cycle.
 *   - `prev_requests >= minBaselineRequests` skips baselines
 *     with too few samples to be reliable.
 *   - `curr_p95_us >= minCurrP95Us` skips sub-second "anomalies"
 *     that nobody would act on (a 5× jump from 10ms → 50ms is
 *     technically anomalous but noise-level).
 *   - `curr_p95_us >= prev_p95_us * minRatio` is the core
 *     "N× baseline" threshold.
 *
 * The lookup columns come back as strings because `export to
 * lookup` emits CSV, so we `toreal()` them before comparing.
 * Naming note: the current summarize produces a `requests`
 * column and the lookup also has a `requests` column; the second
 * shadows the first during join, so we alias to `curr_count`
 * before the lookup to preserve it.
 */
export function operationAnomaliesFromLookup(
  minRatio: number,
  minCurrP95Us: number,
  minBaselineRequests: number,
  topN: number,
): string {
  const ratio = kqlFiniteNumber(minRatio, { min: 1 });
  const currP95 = kqlFiniteNumber(minCurrP95Us, { min: 0 });
  const baselineRequests = kqlInteger(minBaselineRequests, { min: 0 });
  const limit = kqlInteger(topN, { min: 1, max: 10_000 });
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
             dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
    ${streamFilterSpanKqlClause()}
    | summarize curr_p95_us=percentile(dur_us, 95),
                curr_count=count()
      by svc, op=name
    | lookup criblapm_op_baselines on svc, op
    | extend prev_p95_us=toreal(p95_us),
             prev_requests=toreal(requests)
    | where isnotnull(prev_p95_us) and prev_p95_us > 0
    | where curr_p95_us >= prev_p95_us * ${ratio}
      and curr_p95_us >= ${currP95}
      and prev_requests >= ${baselineRequests}
    | project svc, op,
              curr_p95_us,
              prev_p95_us,
              requests=curr_count,
              ratio=curr_p95_us/prev_p95_us
    | sort by ratio desc
    | limit ${limit}`;
}

/**
 * Batched time-series: fetch raw rows for multiple metrics in a single
 * query. In the wide-column schema each metric is a separate numeric
 * field, so we filter for rows where ANY of the requested metrics is
 * non-null, then return the raw rows. Client-side (search.ts) unpivots
 * the wide columns into per-metric (bucket, value) series.
 */
export function serviceMetricsBatch(
  service: string,
  metrics: string[],
  binSeconds: number,
): string {
  const s = kqlStringLiteral(service);
  const bin = kqlInteger(binSeconds, { min: 1, max: 86_400 });
  if (metrics.length === 0 || metrics.length > 100) {
    throw new Error('serviceMetricsBatch requires between 1 and 100 metrics');
  }
  const whereClause = metrics.map((m) => `isnotnull(${mf(m)})`).join(' or ');
  return `${metricsBase()}
    | where ${whereClause}
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name'])
    | where svc == ${s} or dep == ${s}
    | extend bucket=bin(_time, ${bin}s)
    | sort by bucket asc`;
}
