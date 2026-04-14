import { useState } from 'react';
import type { JaegerTrace, JaegerSpan, TraceLogEntry } from '../api/types';
import { formatDurationUs, serviceColor } from '../utils/spans';
import TraceLogsView from './TraceLogsView';
import s from './SpanDetail.module.css';

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
  const isError = span.tags.some((t) => t.key === 'error' && t.value === true);

  return (
    <div className={s.panel}>
      <div className={s.title}>
        <span className={s.serviceDot} style={{ background: color }} />
        <span className={s.titleText}>
          {svc} · {span.operationName}
        </span>
        {isError && <span className={s.errorBadge}>ERROR</span>}
      </div>
      <div className={s.subtitle}>
        Duration {formatDurationUs(span.duration)} ·{' '}
        <span className={s.spanIdMono}>span {span.spanID}</span>
      </div>

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
