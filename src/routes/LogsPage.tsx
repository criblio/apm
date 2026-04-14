/**
 * Log Explorer tab — standalone log search not tied to a trace ID.
 *
 * Users land here when they want to browse logs by service / severity /
 * text search across the whole dataset, not just "what logs ran inside
 * this trace." This is the primary surface for diagnosing failure
 * scenarios that manifest in logs rather than traces (Kafka consumer
 * lag, k8s probe failures, OOM restarts, GC pauses).
 *
 * Filters:
 *  - service (dropdown, from listLogServices())
 *  - severity (multi-button: all / error+ / warn+ / info+ / debug)
 *  - body contains (free-text)
 *  - lookback (shared TimeRangePicker)
 *  - limit (1..1000)
 *
 * Results render through the shared TraceLogsView with the absolute-
 * timestamp mode so each row shows local wall-clock instead of offset.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import TraceLogsView from '../components/TraceLogsView';
import TimeRangePicker from '../components/TimeRangePicker';
import StatusBanner from '../components/StatusBanner';
import { listLogServices, searchLogs } from '../api/search';
import type { TraceLogEntry } from '../api/types';
import s from './LogsPage.module.css';

const DEFAULT_RANGE = '-1h';
const DEFAULT_LIMIT = 200;

/** Severity filter presets. The UI collapses OTel's 1–24 number scale
 * into friendly named tiers that match what you see elsewhere in the
 * app. "Error+" means "error or fatal"; "warn+" means "warn or worse". */
type SeverityTier = 'any' | 'debug' | 'info' | 'warn' | 'error';

const TIER_MIN_SEVERITY: Record<SeverityTier, number | undefined> = {
  any: undefined,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

export default function LogsPage() {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [service, setService] = useState<string>('');
  const [severity, setSeverity] = useState<SeverityTier>('any');
  const [bodyQuery, setBodyQuery] = useState('');
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [services, setServices] = useState<string[]>([]);
  const [logs, setLogs] = useState<TraceLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A separate "committed" version of the body query — only updates on
  // submit so users can type freely without triggering a query per keystroke.
  const [committedBody, setCommittedBody] = useState('');

  // Service dropdown populates from distinct log-emitting services.
  useEffect(() => {
    let cancelled = false;
    listLogServices(range)
      .then((svcs) => {
        if (!cancelled) setServices(svcs);
      })
      .catch(() => {
        if (!cancelled) setServices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await searchLogs(
        {
          service: service || undefined,
          minSeverity: TIER_MIN_SEVERITY[severity],
          bodyContains: committedBody || undefined,
          limit,
        },
        range,
        'now',
      );
      setLogs(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [service, severity, committedBody, limit, range]);

  // Auto-run on any filter change. The body-text search only triggers
  // via its committed state (user hits Enter / clicks Apply), so
  // keystrokes don't spam the backend.
  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const severityButtons: Array<{ id: SeverityTier; label: string }> = useMemo(
    () => [
      { id: 'any', label: 'Any' },
      { id: 'error', label: 'Error+' },
      { id: 'warn', label: 'Warn+' },
      { id: 'info', label: 'Info+' },
      { id: 'debug', label: 'Debug+' },
    ],
    [],
  );

  return (
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <div className={s.panel}>
          <div className={s.panelHeader}>
            <span className={s.panelTitle}>Filters</span>
            <span className={s.panelHint}>{services.length} services</span>
          </div>

          <label className={s.field}>
            <span className={s.fieldLabel}>Service</span>
            <select
              className={s.select}
              value={service}
              onChange={(e) => setService(e.target.value)}
            >
              <option value="">All services</option>
              {services.map((svc) => (
                <option key={svc} value={svc}>
                  {svc}
                </option>
              ))}
            </select>
          </label>

          <div className={s.field}>
            <span className={s.fieldLabel}>Severity</span>
            <div className={s.sevGroup}>
              {severityButtons.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`${s.sevBtn} ${severity === b.id ? s.sevBtnActive : ''}`}
                  onClick={() => setSeverity(b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          <label className={s.field}>
            <span className={s.fieldLabel}>Body contains</span>
            <input
              type="text"
              className={s.input}
              placeholder="free-text substring"
              value={bodyQuery}
              onChange={(e) => setBodyQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setCommittedBody(bodyQuery.trim());
              }}
            />
          </label>

          <label className={s.field}>
            <span className={s.fieldLabel}>Lookback</span>
            <TimeRangePicker value={range} onChange={setRange} />
          </label>

          <label className={`${s.field} ${s.numericField}`}>
            <span className={s.fieldLabel}>Limit</span>
            <input
              type="number"
              min={1}
              max={1000}
              step={50}
              className={`${s.input} ${s.numericInput}`}
              value={limit}
              onChange={(e) =>
                setLimit(
                  Math.max(
                    1,
                    Math.min(1000, Number(e.target.value) || DEFAULT_LIMIT),
                  ),
                )
              }
            />
          </label>

          <button
            type="button"
            className={s.applyBtn}
            onClick={() => {
              setCommittedBody(bodyQuery.trim());
              void runSearch();
            }}
          >
            Apply
          </button>
        </div>
      </aside>

      <main className={s.results}>
        <div className={s.hero}>
          <div>
            <h1 className={s.heroTitle}>Logs</h1>
            <div className={s.heroSubtitle}>
              Standalone log search across all services in the{' '}
              <code>otel</code> dataset.
            </div>
          </div>
        </div>

        {error && <StatusBanner kind="error">{error}</StatusBanner>}

        <TraceLogsView
          logs={logs}
          loading={loading}
          title="Results"
          subtitle={
            loading
              ? 'Searching…'
              : `${logs.length.toLocaleString()} entr${logs.length === 1 ? 'y' : 'ies'} — newest first`
          }
          absoluteTimestamps
          fillHeight
          emptyMessage="No logs match these filters."
        />
      </main>
    </div>
  );
}
