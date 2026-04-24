/**
 * KQL query builders for the Jaeger-clone views.
 *
 * Every query targets the current dataset (see api/dataset.ts). The dataset
 * is injected via datasetBase() rather than a baked-in constant so the
 * Settings page can switch it at runtime without a reload.
 *
 * Spans are identified by isnotnull(end_time_unix_nano).
 */
import { getCurrentDataset } from './dataset';
import { streamFilterKqlClause, streamFilterSpanKqlClause } from './streamFilter';

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
export function services(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name'])
    | summarize by svc
    | sort by svc asc`;
}

/** Operations for a given service. */
export function operations(service: string): string {
  const s = service.replace(/"/g, '\\"');
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name'])
    | where svc=="${s}"
    | summarize by name
    | sort by name asc`;
}

export interface FindTracesParams {
  service?: string;
  operation?: string;
  tags?: string; // free-form "key=value key2=value2"
  minDurationUs?: number; // microseconds (trace-level)
  maxDurationUs?: number; // microseconds (trace-level)
  limit?: number;
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
    | extend svc=tostring(resource.attributes['service.name'])
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
export function traceSpans(traceIds: string[]): string {
  const inList = traceIds.map((id) => `"${id}"`).join(', ');
  return `${spansBase()}
    | where trace_id in (${inList})
    | project _time, trace_id, span_id, parent_span_id, name, kind,
              start_time_unix_nano, end_time_unix_nano,
              attributes, events, links,
              status_code=tostring(status.code), status_message=tostring(status.message),
              service_name=tostring(resource.attributes['service.name']),
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
export function serviceSummary(service?: string): string {
  const svcFilter = service
    ? `| where svc=="${service.replace(/"/g, '\\"')}"`
    : '';
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2")
    ${svcFilter}
    ${streamFilterSpanKqlClause()}
    | summarize requests=count(),
                errors=countif(is_error),
                p50_us=percentile(dur_us, 50),
                p95_us=percentile(dur_us, 95),
                p99_us=percentile(dur_us, 99),
                last_seen=max(_time)
      by svc
    | extend error_rate=toreal(errors)/toreal(requests)
    | sort by requests desc`;
}

/**
 * Previous-window service summary — identical to serviceSummary()
 * but scheduled with earliest=-2h, latest=-1h so it captures the
 * window immediately before the current one. Exports to a lookup
 * so the alert evaluator can join against it without a pivot.
 */
export function prevWindowSummary(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2")
    ${streamFilterSpanKqlClause()}
    | summarize prev_req=count(),
                prev_err=countif(is_error),
                prev_p95_us=percentile(dur_us, 95)
      by svc
    | extend prev_err_rate=iff(prev_req > 0, toreal(prev_err)/toreal(prev_req), 0.0)
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

  return `dataset="$vt_results"
    | where jobName == "criblapm__home_service_summary"
    | project svc, curr_requests=toreal(requests), curr_errors=toreal(errors),
              curr_error_rate=toreal(error_rate)
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
             traffic_ratio=iff(prev_requests >= 50, curr_requests/prev_requests, 1.0)
    | extend signal_type=case(
               curr_requests == 0 and prev_requests >= 50, "silent",
               curr_err_pct >= 1, "error_rate",
               traffic_ratio <= 0.5 and prev_requests >= 50, "traffic_drop",
               "none"),
             is_bad=(
               (curr_requests == 0 and prev_requests >= 50)
               or (curr_err_pct >= 1)
               or (traffic_ratio <= 0.5 and prev_requests >= 50))
    | extend alert_id=strcat("auto:", signal_type, ":", svc)
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
        | where isnotnull(prev_p95_us) and prev_p95_us > 0
                and curr_p95_us >= prev_p95_us * 5
                and curr_p95_us >= 1000000
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
export function serviceTimeSeries(binSeconds: number, service?: string): string {
  const svcFilter = service ? `| where svc=="${service.replace(/"/g, '\\"')}"` : '';
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2")
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
 * Top operations for a service, sorted by volume. Each row includes counts,
 * error rate, and percentile latencies — the core table on Service detail.
 */
export function serviceOperations(service: string): string {
  const s = service.replace(/"/g, '\\"');
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2")
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
export function serviceInstances(service: string): string {
  const s = service.replace(/"/g, '\\"');
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            instance_id=tostring(resource.attributes['service.instance.id']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2")
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
export function slowestTraces(service?: string): string {
  const svcFilter = service ? `| where svc=="${service.replace(/"/g, '\\"')}"` : '';
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
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
 * Raw error span rows enriched with service + operation + status.message
 * for client-side error class grouping. Returns up to `limit` of the most
 * recent error spans.
 */
export function rawRecentErrorSpans(limit: number = 300): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
             is_error=(tostring(status.code)=="2"),
             msg=tostring(status.message)
    | where is_error
    | sort by _time desc
    | project _time, svc, name, trace_id, msg
    | limit ${limit}`;
}

/**
 * Traces that had at least one error span — "recent errors" panel on
 * Home and Service detail. Optionally scoped to a service.
 */
export function recentErrorTraces(service?: string): string {
  const svcFilter = service ? `| where svc=="${service.replace(/"/g, '\\"')}"` : '';
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            is_error=(tostring(status.code)=="2")
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
export function messagingDependencies(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2"),
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
export function dependencies(): string {
  return `${spansBase()}
    | extend svc=tostring(resource.attributes['service.name']),
            parent=tostring(parent_span_id),
            dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
            is_error=(tostring(status.code)=="2")
    | where parent != "" and isnotempty(parent)
    ${streamFilterSpanKqlClause()}
    | project trace_id, parent, svc, dur_us, is_error
    | join kind=inner (
        ${spansBase()}
        | extend psvc=tostring(resource.attributes['service.name']),
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
  return `${metricsBase()}
    | extend metric_name=extract("\\"([a-zA-Z][a-zA-Z0-9._]*)\\"\\\\s*:\\\\s*-?[0-9]", 1, _raw)
    | where isnotempty(metric_name)
        and metric_name != "_metric_type"
        and metric_name != "_datatype_detection"
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
