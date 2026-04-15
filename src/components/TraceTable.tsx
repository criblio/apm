import { useNavigate } from 'react-router-dom';
import type { TraceSummary } from '../api/types';
import s from './TraceTable.module.css';

interface Props {
  traces: TraceSummary[];
}

function formatDuration(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function formatTime(us: number): string {
  const ms = us / 1000;
  return new Date(ms).toLocaleString();
}

export default function TraceTable({ traces }: Props) {
  const navigate = useNavigate();

  if (traces.length === 0) {
    return (
      <div className={s.wrapper}>
        <div className={s.empty}>No traces match the current filters.</div>
      </div>
    );
  }

  return (
    <div className={s.wrapper}>
      <div className={s.header}>
        <span className={s.headerTitle}>
          Traces <span className={s.headerCount}>({traces.length})</span>
        </span>
      </div>
      <table className={s.table}>
        <thead>
          <tr>
            <th>Trace ID</th>
            <th>Root</th>
            <th>Services</th>
            <th>Spans</th>
            <th>Duration</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.traceID} onClick={() => navigate(`/trace/${t.traceID}`)}>
              <td>
                <span className={s.traceId}>{t.traceID.slice(0, 16)}…</span>
              </td>
              <td>
                <span className={s.svcChip}>{t.rootService}</span>{' '}
                <span className={s.opName}>{t.rootOperation}</span>
                {t.errorCount > 0 && (
                  <span className={s.errorChip}>
                    {t.errorCount} error{t.errorCount > 1 ? 's' : ''}
                  </span>
                )}
              </td>
              <td className={s.servicesCol}>{t.services.join(', ')}</td>
              <td className={s.numeric}>{t.spanCount}</td>
              <td className={s.numeric}>{formatDuration(t.duration)}</td>
              <td className={s.numeric}>{formatTime(t.startTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
