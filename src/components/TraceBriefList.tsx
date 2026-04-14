import { Link } from 'react-router-dom';
import type { TraceBrief } from '../api/types';
import { formatDurationUs } from '../utils/spans';
import s from './TraceBriefList.module.css';

interface Props {
  title: string;
  subtitle?: string;
  traces: TraceBrief[];
  loading?: boolean;
  mode: 'duration' | 'errors';
  emptyMessage?: string;
}

function formatRelative(startMicros: number): string {
  const nowMs = Date.now();
  const ms = startMicros / 1000;
  const deltaSec = Math.max(0, (nowMs - ms) / 1000);
  if (deltaSec < 60) return `${Math.floor(deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

export default function TraceBriefList({
  title,
  subtitle,
  traces,
  loading,
  mode,
  emptyMessage,
}: Props) {
  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <span className={s.title}>
          {title} {!loading && <span className={s.subtitle}>({traces.length})</span>}
        </span>
        {subtitle && <span className={s.subtitle}>{subtitle}</span>}
      </div>
      {loading ? (
        <div className={s.skeleton}>
          {/* Deterministic widths — React's purity rule forbids Math.random in render. */}
          {[80, 70, 85, 62, 75].map((w, i) => (
            <div
              key={i}
              className={s.skeletonBar}
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      ) : traces.length === 0 ? (
        <div className={s.empty}>{emptyMessage ?? 'No traces in this time range.'}</div>
      ) : (
        <ul className={s.list}>
          {traces.map((t) => (
            <li key={t.traceID}>
              <Link to={`/trace/${t.traceID}`} className={s.row}>
                <div className={s.idLine}>
                  <span className={s.id}>{t.traceID}</span>
                </div>
                <div>
                  {mode === 'duration' && (
                    <span className={s.durChip}>{formatDurationUs(t.durationUs)}</span>
                  )}
                  {mode === 'errors' && t.errorCount != null && (
                    <span className={s.errorChip}>
                      {t.errorCount} error{t.errorCount > 1 ? 's' : ''}
                    </span>
                  )}
                  <span className={s.meta} style={{ marginLeft: 8 }}>
                    {formatRelative(t.startTime)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
