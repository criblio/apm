/**
 * Shared "long-poll / idle-wait" trace filter.
 *
 * Background: the Home "Slowest trace classes" panel and the Search
 * results list are routinely dominated by traces that are "long" but
 * not "slow". Two common shapes:
 *
 *  1. **Persistent streaming connections** — gRPC server-streaming /
 *     SSE / websockets / HTTP long-poll. The root span holds the
 *     connection open for minutes at a time. Typical example:
 *     `flagd.evaluation.v1.Service/EventStream` at 600s.
 *
 *  2. **Idle-wait loops around kafka consumers** — the service wraps
 *     an entire consume iteration (including the idle poll wait) in
 *     one span. Typical example: `accounting order-consumed` at 98s
 *     with 4 tiny children that together account for ~140ms — the
 *     other 97.86 seconds is the consumer blocking on poll().
 *
 * Both shapes share the same diagnostic property: **the work inside
 * the trace is not attributed to any child span**. A well-
 * instrumented slow trace always delegates its slowness to at least
 * one child (DB call, downstream RPC, internal queue wait) because
 * that's where the time went. A trace whose longest non-root span
 * is a tiny fraction of the root's duration can't actually be
 * diagnosed from the trace data alone — whatever happened, it
 * happened invisibly inside the root.
 *
 * There's one wrinkle: gRPC streaming RPCs emit TWO spans in the
 * same trace — a client-side stream span and a server-side stream
 * span, both spanning the full 600s lifetime of the connection.
 * Ratio-only analysis treats this like a legitimate "single long
 * child did all the work" trace, even though it's the same
 * persistent-connection noise we want to filter. To catch that,
 * we also keep the earlier span-count rule.
 *
 * Combined heuristic: a trace is filtered when
 *   - trace_duration > STREAM_DURATION_US (default 30s), AND
 *   - (
 *       span_count < STREAM_MIN_SPAN_COUNT (default 3)
 *       OR max(non_root_dur) / trace_duration < STREAM_CHILD_RATIO
 *       (default 10%)
 *     )
 *
 * This correctly filters 1-span flagd streams, 2-span flagd
 * client+server streams, and 4-span accounting idle-wait loops.
 * It does NOT filter nested slow traces whose slowness is
 * attributed to a real descendant span, and it does not filter
 * legitimate fast traces regardless of shape.
 *
 * The filter is exposed as a user setting (default on). Persisted in
 * the pack-scoped KV store alongside the dataset preference. The
 * module maintains a pub/sub so pages can re-fetch when the toggle
 * changes, using the same pattern as `dataset.ts`.
 */

/** Minimum trace duration (μs) at which the filter even considers a trace. */
export const STREAM_DURATION_US = 30_000_000;

/**
 * Max ratio of (largest non-root child duration) to (total trace
 * duration) for a trace to be considered "not dominated by any
 * attributable child work". Below this ratio, the trace is idle-wait
 * / streaming and gets hidden.
 */
export const STREAM_CHILD_RATIO = 0.1;

/**
 * Minimum span count for a long trace to be considered potentially
 * legitimate. 1- and 2-span streams (single-process stream, or
 * client+server gRPC stream pair) are always noise if they're long
 * enough to trip the duration threshold.
 */
export const STREAM_MIN_SPAN_COUNT = 3;

let enabled = true;
const listeners = new Set<() => void>();

export function getStreamFilterEnabled(): boolean {
  return enabled;
}

/**
 * Set the filter state and notify subscribers. Called from the
 * SettingsPage after the user toggles it and from StreamFilterProvider
 * on first KV load. No-op if the value hasn't changed.
 */
export function setStreamFilterEnabled(v: boolean): void {
  if (v === enabled) return;
  enabled = v;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors shouldn't block others */
    }
  }
}

export function subscribeStreamFilter(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Regex that matches kafka consumer operation names. When the root
 * operation of a long trace matches this pattern the stream filter
 * exempts it — even though kafka consumer traces look structurally
 * identical to idle-wait traces (large root, tiny children), a
 * genuine consumer-lag anomaly (scenario 2 / kafkaQueueProblems) is
 * valuable diagnostic signal.
 *
 * The pattern is intentionally generic — no service names, just
 * operation-name conventions used by OTel kafka instrumentation:
 *   - `…-consumed` (e.g. `accounting order-consumed`)
 *   - `…Consume…`  (e.g. `ConsumeMessages`, `kafka.consume`)
 */
export const KAFKA_CONSUMER_OP_RE = '(?i)consumed|consume';

/**
 * **Trace-level** KQL fragment for slow-trace listings. Appended to a
 * pipeline that has already summarized by trace_id and computed:
 *   - trace_dur_us (number)
 *   - span_count (number, total spans in the trace)
 *   - max_non_root_dur_us (number, may be null if no non-root spans)
 *   - root_op (string, the root span's operation name)
 *
 * Used by the Home "Slowest trace classes" panel and equivalent
 * Service Detail panels.
 *
 * Returns an empty string when the filter is disabled, so callers can
 * unconditionally splice it into query templates. When enabled it
 * emits an `| extend ... | where not (...)` pair.
 *
 * Kafka consumer exemption: traces whose root_op matches
 * KAFKA_CONSUMER_OP_RE bypass the idle-wait heuristic. Without this,
 * kafkaQueueProblems (scenario 2) traces are invisible because
 * consumer-lag traces have the same structural shape as idle-wait
 * traces — large root span, tiny children — but they represent real
 * degradation, not background noise.
 *
 * IMPORTANT: this is read at query-build time. Pages that want the
 * filter to take effect immediately on toggle should subscribe via
 * useStreamFilterEnabled() and include the value in their useEffect
 * deps so the next fetch rebuilds the query.
 */
export function streamFilterKqlClause(): string {
  if (!enabled) return '';
  return `| extend max_child_us=iff(isnull(max_non_root_dur_us), 0.0, toreal(max_non_root_dur_us))
    | where not (trace_dur_us > ${STREAM_DURATION_US} and (span_count < ${STREAM_MIN_SPAN_COUNT} or (max_child_us / trace_dur_us) < ${STREAM_CHILD_RATIO}) and not (root_op matches regex "${KAFKA_CONSUMER_OP_RE}"))`;
}

/**
 * **Span-level** KQL fragment for aggregation queries that compute
 * percentiles and counts over raw spans (not trace-level rollups).
 * Appended to a pipeline that has already computed a `dur_us` column
 * on each span.
 *
 * Why a different filter shape: percentile queries don't have
 * trace-wide context (span count, max_non_root_dur) because they
 * aggregate across spans, not traces. At the span level the cleanest
 * heuristic is a duration cap: any individual span longer than
 * STREAM_DURATION_US (30s) is almost certainly a streaming connection
 * or an idle-wait loop. Empirically verified against the OTel demo
 * dataset — in a typical hour, every span > 30s is either a
 * flagd.evaluation.v1.Service/EventStream or an accounting
 * order-consumed idle-wait root. Nothing legitimate crosses 30s.
 *
 * The cap is strict: it filters out the ENTIRE span, including its
 * contribution to service percentiles, operation percentiles, and
 * dependency-edge stats. This is what "hide the noise from summaries"
 * means in practice.
 *
 * Affects (via the query builders in queries.ts):
 *   - serviceSummary / listServiceSummaries (Home catalog + ServiceDetail hero)
 *   - serviceTimeSeries (ServiceDetail RED charts)
 *   - serviceOperations (ServiceDetail Top Operations)
 *   - dependencies (arch graph RPC edges)
 *   - messagingDependencies (arch graph messaging edges)
 *
 * Does NOT affect:
 *   - findTraces (Search is an explicit user query — show what was asked for)
 *   - traceLogs / searchLogs (log queries, not span-duration-based)
 *   - traceSpans (single-trace detail — show the full trace)
 */
export function streamFilterSpanKqlClause(): string {
  if (!enabled) return '';
  return `| where dur_us < ${STREAM_DURATION_US}`;
}

