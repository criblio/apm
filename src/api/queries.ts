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
import { DEFAULT_FILTER_RULES, compileFilterRulesToKql } from './errorFilter';

function quoteDataset(): string {
  // The dataset name must be a simple identifier to embed safely as
  // dataset="...". We strip any non-safe characters as a cheap guard.
  return getCurrentDataset().replace(/[^a-zA-Z0-9_-]/g, '');
}

function datasetClause(): string {
  return `dataset="${quoteDataset()}"`;
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
  return `['${metric.replace(/'/g, "\\'")}']`;
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
  const s = service.replace(/"/g, '\\"');
  return `${spansBase()}
    | extend svc=${svcExpr(opts)}
    | where svc=="${s}"
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
    const s = params.service.replace(/"/g, '\\"');
    spanFilters.push(`svc=="${s}"`);
  }
  if (params.operation) {
    const o = params.operation.replace(/"/g, '\\"');
    spanFilters.push(`name=="${o}"`);
  }

  // Tag filters: "error=true http.status_code=500"
  if (params.tags) {
    for (const pair of params.tags.split(/\s+/).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const k = pair.slice(0, eq).replace(/"/g, '\\"');
      const v = pair.slice(eq + 1).replace(/"/g, '\\"');
      spanFilters.push(`tostring(attributes['${k}'])=="${v}"`);
    }
  }

  // Pre-built KQL predicate from FilterBuilder + KqlEditor on
  // SearchPage. Wrapped in parens so any internal `and`/`or` doesn't
  // bind across the surrounding spanFilters.join().
  if (params.predicateKql && params.predicateKql.trim()) {
    spanFilters.push(`(${params.predicateKql.trim()})`);
  }

  // Trace-level filters — applied AFTER the summarize. Duration is the
  // full (max_end − min_start) window of the spans that survived the per-span
  // filter, matching Jaeger's semantics ("traces where X took ≥ N ms").
  const traceFilters: string[] = [];
  if (params.minDurationUs != null) {
    traceFilters.push(`trace_dur_us >= ${params.minDurationUs}`);
  }
  if (params.maxDurationUs != null) {
    traceFilters.push(`trace_dur_us <= ${params.maxDurationUs}`);
  }

  const spanWhere = spanFilters.length ? `| where ${spanFilters.join(' and ')}` : '';
  const traceWhere = traceFilters.length ? `| where ${traceFilters.join(' and ')}` : '';
  const lim = params.limit ?? 20;

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
  const inList = traceIds.map((id) => `"${id}"`).join(', ');
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
    ? `| where svc=="${service.replace(/"/g, '\\"')}"`
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
  return `${spansBase()}
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
    | export mode=overwrite
             description="Cribl APM - previous window service summary"
             to lookup criblapm_alert_prev`;
}

/**
 * Alert evaluator — reads current-window summaries from the cached
 * home_service_summary $vt_results, joins previous-window from the
 * criblapm_alert_prev lookup, computes health, joins alert state
 * from criblapm_alert_states lookup, applies state machine, and
 * exports updated state back. Output goes to $vt_results for the
 * UI.
 *
 * Runs 1 minute after the summary searches so their results are
 * available.
 */
export function alertEvaluator(): string {
  const FIRE_AFTER = 2;
  const CLEAR_AFTER = 3;

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
    | extend prev_requests=iff(isnotnull(prev_req), toreal(prev_req), 0.0),
             prev_errors=iff(isnotnull(prev_err), toreal(prev_err), 0.0),
             prev_error_rate=iff(isnotnull(prev_err_rate), toreal(prev_err_rate), 0.0)
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
    // Reintroducing those would need an explicit "low-volume mode"
    // toggle in settings rather than default-on for everyone.
    | extend signal_type=case(
               curr_requests == 0 and prev_requests >= 50, "silent",
               curr_err_pct >= 5 and curr_requests >= 20, "error_rate",
               curr_err_pct >= 2 and curr_err_pct >= prev_err_pct * 3
                 and prev_requests >= 100, "error_rate",
               curr_errors >= 10 and prev_errors < 1
                 and curr_requests >= 50, "error_rate",
               traffic_ratio <= 0.5 and prev_requests >= 50, "traffic_drop",
               "none"),
             is_bad=(
               (curr_requests == 0 and prev_requests >= 50)
               or (curr_err_pct >= 5 and curr_requests >= 20)
               or (curr_err_pct >= 2 and curr_err_pct >= prev_err_pct * 3
                   and prev_requests >= 100)
               or (curr_errors >= 10 and prev_errors < 1
                   and curr_requests >= 50)
               or (traffic_ratio <= 0.5 and prev_requests >= 50))
    // alert_id is STABLE per service (doesn't include signal_type).
    // Why: when a service recovers, signal_type rotates from
    // "error_rate" → "none", so an signal_type-keyed alert_id
    // would change too. The state export uses mode=overwrite, so
    // the old "auto:error_rate:svc" row gets wiped before the
    // state machine ever sees prev_status="firing" on the new
    // "auto:none:svc" key — meaning the resolving→ok walk never
    // fires, no "resolved" event is emitted, and the Alert Timeline
    // shows the alert as "ongoing" forever. Stable key fixes this.
    | extend alert_id=strcat("auto:health:", svc)
    | lookup criblapm_alert_states on alert_id
    | extend prev_status=iff(isnotnull(alert_status), tostring(alert_status), "ok"),
             prev_bad=iff(isnotnull(consecutive_bad), tolong(consecutive_bad), 0),
             prev_good=iff(isnotnull(consecutive_good), tolong(consecutive_good), 0),
             prev_fire_count=iff(isnotnull(fire_count), tolong(fire_count), 0)
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
              alert_id, signal_type, is_bad, is_persistent,
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
                 signal_type="latency",
                 is_bad=true,
                 is_persistent=false,
                 curr_errors=0.0, curr_error_rate=0.0,
                 prev_requests=prev_op_requests, prev_errors=0.0, prev_error_rate=0.0
        | lookup criblapm_alert_states on alert_id
        | extend prev_status=iff(isnotnull(alert_status), tostring(alert_status), "ok"),
                 prev_bad=iff(isnotnull(consecutive_bad), tolong(consecutive_bad), 0),
                 prev_good=iff(isnotnull(consecutive_good), tolong(consecutive_good), 0),
                 prev_fire_count=iff(isnotnull(fire_count), tolong(fire_count), 0)
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
                  alert_id, signal_type, is_bad, is_persistent,
                  alert_status, consecutive_bad, consecutive_good,
                  fire_count, transitioned_to
    )`;
}

/**
 * Companion to alertEvaluator — exports the state machine columns
 * to the criblapm_alert_states lookup for persistence across cycles.
 * Separate search because | export consumes the rows.
 */
export function alertEvaluatorExportState(): string {
  const base = alertEvaluator();
  return `${base}
    | where alert_status != "ok" or consecutive_good > 0
    | project alert_id, alert_status, consecutive_bad, consecutive_good, fire_count
    | export mode=overwrite
             description="Cribl APM - alert state persistence"
             to lookup criblapm_alert_states`;
}

/**
 * Sends alert state transition events (firing, resolved) back to
 * the otel dataset as searchable history. Only emits rows where
 * transitioned_to is non-empty — not every evaluation cycle.
 * Uses | send group="search" to route through the Local Search
 * HTTP input, with dataset="otel" so the event lands in the
 * otel lakehouse dataset.
 */
export function alertHistorySend(): string {
  const ds = quoteDataset();
  const base = alertEvaluator();
  return `${base}
    | where transitioned_to != ""
    | project _time=now(), dataset="${ds}",
              datatype="criblapm_alert",
              event_type=transitioned_to,
              alert_id, alert_status, svc,
              signal_type, is_persistent,
              curr_error_rate, prev_error_rate,
              curr_requests, prev_requests,
              fire_count, consecutive_bad
    | send group="search"`;
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
  const svcFilter = service ? `| where svc=="${service.replace(/"/g, '\\"')}"` : '';
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    ${svcFilter}
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                errors=countif(is_error),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99)
      by svc, bucket=bin(_time, ${binSeconds}s)
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
  const s = service.replace(/"/g, '\\"');
  // dur_us is computed for streamFilterSpanKqlClause(); without it
  // the injected `| where dur_us < ...` filters every row out.
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
             dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
             http_status=coalesce(toint(attributes['http.response.status_code']),
                                  toint(attributes['http.status_code'])),
             grpc_status=toint(attributes['rpc.grpc.status_code'])
    | where svc=="${s}"
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
    | summarize n=count() by status_class, bucket=bin(_time, ${binSeconds}s)
    | sort by bucket asc, status_class asc`;
}

/**
 * Top operations for a service, sorted by volume. Each row includes counts,
 * error rate, and percentile latencies — the core table on Service detail.
 */
export function serviceOperations(service: string, opts?: QueryOpts): string {
  const s = service.replace(/"/g, '\\"');
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    | where svc=="${s}"
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
  const s = service.replace(/"/g, '\\"');
  return `${spansBase()}
    | extend svc=${svcExpr(opts)},
            instance_id=tostring(resource.attributes['service.instance.id']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(${statusCodeExpr(opts)}=="2")
    | where svc=="${s}"
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
    | limit ${limit}`;
}

/**
 * Traces sorted by trace duration descending — "slow traces" panel on
 * the Home page. Optionally scoped to a service. Applies the same
 * long-poll / idle-wait filter as rawSlowestTraces() — see
 * api/streamFilter.ts. Includes `root_op` in the summarize so the
 * stream filter's kafka consumer exemption can reference it.
 */
export function slowestTraces(service?: string, opts?: QueryOpts): string {
  const svcFilter = service ? `| where svc=="${service.replace(/"/g, '\\"')}"` : '';
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
    | limit ${limit}`;
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
    | limit ${limit}
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
    ? `| where svc == "${svc.replace(/"/g, '\\"')}"`
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
    | extend ua_browser=(ua matches regex "(?i)(mozilla|chrome|safari|firefox|edge|opera)"),
             ua_loadtest=(ua matches regex "(?i)(k6|locust|jmeter|gatling|wrk|ab/|loadgen)"),
             ua_probe=(ua matches regex "(?i)(kube-probe|go-http-client|healthcheck|liveness|readiness)"),
             has_msg=isnotempty(msg_sys),
             name_user=(span_name matches regex "(?i)(^|_)(user|browse|view|checkout|cart|search)(_|$)"),
             name_service=(span_name matches regex "(?i)(^|_)(tick|cron|consume|process|poll|worker|job|task)(_|$)")
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
  const svcFilter = service ? `| where svc=="${service.replace(/"/g, '\\"')}"` : '';
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
    const s = params.service.replace(/"/g, '\\"');
    filters.push(`tostring(resource.attributes['service.name'])=="${s}"`);
  }
  // NOTE: do NOT wrap severity_number in toreal() here. The otel
  // dataset stores severity_number as an int; toreal() on an int
  // column in Cribl KQL returns zero rows instead of coercing — tested
  // empirically: `toreal(severity_number) >= 9` matches 0 events while
  // `severity_number >= 9` matches all 18k INFO logs. Compare the raw
  // int directly.
  if (params.minSeverity != null) {
    filters.push(`severity_number >= ${params.minSeverity}`);
  }
  if (params.maxSeverity != null) {
    filters.push(`severity_number <= ${params.maxSeverity}`);
  }
  if (params.bodyContains) {
    // Cribl's `contains` is case-insensitive by default on strings.
    const needle = params.bodyContains.replace(/"/g, '\\"');
    filters.push(`tostring(body) contains "${needle}"`);
  }

  const lim = params.limit ?? 200;
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
  const t = traceId.replace(/"/g, '\\"');
  return `${datasetClause()}
    | where isnotnull(body) and isnotnull(severity_number)
    | where trace_id=="${t}"
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
  const a = attrName.replace(/'/g, "\\'");
  if (a === 'name' || a === 'kind') {
    return `tostring(${a})`;
  }
  const isResourceAttr = a.startsWith('k8s.') || a.startsWith('service.');
  return isResourceAttr
    ? `tostring(resource.attributes['${a}'])`
    : `tostring(attributes['${a}'])`;
}

export function attrValueDistribution(
  attrName: string,
  predicateKql: string,
  limit: number = 20,
): string {
  const a = attrName.replace(/'/g, "\\'");
  const pre = predicateKql ? `| where ${predicateKql}` : '';
  const valueExpr = attrValueExpr(attrName);
  return `${spansBase()}
    ${pre}
    | extend attr_value=${valueExpr}
    | where isnotempty(attr_value)
    | summarize n=count() by attr_value
    | sort by n desc
    | limit ${limit}
    | extend attr_name="${a}"
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
  const a = attrName.replace(/'/g, "\\'");
  const valueExpr = attrValueExpr(attrName);
  const scope = scopeKql && scopeKql.trim() ? scopeKql.trim() : '';
  const scopeWhere = scope ? `| where ${scope}` : '';
  // `not <bool>` is rejected inside countif() by Cribl's KQL
  // parser — explicit `== true` / `== false` comparisons work.
  // See https://github.com/criblio/apm DEVELOPMENT.md (or the
  // Cribl KQL gotchas section in agentContext.ts) for the
  // accumulating list of dialect quirks.
  return `${spansBase()}
    ${scopeWhere}
    | extend attr_value=${valueExpr},
             sel_match=${selectionKql || 'true'}
    | where isnotempty(attr_value)
    | summarize sel_n=countif(sel_match==true),
                base_n=countif(sel_match==false)
      by attr_value
    | extend total=sel_n+base_n
    | sort by total desc
    | limit ${top}
    | extend attr_name="${a}"
    | project attr_name, attr_value, sel_n, base_n`;
}

// ─────────────────────────────────────────────────────────────────
// Metrics queries — see metricsBase() for the schema overview.
// ─────────────────────────────────────────────────────────────────

/**
 * Discover all metric names in the window by extracting the numeric
 * field name from each record's _raw JSON. In the wide-column schema
 * each metric is a top-level field; this regex finds the first key
 * with a numeric value that isn't a known meta field.
 *
 * Also used as the scheduled search `criblapm__metric_catalog` so
 * the Metrics page reads the catalog from $vt_results in ~1s.
 */
export function listMetricNames(): string {
  // The regex finds any numeric field in _raw. This catches real
  // metrics (http.server.duration, redis.cpu.time) but also numeric
  // ATTRIBUTES that are dimensions, not measured values. The
  // blocklist excludes well-known OTel attribute names that are
  // numeric but not metrics (status codes, port numbers, PIDs, etc.)
  return `${metricsBase()}
    | extend metric_name=extract("\\"([a-zA-Z][a-zA-Z0-9._]*)\\"\\\\s*:\\\\s*-?[0-9]", 1, _raw)
    | where isnotempty(metric_name)
        and metric_name != "_metric_type"
        and metric_name != "_datatype_detection"
        and metric_name != "http.status_code"
        and metric_name != "http.flavor"
        and metric_name != "net.host.port"
        and metric_name != "net.peer.port"
        and metric_name != "process.pid"
        and metric_name != "rpc.grpc.status_code"
        and metric_name != "net.sock.peer.port"
        and metric_name != "net.sock.host.port"
        and metric_name != "http.response.status_code"
        and metric_name != "cpu"
        and metric_name != "partition"
    | extend svc=tostring(['service.name'])
    | summarize samples=count(), services=dcount(svc),
                metric_type=max(_metric_type)
      by name=metric_name
    | sort by name asc
    | limit 500`;
}

/**
 * Raw sample records for client-side metric-name discovery as a
 * fallback when the scheduled search cache isn't populated yet.
 */
export function metricSampleRecords(limit: number = 500): string {
  return `${metricsBase()} | limit ${limit}`;
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
    ? `| where svc == "${params.service.replace(/"/g, '\\"')}"`
    : '';
  const aggExpr = metricAggExpr(params.metric, params.agg);
  // Group-by: append a dimension column to the summarize. Dimension
  // values are accessed via bracket-quoted syntax (resource attributes
  // live at the top level of metric records) and coerced to strings.
  const groupExt = params.groupBy
    ? `, grp=tostring(['${params.groupBy.replace(/'/g, "\\'")}'])`
    : '';
  const groupBy = params.groupBy ? ', grp' : '';
  return `${metricsBase()}
    | where isnotnull(${mf(params.metric)})
    | extend svc=tostring(['service.name'])${groupExt}
    ${svcFilter}
    | summarize val=${aggExpr}
      by bucket=bin(_time, ${params.binSeconds}s)${groupBy}
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
// Spanmetrics-backed RED queries
//
// The OTel Collector's spanmetrics connector synthesizes two metrics
// from every span it processes:
//   - traces.span.metrics.calls    — monotonic counter
//   - traces.span.metrics.duration — histogram, bucket bounds in ms
// Both are tagged with at least (service.name, span.name, span.kind,
// status.code) where status.code is one of STATUS_CODE_OK,
// STATUS_CODE_ERROR, STATUS_CODE_UNSET.
//
// Using these for the Home catalog and Service Detail RED charts is
// orders of magnitude cheaper than raw-span aggregation at scale.
// Accuracy trade-off: `percentile(_value, N)` on the duration metric
// is percentile-of-means — the collector pre-computes a mean per
// export interval so we're aggregating over those means, not raw
// observations. Directionally correct, not perfectly accurate. For
// true histogram percentiles we'd need to parse the cumulative
// bucket map in `${name}_data._buckets`, tracked as a v2 in the
// ROADMAP.
//
// Counter rate semantics: rate over the window is derived from
// `max(_value) - min(_value)` divided by the window length, with
// resets handled by a max() aggregation (resets would make min()
// spuriously low but the max-min difference stays close to the
// true count unless the counter was reset DURING the window).
//
// Unit note: the duration histogram is emitted in milliseconds;
// multiply by 1000 at the API layer to match the existing
// microsecond-based ServiceSummary / ServiceBucket contract.
// ─────────────────────────────────────────────────────────────────

/** Build the metric-select WHERE clause used by every spanmetrics
 * query, optionally scoped to a single service. */
function spanmetricsBase(metric: string, service?: string): string {
  const svcFilter = service
    ? `| where tostring(['service.name'])=="${service.replace(/"/g, '\\"')}"`
    : '';
  return `${metricsBase()}
    | where isnotnull(${mf(metric)})
    | extend svc=tostring(['service.name']),
             op=tostring(['span.name']),
             status=tostring(['status.code'])
    ${svcFilter}`;
}

/**
 * Per-service RED summary from spanmetrics. Returns the same shape
 * as the raw-span serviceSummary() — svc, requests, errors,
 * error_rate, p50/95/99 in microseconds — so callers can swap
 * sources without changing transform code.
 *
 * IMPORTANT: the spanmetrics calls counter is emitted per
 * (service.name, span.name, span.kind, status.code) time series, so
 * we MUST compute the max/min delta per tuple and then sum. Merging
 * all tuples into one group and then doing max(_value)-min(_value)
 * at the service level over-counts massively because max picks the
 * biggest counter from the highest-volume op while min picks the
 * smallest from a low-volume op, and the difference has no real
 * meaning.
 */
export function spanmetricsServiceSummary(service?: string): string {
  const svcFilter = service
    ? `| where tostring(['service.name'])=="${service.replace(/"/g, '\\"')}"`
    : '';
  // Calls side: per-tuple deltas, then sum per service. `coalesce`
  // the error count so services with zero errors land at 0 instead
  // of the null that `sumif` returns on empty input.
  const calls = `${metricsBase()}
    | where isnotnull(['traces.span.metrics.calls'])
    | extend svc=tostring(['service.name']),
             op=tostring(['span.name']),
             status=tostring(['status.code'])
    ${svcFilter}
    | summarize delta=max(toreal(['traces.span.metrics.calls']))-min(toreal(['traces.span.metrics.calls']))
      by svc, op, status
    | summarize requests=sum(delta),
                errors_raw=sumif(delta, status=="STATUS_CODE_ERROR")
      by svc
    | extend errors=iff(isnull(errors_raw), 0.0, toreal(errors_raw))
    | extend error_rate=iff(requests>0, errors/toreal(requests), 0.0)`;
  // Duration side — percentile-of-means on the histogram's value
  // (which is the per-export mean the spanmetrics connector computes).
  // We multiply by 1000 to convert ms → µs.
  const duration = `${metricsBase()}
    | where isnotnull(['traces.span.metrics.duration'])
    | extend svc=tostring(['service.name'])
    ${svcFilter}
    | summarize p50_us=percentile(toreal(['traces.span.metrics.duration']), 50)*1000,
                p95_us=percentile(toreal(['traces.span.metrics.duration']), 95)*1000,
                p99_us=percentile(toreal(['traces.span.metrics.duration']), 99)*1000
      by svc`;
  return `${calls}
    | join kind=leftouter (${duration}) on svc
    | project svc, requests, errors, error_rate, p50_us, p95_us, p99_us
    | sort by requests desc`;
}

/**
 * Per-service bucketed RED time series from spanmetrics. Shape
 * matches the raw-span serviceTimeSeries() so existing transform
 * code works unchanged.
 *
 * Rate per bucket = max(_value) - min(_value) within the bucket on
 * the calls counter. Error counts are split out by status at the
 * same bucket/svc grouping level.
 */
export function spanmetricsServiceTimeSeries(
  binSeconds: number,
  service?: string,
): string {
  const svcFilter = service
    ? `| where tostring(['service.name'])=="${service.replace(/"/g, '\\"')}"`
    : '';
  // Per-tuple delta first so cross-operation counter values don't get
  // conflated; then sum per (svc, bucket) and coalesce nulls.
  const calls = `${metricsBase()}
    | where isnotnull(['traces.span.metrics.calls'])
    | extend svc=tostring(['service.name']),
             op=tostring(['span.name']),
             status=tostring(['status.code'])
    ${svcFilter}
    | summarize delta=max(toreal(['traces.span.metrics.calls']))-min(toreal(['traces.span.metrics.calls']))
      by svc, op, status, bucket=bin(_time, ${binSeconds}s)
    | summarize requests=sum(delta),
                errors_raw=sumif(delta, status=="STATUS_CODE_ERROR")
      by svc, bucket
    | extend errors=iff(isnull(errors_raw), 0.0, toreal(errors_raw))`;
  const duration = `${metricsBase()}
    | where isnotnull(['traces.span.metrics.duration'])
    | extend svc=tostring(['service.name'])
    ${svcFilter}
    | summarize p50_us=percentile(toreal(['traces.span.metrics.duration']), 50)*1000,
                p95_us=percentile(toreal(['traces.span.metrics.duration']), 95)*1000,
                p99_us=percentile(toreal(['traces.span.metrics.duration']), 99)*1000
      by svc, bucket=bin(_time, ${binSeconds}s)`;
  return `${calls}
    | join kind=leftouter (${duration}) on svc, bucket
    | project svc, bucket, requests, errors, p50_us, p95_us, p99_us
    | sort by svc asc, bucket asc`;
}

/**
 * Per-operation RED for a single service from spanmetrics. Shape
 * matches serviceOperations() so the Service Detail top-operations
 * table works unchanged.
 */
export function spanmetricsServiceOperations(service: string): string {
  const svc = service.replace(/"/g, '\\"');
  // (name, status) is already the per-tuple granularity here since
  // we're scoped to one service — one span.name with one status
  // value is a single time series. Coalesce null errors to 0.
  const calls = `${metricsBase()}
    | where isnotnull(['traces.span.metrics.calls'])
    | extend svc=tostring(['service.name']),
             name=tostring(['span.name']),
             status=tostring(['status.code'])
    | where svc=="${svc}"
    | summarize delta=max(toreal(['traces.span.metrics.calls']))-min(toreal(['traces.span.metrics.calls']))
      by name, status
    | summarize requests=sum(delta),
                errors_raw=sumif(delta, status=="STATUS_CODE_ERROR")
      by name
    | extend errors=iff(isnull(errors_raw), 0.0, toreal(errors_raw))
    | extend error_rate=iff(requests>0, errors/toreal(requests), 0.0)`;
  const duration = `${metricsBase()}
    | where isnotnull(['traces.span.metrics.duration'])
    | extend svc=tostring(['service.name']),
             name=tostring(['span.name'])
    | where svc=="${svc}"
    | summarize p50_us=percentile(toreal(['traces.span.metrics.duration']), 50)*1000,
                p95_us=percentile(toreal(['traces.span.metrics.duration']), 95)*1000,
                p99_us=percentile(toreal(['traces.span.metrics.duration']), 99)*1000
      by name`;
  return `${calls}
    | join kind=leftouter (${duration}) on name
    | project name, requests, errors, error_rate, p50_us, p95_us, p99_us
    | sort by requests desc
    | limit 50`;
}

/**
 * Presence probe: returns one row if the spanmetrics connector is
 * feeding the dataset. Called once at startup and cached so later
 * queries don't have to re-detect.
 */
export function spanmetricsPresence(): string {
  return `${metricsBase()}
    | where isnotnull(['traces.span.metrics.calls'])
    | limit 1
    | project _metric_type`;
}

// Silence unused-export lint for the helper that's only used from
// within this module — keeping spanmetricsBase as a hook for
// future cards that want to extend the spanmetrics query pattern.
void spanmetricsBase;

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
  const s = service.replace(/"/g, '\\"');
  return `${metricsBase()}
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name'])
    | where svc == "${s}" or dep == "${s}"
    | limit ${limit}`;
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
  const s = service.replace(/"/g, '\\"');
  return `${metricsBase()}
    | where isnotnull(${mf(metric)})
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name'])
    | where svc == "${s}" or dep == "${s}"
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
  const s = service.replace(/"/g, '\\"');
  return `${metricsBase()}
    | where isnotnull(${mf(metric)})
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name']),
             pod=tostring(['k8s.pod.name']),
             container=tostring(['k8s.container.name'])
    | where svc == "${s}" or dep == "${s}"
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
  const s = service.replace(/"/g, '\\"');
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
    | where svc == "${s}" or dep == "${s}"
    | summarize val=${aggExpr} by bucket=bin(_time, ${binSeconds}s)
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
    | where curr_p95_us >= prev_p95_us * ${minRatio}
      and curr_p95_us >= ${minCurrP95Us}
      and prev_requests >= ${minBaselineRequests}
    | project svc, op,
              curr_p95_us,
              prev_p95_us,
              requests=curr_count,
              ratio=curr_p95_us/prev_p95_us
    | sort by ratio desc
    | limit ${topN}`;
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
  const s = service.replace(/"/g, '\\"');
  const whereClause = metrics.map((m) => `isnotnull(${mf(m)})`).join(' or ');
  return `${metricsBase()}
    | where ${whereClause}
    | extend svc=tostring(['service.name']),
             dep=tostring(['k8s.deployment.name'])
    | where svc == "${s}" or dep == "${s}"
    | extend bucket=bin(_time, ${binSeconds}s)
    | sort by bucket asc`;
}
