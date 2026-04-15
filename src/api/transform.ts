/**
 * Transform raw otel span rows (from Cribl Search) into Jaeger-compatible
 * trace objects.
 */
import type {
  JaegerTrace,
  JaegerSpan,
  JaegerProcess,
  JaegerTag,
  JaegerLogEntry,
  JaegerReference,
  TraceSummary,
  DependencyEdge,
} from './types';

/** Convert an attributes object { key: value, ... } into JaegerTag[]. */
function toTags(attrs: Record<string, unknown> | null | undefined): JaegerTag[] {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return [];
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    type: typeof value === 'number' ? (Number.isInteger(value) ? 'int64' : 'float64') : 'string',
    value: value as string | number | boolean,
  }));
}

/** Coerce a value to an array — Cribl Search sometimes returns null/{} for empty lists. */
function toArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  return [];
}

/** Build a stable processID from service name + instance id. */
function processKey(serviceName: string, instanceId?: string): string {
  return instanceId ? `${serviceName}::${instanceId}` : serviceName;
}

interface OtelSpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind?: number;
  start_time_unix_nano: number;
  end_time_unix_nano: number;
  attributes?: Record<string, unknown>;
  events?: Array<{
    time_unix_nano: number;
    name: string;
    attributes?: Record<string, unknown>;
  }>;
  status_code?: string;
  status_message?: string;
  service_name: string;
  resource_attributes?: Record<string, unknown>;
}

/**
 * Group otel span rows by trace_id and produce Jaeger-shaped traces.
 */
export function toJaegerTraces(rows: Record<string, unknown>[]): JaegerTrace[] {
  const byTrace = new Map<string, OtelSpanRow[]>();
  for (const row of rows) {
    const r = row as unknown as OtelSpanRow;
    const tid = r.trace_id;
    if (!tid) continue;
    let arr = byTrace.get(tid);
    if (!arr) {
      arr = [];
      byTrace.set(tid, arr);
    }
    arr.push(r);
  }

  const traces: JaegerTrace[] = [];
  for (const [traceID, spans] of byTrace) {
    const processes: Record<string, JaegerProcess> = {};
    const pidMap = new Map<string, string>(); // processKey → pN
    let pidCounter = 1;

    const jaegerSpans: JaegerSpan[] = spans.map((s) => {
      const svcName = s.service_name || 'unknown';
      const instanceId = s.resource_attributes?.['service.instance.id'] as string | undefined;
      const pk = processKey(svcName, instanceId);

      let pid = pidMap.get(pk);
      if (!pid) {
        pid = `p${pidCounter++}`;
        pidMap.set(pk, pid);
        processes[pid] = {
          serviceName: svcName,
          tags: toTags(s.resource_attributes),
        };
      }

      const startUs = Number(s.start_time_unix_nano) / 1000;
      const endUs = Number(s.end_time_unix_nano) / 1000;

      const refs: JaegerReference[] = [];
      if (s.parent_span_id && s.parent_span_id !== '') {
        refs.push({ refType: 'CHILD_OF', traceID, spanID: s.parent_span_id });
      }

      const tags: JaegerTag[] = toTags(s.attributes);
      if (s.kind != null) {
        tags.push({ key: 'span.kind', type: 'string', value: kindName(s.kind) });
      }
      if (s.status_code === '2') {
        tags.push({ key: 'error', type: 'bool', value: true });
      }

      const logs: JaegerLogEntry[] = toArray<{
        time_unix_nano: number;
        name: string;
        attributes?: Record<string, unknown>;
      }>(s.events).map((e) => ({
        timestamp: Number(e.time_unix_nano) / 1000,
        fields: [
          { key: 'event', type: 'string', value: e.name },
          ...toTags(e.attributes),
        ],
      }));

      return {
        traceID,
        spanID: s.span_id,
        operationName: s.name,
        references: refs,
        startTime: startUs,
        duration: endUs - startUs,
        tags,
        logs,
        processID: pid,
        warnings: null,
      };
    });

    traces.push({ traceID, spans: jaegerSpans, processes, warnings: null });
  }

  return traces;
}

function kindName(kind: number): string {
  const names: Record<number, string> = {
    0: 'unspecified', 1: 'internal', 2: 'server', 3: 'client', 4: 'producer', 5: 'consumer',
  };
  return names[kind] ?? 'unknown';
}

/** Summarize a JaegerTrace into a table row for the search results view. */
export function summarizeTrace(trace: JaegerTrace): TraceSummary {
  const root = trace.spans.find((s) => s.references.length === 0) ?? trace.spans[0];
  const services = new Set<string>();
  let errorCount = 0;
  for (const s of trace.spans) {
    const proc = trace.processes[s.processID];
    if (proc) services.add(proc.serviceName);
    if (s.tags.some((t) => t.key === 'error' && t.value === true)) errorCount++;
  }
  const rootProc = root ? trace.processes[root.processID] : undefined;
  return {
    traceID: trace.traceID,
    rootService: rootProc?.serviceName ?? 'unknown',
    rootOperation: root?.operationName ?? 'unknown',
    startTime: root?.startTime ?? 0,
    duration: root?.duration ?? 0,
    spanCount: trace.spans.length,
    errorCount,
    services: [...services],
  };
}

/** Parse dependency edge rows from the KQL join result. */
export function toDependencyEdges(rows: Record<string, unknown>[]): DependencyEdge[] {
  return rows.map((r) => ({
    parent: String(r.parent ?? r.parent_svc ?? ''),
    child: String(r.child ?? r.child_svc ?? ''),
    callCount: Number(r.callCount ?? 0),
    errorCount: Number(r.errorCount ?? 0),
    p95DurUs: Number(r.p95DurUs ?? 0),
    kind: 'rpc',
  }));
}

/**
 * OTel `messaging.operation` values that identify a producer or a
 * consumer. Based on the OpenTelemetry semantic conventions for
 * messaging spans. We collapse the variants because the downstream
 * logic only cares about "emits into queue" vs "reads from queue".
 */
const PRODUCER_OPS = new Set(['publish', 'send', 'create']);
const CONSUMER_OPS = new Set(['receive', 'process', 'deliver', 'settle']);

/**
 * Reconstruct messaging producer→consumer edges from the per-
 * (service, topic, operation) rollup returned by
 * `messagingDependencies()`.
 *
 * Approach: bucket rows by topic, split each bucket into producers
 * and consumers by `messaging.operation`, then take the cross product
 * to synthesize one edge per (producer_svc → consumer_svc) pair on
 * that topic. A service that both produces and consumes from the same
 * topic would emit a self-loop, which we drop.
 *
 * Metrics attribution: the edge carries the consumer-side stats
 * (callCount = consumer span count, errors, p95). When multiple
 * producers fan into the same topic for the same consumer, we copy
 * the consumer stats to each edge — this is honest at the "per
 * consumer" level but slightly over-counts on the producer side.
 * That's an acceptable simplification for a dependency overview.
 */
export function toMessagingEdges(
  rows: Record<string, unknown>[],
): DependencyEdge[] {
  interface Leg {
    spans: number;
    errors: number;
    p95_us: number;
  }
  // For each topic, merge all rows into (svc -> Leg) maps. A single
  // consumer service can appear multiple times on the same topic
  // because OTel emits one span for `receive` and another for
  // `process` — both are valid consumer ops and we want them rolled
  // up into ONE edge per (producer, consumer, topic), not two.
  const byTopic = new Map<
    string,
    { producers: Map<string, Leg>; consumers: Map<string, Leg> }
  >();

  function mergeInto(map: Map<string, Leg>, svc: string, leg: Leg) {
    const existing = map.get(svc);
    if (existing) {
      existing.spans += leg.spans;
      existing.errors += leg.errors;
      // Pessimistic p95 merge: take the larger of the two. The honest
      // thing would be to re-percentile from raw samples, but we don't
      // carry those through.
      if (leg.p95_us > existing.p95_us) existing.p95_us = leg.p95_us;
    } else {
      map.set(svc, { ...leg });
    }
  }

  for (const r of rows) {
    const svc = String(r.svc ?? '').trim();
    const dest = String(r.msg_dest ?? '').trim();
    const op = String(r.msg_op ?? '').toLowerCase().trim();
    if (!svc || !dest || !op) continue;
    const leg: Leg = {
      spans: Number(r.spans ?? 0),
      errors: Number(r.errors ?? 0),
      p95_us: Number(r.p95_us ?? 0),
    };
    let bucket = byTopic.get(dest);
    if (!bucket) {
      bucket = { producers: new Map(), consumers: new Map() };
      byTopic.set(dest, bucket);
    }
    if (PRODUCER_OPS.has(op)) mergeInto(bucket.producers, svc, leg);
    else if (CONSUMER_OPS.has(op)) mergeInto(bucket.consumers, svc, leg);
    // Unknown ops are dropped — they'd produce misleading edges.
  }

  const out: DependencyEdge[] = [];
  for (const [topic, { producers, consumers }] of byTopic) {
    for (const [producerSvc] of producers) {
      for (const [consumerSvc, cleg] of consumers) {
        if (producerSvc === consumerSvc) continue; // skip self-loops
        out.push({
          parent: producerSvc,
          child: consumerSvc,
          callCount: cleg.spans,
          errorCount: cleg.errors,
          p95DurUs: cleg.p95_us,
          kind: 'messaging',
          topic,
        });
      }
    }
  }
  return out;
}
