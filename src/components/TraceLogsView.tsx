/**
 * Renders correlated logs for a trace (or a single span).
 *
 * Timeline-ordered rows with:
 *  - offset from the first log in ms/s ("+12ms")
 *  - severity chip (INFO / WARN / ERROR / DEBUG) with severity-tinted chip
 *  - service name + color dot
 *  - log body (truncated, expands on click)
 *
 * Clicking a row expands it to show code.file:line, trace/span ids,
 * and the full attributes map. Filter bar at the top lets the user
 * narrow by severity.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TraceLogEntry } from '../api/types';
import { serviceColor } from '../utils/spans';
import s from './TraceLogsView.module.css';

/** Stringify an attribute value the way a developer would want to read it. */
function formatAttrValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

interface Props {
  logs: TraceLogEntry[];
  loading?: boolean;
  title?: string;
  subtitle?: string;
  emptyMessage?: string;
  /** When provided, the "Offset" column is computed relative to this ms. */
  referenceTimeMs?: number;
  /** When true, no filter bar is shown (used in compact per-span accordion). */
  compact?: boolean;
  /**
   * If true, replaces the relative-offset column with an absolute local
   * time string ("14:23:07"). Used by the standalone Log Explorer where
   * "offset from the first log in the result set" is meaningless.
   */
  absoluteTimestamps?: boolean;
  /**
   * If true, the list fills the available vertical space of its flex
   * parent instead of capping at ~560px. Used by the standalone Log
   * Explorer so the results pane stretches to the bottom of the
   * viewport. The parent must be a flex column with a constrained
   * height for this to have an effect.
   */
  fillHeight?: boolean;
}

/** Map OTel severity numbers to severity bucket. */
function bucket(severityNumber: number, severityText: string): 'error' | 'warn' | 'info' | 'debug' {
  if (severityNumber >= 17) return 'error';
  if (severityNumber >= 13) return 'warn';
  if (severityNumber >= 9) return 'info';
  const txt = (severityText || '').toUpperCase();
  if (txt.includes('ERROR') || txt.includes('FATAL')) return 'error';
  if (txt.includes('WARN')) return 'warn';
  if (txt.includes('DEBUG') || txt.includes('TRACE')) return 'debug';
  return 'info';
}

function fmtOffset(ms: number): string {
  if (ms === 0) return '0';
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms);
  if (abs < 1) return `${sign}${(abs * 1000).toFixed(0)}μs`;
  if (abs < 1000) return `${sign}${abs.toFixed(1)}ms`;
  return `${sign}${(abs / 1000).toFixed(2)}s`;
}

type Filter = 'all' | 'error' | 'warn' | 'info' | 'debug';

export default function TraceLogsView({
  logs,
  loading,
  title = 'Logs',
  subtitle,
  emptyMessage = 'No logs correlated to this trace.',
  referenceTimeMs,
  compact,
  absoluteTimestamps,
  fillHeight,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const referenceMs = referenceTimeMs ?? (logs[0]?.time ?? 0);

  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0, debug: 0 };
    for (const l of logs) {
      c[bucket(l.severityNumber, l.severityText)]++;
    }
    return c;
  }, [logs]);

  const filtered = useMemo(() => {
    if (filter === 'all') return logs;
    return logs.filter((l) => bucket(l.severityNumber, l.severityText) === filter);
  }, [logs, filter]);

  const key = (l: TraceLogEntry, i: number) => `${l.time}-${l.spanID}-${i}`;

  function toggle(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  return (
    <div className={`${s.wrap} ${fillHeight ? s.fill : ''}`}>
      <div className={s.header}>
        <span className={s.title}>
          {title}{' '}
          {!loading && (
            <span className={s.subtitle}>
              ({filtered.length}
              {filter !== 'all' ? ` of ${logs.length}` : ''})
            </span>
          )}
        </span>
        {subtitle && <span className={s.subtitle}>{subtitle}</span>}
      </div>

      {!compact && logs.length > 0 && (
        <div className={s.filterBar}>
          {(['all', 'error', 'warn', 'info', 'debug'] as Filter[]).map((f) => {
            const n = f === 'all' ? logs.length : counts[f];
            const disabled = n === 0 && f !== 'all';
            return (
              <button
                key={f}
                type="button"
                className={`${s.filterBtn} ${filter === f ? s.filterBtnActive : ''}`}
                onClick={() => setFilter(f)}
                disabled={disabled}
                style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              >
                {f !== 'all' && (
                  <span
                    className={s.filterSwatch}
                    style={{
                      background:
                        f === 'error'
                          ? 'var(--cds-color-danger)'
                          : f === 'warn'
                            ? 'var(--cds-color-warning)'
                            : f === 'info'
                              ? 'var(--cds-color-accent)'
                              : 'var(--cds-color-fg-subtle)',
                    }}
                  />
                )}
                {f} ({n})
              </button>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className={s.loading}>Loading logs…</div>
      ) : filtered.length === 0 ? (
        <div className={s.empty}>{emptyMessage}</div>
      ) : (
        <ul className={s.list}>
          {filtered.map((l, i) => {
            const k = key(l, i);
            const isExpanded = expanded.has(k);
            const sev = bucket(l.severityNumber, l.severityText);
            const sevClass =
              sev === 'error'
                ? s.sevError
                : sev === 'warn'
                  ? s.sevWarn
                  : sev === 'info'
                    ? s.sevInfo
                    : s.sevDebug;
            const offsetMs = l.time - referenceMs;
            const color = serviceColor(l.service);
            return (
              <li
                key={k}
                className={`${s.row} ${isExpanded ? s.rowExpanded : ''}`}
                onClick={() => toggle(k)}
              >
                <div className={s.offset}>
                  {absoluteTimestamps
                    ? new Date(l.time).toLocaleTimeString(undefined, { hour12: false })
                    : fmtOffset(offsetMs)}
                </div>
                <div>
                  <span className={`${s.severity} ${sevClass}`}>
                    {sev === 'warn' ? 'WARN' : sev.toUpperCase()}
                  </span>
                </div>
                <div className={s.service}>
                  <span className={s.serviceDot} style={{ background: color }} />
                  {l.service}
                </div>
                <div className={s.body}>{l.body || '(no body)'}</div>
                {isExpanded && (
                  <div className={s.details}>
                    {l.codeFunction && (
                      <div className={s.detailsRow}>
                        <span className={s.detailsKey}>code.function</span>
                        <span className={s.detailsValue}>
                          {l.codeFunction}
                          {l.codeFile ? ` — ${l.codeFile}${l.codeLine ? `:${l.codeLine}` : ''}` : ''}
                        </span>
                      </div>
                    )}
                    <div className={s.detailsRow}>
                      <span className={s.detailsKey}>trace_id</span>
                      <span className={s.detailsValue}>
                        {l.traceID ? (
                          <Link
                            to={`/trace/${l.traceID}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: 'var(--cds-color-accent)', textDecoration: 'none' }}
                          >
                            {l.traceID}
                          </Link>
                        ) : (
                          '(none)'
                        )}
                      </span>
                    </div>
                    <div className={s.detailsRow}>
                      <span className={s.detailsKey}>span_id</span>
                      <span className={s.detailsValue}>{l.spanID}</span>
                    </div>
                    <div className={s.detailsRow}>
                      <span className={s.detailsKey}>severity</span>
                      <span className={s.detailsValue}>
                        {l.severityText} ({l.severityNumber})
                      </span>
                    </div>
                    {Object.entries(l.attributes).map(([ak, av]) => (
                      <div key={ak} className={s.detailsRow}>
                        <span className={s.detailsKey}>{ak}</span>
                        <span className={s.detailsValue}>{formatAttrValue(av)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
