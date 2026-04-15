/**
 * Generic "trace class" list used by Home for both Slowest and Recent Errors.
 *
 * A "class" is a dedupe unit — traces (or errors) that share a common
 * (service, operation[, message]) signature. The item itself exposes the
 * count of underlying traces, stat summaries (max/p95/p50 for latency
 * classes, last-seen for error classes), and a click-through to the
 * worst/most-recent sample trace.
 */
import { Link } from 'react-router-dom';
import { serviceColor } from '../utils/spans';
import s from './TraceClassList.module.css';

type Mode = 'duration' | 'errors';

export interface ClassItem {
  /** Stable row key. */
  key: string;
  service: string;
  operation: string;
  count: number;
  /** Secondary message (for errors) */
  message?: string;
  /** Sample trace to link through to. Required. */
  sampleTraceID: string;
  /** For 'duration' mode: max / p95 / p50 in μs */
  maxDurationUs?: number;
  p95DurationUs?: number;
  p50DurationUs?: number;
  /** For 'errors' mode: last-seen timestamp (ms) */
  lastSeenMs?: number;
}

interface Props {
  title: string;
  subtitle?: string;
  items: ClassItem[];
  loading?: boolean;
  mode: Mode;
  emptyMessage?: string;
  /** Age of the panel-cache snapshot feeding this list, in ms. When
   *  the caller sets this, the list renders a "cache Nm stale" chip
   *  in the header so an empty or out-of-date panel can be
   *  distinguished from a healthy-and-quiet one. Callers are
   *  responsible for only passing a value when the age exceeds the
   *  staleness threshold; this component just formats and renders. */
  staleCacheAgeMs?: number | null;
}

function fmtDurationUs(us: number): string {
  if (!Number.isFinite(us) || us === 0) return '—';
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function fmtRelative(lastSeenMs: number): string {
  if (!lastSeenMs) return '';
  const deltaSec = Math.max(0, (Date.now() - lastSeenMs) / 1000);
  if (deltaSec < 60) return `${Math.floor(deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

function fmtStaleAge(ageMs: number): string {
  const sec = Math.max(0, Math.round(ageMs / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

export default function TraceClassList({
  title,
  subtitle,
  items,
  loading,
  mode,
  emptyMessage,
  staleCacheAgeMs,
}: Props) {
  const staleChipText =
    staleCacheAgeMs != null && staleCacheAgeMs > 0
      ? `cache ${fmtStaleAge(staleCacheAgeMs)} stale`
      : null;
  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <span className={s.title}>
          {title}{' '}
          {!loading && <span className={s.subtitle}>({items.length} classes)</span>}
          {staleChipText && (
            <span
              className={s.staleChip}
              title={
                'The scheduled search feeding this panel has not written a fresh bucket recently. ' +
                'The panel may be missing events from the last few minutes until the next scheduled run lands.'
              }
            >
              {staleChipText}
            </span>
          )}
        </span>
        {subtitle && <span className={s.subtitle}>{subtitle}</span>}
      </div>
      {loading ? (
        <div className={s.skeleton}>
          {[75, 62, 88, 70, 55, 80].map((w, i) => (
            <div key={i} className={s.skeletonBar} style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className={s.empty}>{emptyMessage ?? 'Nothing to show.'}</div>
      ) : (
        <ul className={s.list}>
          {items.map((item) => (
            <li key={item.key}>
              <Link to={`/trace/${item.sampleTraceID}`} className={s.row}>
                <div className={s.mainCol}>
                  <div className={s.topLine}>
                    <span
                      className={s.svcDot}
                      style={{ background: serviceColor(item.service) }}
                    />
                    <span className={s.svcName}>{item.service}</span>
                    <span className={s.opName}>{item.operation}</span>
                  </div>
                  {item.message && <div className={s.msg}>{item.message}</div>}
                  <div className={s.statLine}>
                    {mode === 'duration' && (
                      <>
                        <span>
                          <span className={s.statKey}>max</span>{' '}
                          <span className={s.statValue}>
                            {fmtDurationUs(item.maxDurationUs ?? 0)}
                          </span>
                        </span>
                        <span>
                          <span className={s.statKey}>p95</span>{' '}
                          <span className={s.statValue}>
                            {fmtDurationUs(item.p95DurationUs ?? 0)}
                          </span>
                        </span>
                        <span>
                          <span className={s.statKey}>p50</span>{' '}
                          <span className={s.statValue}>
                            {fmtDurationUs(item.p50DurationUs ?? 0)}
                          </span>
                        </span>
                      </>
                    )}
                    {mode === 'errors' && item.lastSeenMs != null && (
                      <span>
                        <span className={s.statKey}>last</span>{' '}
                        <span className={s.statValue}>{fmtRelative(item.lastSeenMs)}</span>
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={`${s.countChip} ${mode === 'errors' ? s.countChipError : ''}`}
                  title={`${item.count} trace${item.count > 1 ? 's' : ''}`}
                >
                  ×{item.count}
                </span>
                <span className={s.arrow}>→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
