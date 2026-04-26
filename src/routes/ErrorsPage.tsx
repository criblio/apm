import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import TimeRangePicker from '../components/TimeRangePicker';
import StatusBanner from '../components/StatusBanner';
import InvestigateButton from '../components/InvestigateButton';
import { listErrorClasses } from '../api/search';
import { serviceColor } from '../utils/spans';
import { useRangeParam } from '../hooks/useRangeParam';
import type { ErrorClass } from '../api/types';
import s from './ErrorsPage.module.css';

const DEFAULT_RANGE = '-1h';

function fmtAgo(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

export default function ErrorsPage() {
  const [range, setRange] = useRangeParam(DEFAULT_RANGE);
  const [errors, setErrors] = useState<ErrorClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const fetchErrors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listErrorClasses(range, 'now', 500, 100);
      setErrors(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void fetchErrors(); }, [fetchErrors]);

  const filtered = filter
    ? errors.filter((e) =>
        e.service.toLowerCase().includes(filter.toLowerCase()) ||
        e.operation.toLowerCase().includes(filter.toLowerCase()) ||
        e.message.toLowerCase().includes(filter.toLowerCase()))
    : errors;

  const totalErrors = errors.reduce((sum, e) => sum + e.count, 0);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Errors</h1>
          <p className={s.subtitle}>
            {loading ? 'Loading...' : `${errors.length} error groups · ${totalErrors} total errors`}
          </p>
        </div>
        <div className={s.controls}>
          <input
            className={s.filterInput}
            type="text"
            placeholder="Filter by service, operation, or message..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <TimeRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      {loading ? (
        <div className={s.card}>
          <div className={s.skeleton}>
            {[85, 70, 90, 65, 80].map((w, i) => (
              <div key={i} className={s.skeletonBar} style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className={s.card}>
          <div className={s.empty}>
            {filter ? 'No errors match your filter.' : 'No errors in this time range.'}
          </div>
        </div>
      ) : (
        <div className={s.card}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Error Group</th>
                <th className={s.num}>Count</th>
                <th>Last Seen</th>
                <th>Sample Trace</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((ec, i) => (
                <tr key={`${ec.service}-${ec.operation}-${ec.message}-${i}`}>
                  <td>
                    <div className={s.errorGroup}>
                      <Link
                        to={`/service/${encodeURIComponent(ec.service)}?range=${range}`}
                        className={s.svcLink}
                        style={{ color: serviceColor(ec.service) }}
                      >
                        {ec.service}
                      </Link>
                      <span className={s.opName}>{ec.operation}</span>
                      <span className={s.errMsg}>{ec.message}</span>
                    </div>
                  </td>
                  <td className={s.num}>
                    <span className={s.countBadge}>{ec.count}</span>
                  </td>
                  <td className={s.lastSeen}>{fmtAgo(ec.lastSeenMs)}</td>
                  <td>
                    {ec.sampleTraceIDs[0] && (
                      <Link to={`/trace/${ec.sampleTraceIDs[0]}`} className={s.traceLink}>
                        {ec.sampleTraceIDs[0].slice(0, 12)}...
                      </Link>
                    )}
                  </td>
                  <td>
                    <InvestigateButton
                      seed={{
                        question: `The ${ec.service} service has errors on ${ec.operation}: "${ec.message}". Investigate the root cause.`,
                        service: ec.service,
                        operation: ec.operation,
                        knownSignals: [`Error: ${ec.message}`, `Count: ${ec.count}`, `Operation: ${ec.operation}`],
                        earliest: range,
                        latest: 'now',
                      }}
                      title={`Investigate ${ec.service} ${ec.operation}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
