import { useState } from 'react';
import type { JaegerTrace, JaegerSpan, TraceLogEntry } from '../api/types';
import { formatDurationUs, serviceColor } from '../utils/spans';
import TraceLogsView from './TraceLogsView';
import s from './SpanDetail.module.css';

/**
 * Classify why a 5xx span failed by walking its descendants in the
 * trace. Returns null if the span isn't a 5xx error to begin with.
 *
 * The original "downstream failure" framing in trace UIs is wrong
 * for the leak case — a BFF emitting 504 when its downstream is
 * healthy means the BFF timed out, not that the downstream broke.
 * This distinguisher labels the two situations explicitly so
 * operators don't chase the wrong direction.
 */
type OriginAttribution =
  | {
      kind: 'latency-induced';
      slowestSvc: string;
      slowestOp: string;
      slowestDurUs: number;
    }
  | {
      kind: 'downstream-failure';
      failingSvc: string;
      failingOp: string;
      failingStatusMessage: string;
    };

function isError(span: JaegerSpan): boolean {
  return span.tags.some((t) => t.key === 'error' && t.value === true);
}

function tagAsString(span: JaegerSpan, key: string): string | undefined {
  const tag = span.tags.find((t) => t.key === key);
  if (!tag) return undefined;
  return tag.value === null || tag.value === undefined
    ? undefined
    : String(tag.value);
}

function tagAsInt(span: JaegerSpan, key: string): number | undefined {
  const v = tagAsString(span, key);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function attributeOrigin(
  trace: JaegerTrace,
  span: JaegerSpan,
): OriginAttribution | null {
  const httpStatus = tagAsInt(span, 'http.response.status_code') ??
    tagAsInt(span, 'http.status_code');
  if (!isError(span) || httpStatus === undefined) return null;
  // Only attribute timeout-shaped 5xx — 502/503/504. A 500 with no
  // downstream context is usually a real server error in this span.
  if (![502, 503, 504].includes(httpStatus)) return null;

  // Collect transitive descendants. JaegerTrace stores references
  // pointing UP the tree (child references parent via CHILD_OF);
  // walking children means scanning the trace for spans whose
  // references include this spanID.
  const childrenByParent = new Map<string, JaegerSpan[]>();
  for (const s of trace.spans) {
    for (const ref of s.references) {
      if (ref.refType !== 'CHILD_OF') continue;
      const list = childrenByParent.get(ref.spanID) ?? [];
      list.push(s);
      childrenByParent.set(ref.spanID, list);
    }
  }
  const descendants: JaegerSpan[] = [];
  const stack = [span.spanID];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const kids = childrenByParent.get(id) ?? [];
    for (const k of kids) {
      descendants.push(k);
      stack.push(k.spanID);
    }
  }
  if (descendants.length === 0) return null;

  // Did any descendant itself error?
  const failing = descendants.find(isError);
  if (failing) {
    return {
      kind: 'downstream-failure',
      failingSvc: trace.processes[failing.processID]?.serviceName ?? 'unknown',
      failingOp: failing.operationName,
      failingStatusMessage:
        tagAsString(failing, 'otel.status_description') ??
        tagAsString(failing, 'status.message') ??
        String(tagAsInt(failing, 'http.response.status_code') ?? '5xx'),
    };
  }

  // No descendant errored — the BFF gave up. Surface the slowest
  // descendant as the suspect.
  const slowest = descendants.reduce((acc, d) =>
    d.duration > acc.duration ? d : acc,
  );
  return {
    kind: 'latency-induced',
    slowestSvc: trace.processes[slowest.processID]?.serviceName ?? 'unknown',
    slowestOp: slowest.operationName,
    slowestDurUs: slowest.duration,
  };
}

interface Props {
  trace: JaegerTrace;
  span: JaegerSpan | null;
  /** Logs whose span_id matches the selected span's ID. */
  spanLogs?: TraceLogEntry[];
  loadingLogs?: boolean;
  /** Trace start time in ms, used as the offset reference for log rows. */
  traceStartMs?: number;
}

function formatTagValue(v: string | number | boolean): string {
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function SpanDetail({
  trace,
  span,
  spanLogs = [],
  loadingLogs,
  traceStartMs,
}: Props) {
  const [logsExpanded, setLogsExpanded] = useState(true);

  if (!span) {
    return (
      <div className={s.panel}>
        <div className={s.panelEmpty}>Click a span to view details.</div>
      </div>
    );
  }
  const proc = trace.processes[span.processID];
  const svc = proc?.serviceName ?? 'unknown';
  const color = serviceColor(svc);
  const errored = isError(span);
  const origin = attributeOrigin(trace, span);

  return (
    <div className={s.panel}>
      <div className={s.title}>
        <span className={s.serviceDot} style={{ background: color }} />
        <span className={s.titleText}>
          {svc} · {span.operationName}
        </span>
        {errored && <span className={s.errorBadge}>ERROR</span>}
      </div>
      <div className={s.subtitle}>
        Duration {formatDurationUs(span.duration)} ·{' '}
        <span className={s.spanIdMono}>span {span.spanID}</span>
      </div>

      {origin && (
        <div
          className={s.section}
          style={{
            background:
              origin.kind === 'latency-induced'
                ? 'var(--cds-color-warning-subtle, rgba(255, 184, 0, 0.12))'
                : 'var(--cds-color-danger-subtle, rgba(229, 72, 77, 0.12))',
            padding: 'var(--cds-space-sm)',
            borderRadius: 'var(--cds-radius-sm)',
            marginBottom: 'var(--cds-space-md)',
          }}
        >
          <div className={s.sectionTitle}>Why this span failed</div>
          {origin.kind === 'latency-induced' ? (
            <div>
              <strong>Latency-induced timeout</strong>. Downstream span{' '}
              <code>
                {origin.slowestSvc}:{origin.slowestOp}
              </code>{' '}
              took <strong>{formatDurationUs(origin.slowestDurUs)}</strong> and
              was canceled — this 5xx is the BFF timing out, not a downstream
              fault. Investigate latency in the downstream service, not its
              error rate.
            </div>
          ) : (
            <div>
              <strong>Downstream failure</strong>. Downstream span{' '}
              <code>
                {origin.failingSvc}:{origin.failingOp}
              </code>{' '}
              returned an error ({origin.failingStatusMessage}). Investigate
              that span next.
            </div>
          )}
        </div>
      )}

      <div className={s.section}>
        <div className={s.sectionTitle}>Tags ({span.tags.length})</div>
        <table className={s.tagTable}>
          <tbody>
            {span.tags.map((t, i) => (
              <tr key={`${t.key}-${i}`}>
                <td>{t.key}</td>
                <td>{formatTagValue(t.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {span.logs.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionTitle}>Events ({span.logs.length})</div>
          <ul className={s.logsList}>
            {span.logs.map((log, i) => {
              const eventName = log.fields.find((f) => f.key === 'event')?.value;
              const elapsed = log.timestamp - span.startTime;
              return (
                <li key={i}>
                  <strong>{String(eventName ?? 'event')}</strong>{' '}
                  <span className={s.spanIdMono}>+{formatDurationUs(elapsed)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Logs during this span — correlated by span_id */}
      <div className={s.section}>
        <div
          className={s.sectionTitle}
          style={{ cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setLogsExpanded((v) => !v)}
        >
          {logsExpanded ? '▼' : '▶'} Logs during this span (
          {loadingLogs ? '…' : spanLogs.length})
        </div>
        {logsExpanded && (
          <div style={{ marginTop: 'var(--cds-space-sm)' }}>
            {loadingLogs ? (
              <div style={{ color: 'var(--cds-color-fg-subtle)', fontSize: 'var(--cds-font-size-sm)' }}>
                Loading…
              </div>
            ) : spanLogs.length === 0 ? (
              <div style={{ color: 'var(--cds-color-fg-subtle)', fontSize: 'var(--cds-font-size-sm)', fontStyle: 'italic' }}>
                No logs correlated to this span.
              </div>
            ) : (
              <TraceLogsView
                logs={spanLogs}
                title="Logs"
                compact
                referenceTimeMs={traceStartMs}
              />
            )}
          </div>
        )}
      </div>

      {span.references.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionTitle}>References</div>
          <table className={s.tagTable}>
            <tbody>
              {span.references.map((r, i) => (
                <tr key={i}>
                  <td>{r.refType}</td>
                  <td>{r.spanID}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {proc && (
        <div className={s.section}>
          <div className={s.sectionTitle}>Process Tags ({proc.tags.length})</div>
          <table className={s.tagTable}>
            <tbody>
              {proc.tags.map((t, i) => (
                <tr key={`${t.key}-${i}`}>
                  <td>{t.key}</td>
                  <td>{formatTagValue(t.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
