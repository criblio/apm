import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import StatusBanner from '../components/StatusBanner';
import AlertTimeline from '../components/AlertTimeline';
import InvestigateButton from '../components/InvestigateButton';
import { runQuery } from '../api/cribl';
import { serviceColor } from '../utils/spans';
import type { CachedAlertRow } from '../api/panelCache';
import s from './AlertsPage.module.css';

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseAlertRows(rows: Record<string, unknown>[]): CachedAlertRow[] {
  return rows.map((r) => ({
    service: String(r.svc ?? 'unknown'),
    currRequests: toNum(r.curr_requests),
    currErrors: toNum(r.curr_errors),
    currErrorRate: toNum(r.curr_error_rate),
    prevRequests: toNum(r.prev_requests),
    prevErrors: toNum(r.prev_errors),
    prevErrorRate: toNum(r.prev_error_rate),
    alertId: String(r.alert_id ?? ''),
    signalType: String(r.signal_type ?? 'none'),
    isBad: r.is_bad === true || r.is_bad === 'true',
    isPersistent: r.is_persistent === true || r.is_persistent === 'true',
    alertStatus: String(r.alert_status ?? 'ok'),
    consecutiveBad: toNum(r.consecutive_bad),
    consecutiveGood: toNum(r.consecutive_good),
    fireCount: toNum(r.fire_count),
    transitionedTo: String(r.transitioned_to ?? ''),
  }));
}

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  ok: { label: 'OK', className: s.statusOk },
  pending: { label: 'Pending', className: s.statusPending },
  firing: { label: 'Firing', className: s.statusFiring },
  resolving: { label: 'Resolving', className: s.statusResolving },
};

const SIGNAL_LABELS: Record<string, string> = {
  error_rate: 'Error Rate',
  traffic_drop: 'Traffic Drop',
  silent: 'Service Silent',
  latency: 'Latency Anomaly',
  none: '—',
};

interface AlertEvent {
  time: number;
  eventType: string;
  service: string;
  signalType: string;
  errorRate: number;
  prevErrorRate: number;
}

interface AlertIncident {
  service: string;
  signalType: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  errorRate: number;
}

function buildIncidents(events: AlertEvent[]): AlertIncident[] {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const openByKey = new Map<string, { startTime: number; errorRate: number }>();
  const incidents: AlertIncident[] = [];

  for (const ev of sorted) {
    const key = `${ev.service}:${ev.signalType}`;
    if (ev.eventType === 'firing') {
      if (!openByKey.has(key)) {
        openByKey.set(key, { startTime: ev.time, errorRate: ev.errorRate });
      }
    } else if (ev.eventType === 'resolved') {
      const open = openByKey.get(key);
      if (open) {
        incidents.push({
          service: ev.service,
          signalType: ev.signalType,
          startTime: open.startTime,
          endTime: ev.time,
          duration: ev.time - open.startTime,
          errorRate: open.errorRate,
        });
        openByKey.delete(key);
      }
    }
  }

  // Still-open incidents
  for (const [key, open] of openByKey) {
    const [service, signalType] = key.split(':');
    incidents.push({
      service,
      signalType,
      startTime: open.startTime,
      endTime: null,
      duration: null,
      errorRate: open.errorRate,
    });
  }

  return incidents.sort((a, b) => b.startTime - a.startTime);
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
}

const HISTORY_RANGES = [
  { label: 'Last 1 hour', value: '-1h' },
  { label: 'Last 6 hours', value: '-6h' },
  { label: 'Last 24 hours', value: '-24h' },
  { label: 'Last 3 days', value: '-3d' },
  { label: 'Last 7 days', value: '-7d' },
  { label: 'Last 30 days', value: '-30d' },
];

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<CachedAlertRow[]>([]);
  const [history, setHistory] = useState<AlertEvent[]>([]);
  const [historyRange, setHistoryRange] = useState('-24h');
  const [timelineSelection, setTimelineSelection] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [alertRows, historyRows] = await Promise.all([
        runQuery('dataset="$vt_results" | where jobName == "criblapm__home_alerts"', '-1h', 'now', 500),
        runQuery(
          'dataset="otel" | where data_datatype == "criblapm_alert" | project _time, event_type, svc, signal_type, curr_error_rate, prev_error_rate | sort by _time asc | limit 500',
          historyRange, 'now', 500,
        ),
      ]);
      setAlerts(parseAlertRows(alertRows));
      setHistory(historyRows.map((r) => ({
        time: Number(r._time) * 1000,
        eventType: String(r.event_type ?? ''),
        service: String(r.svc ?? ''),
        signalType: String(r.signal_type ?? ''),
        errorRate: Number(r.curr_error_rate ?? 0),
        prevErrorRate: Number(r.prev_error_rate ?? 0),
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [historyRange]);

  useEffect(() => { void fetchAlerts(); }, [fetchAlerts]);

  const nonOk = alerts.filter((a) => a.alertStatus !== 'ok' || a.isBad);

  const incidents = useMemo(() => buildIncidents(history), [history]);

  const filteredIncidents = useMemo(() => {
    if (!timelineSelection) return incidents;
    return incidents.filter((inc) => {
      const end = inc.endTime ?? Date.now();
      return inc.startTime <= timelineSelection[1] && end >= timelineSelection[0];
    });
  }, [incidents, timelineSelection]);

  const timelineEvents = useMemo(() =>
    history.map((h) => ({ time: h.time, eventType: h.eventType, service: h.service })),
  [history]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Alerts</h1>
          <p className={s.subtitle}>
            {nonOk.length > 0 ? `${nonOk.length} active` : 'No active alerts'}
            {' · '}{incidents.length} incidents in the selected range
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className={s.subtitle}>History</span>
          <select
            className={s.refreshBtn}
            value={historyRange}
            onChange={(e) => setHistoryRange(e.target.value)}
          >
            {HISTORY_RANGES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button className={s.refreshBtn} onClick={() => void fetchAlerts()} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      {/* Timeline + Incidents (primary content) */}
      <AlertTimeline
        events={timelineEvents}
        onRangeSelect={(start, end) => setTimelineSelection([start, end])}
        onRangeClear={() => setTimelineSelection(null)}
      />

      {/* Alert incidents — paired firing→resolved with duration */}
      <div className={s.card}>
        <h2 className={s.sectionTitle}>
          {timelineSelection
            ? `Incidents in selection (${filteredIncidents.length})`
            : `Alert Incidents (${incidents.length})`}
        </h2>
        {filteredIncidents.length === 0 ? (
          <div className={s.empty}>No alert incidents in this time range.</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Service</th>
                <th>Signal</th>
                <th>Started</th>
                <th>Ended</th>
                <th>Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredIncidents.map((inc, i) => (
                <tr key={i}>
                  <td>
                    <Link
                      to={`/service/${encodeURIComponent(inc.service)}?range=-1h`}
                      className={s.svcLink}
                      style={{ color: serviceColor(inc.service) }}
                    >
                      {inc.service}
                    </Link>
                  </td>
                  <td>{SIGNAL_LABELS[inc.signalType] ?? inc.signalType}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(inc.startTime).toLocaleString()}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {inc.endTime ? new Date(inc.endTime).toLocaleString() : (
                      <span className={`${s.statusBadge} ${s.statusFiring}`}>Active</span>
                    )}
                  </td>
                  <td>
                    {inc.duration != null ? fmtDuration(inc.duration) : (
                      <span style={{ color: 'var(--cds-color-danger)' }}>
                        {fmtDuration(Date.now() - inc.startTime)} so far
                      </span>
                    )}
                  </td>
                  <td>
                    <InvestigateButton
                      seed={{
                        question: `The ${inc.service} service had a ${inc.signalType} alert. Investigate what happened.`,
                        service: inc.service,
                        knownSignals: [`Signal: ${inc.signalType}`, `Error rate: ${(inc.errorRate * 100).toFixed(1)}%`],
                        earliest: '-1h',
                        latest: 'now',
                      }}
                      title={`Investigate ${inc.service}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Currently active alerts */}
      {nonOk.length > 0 && (
        <div className={s.card}>
          <h2 className={s.sectionTitle}>Currently Active ({nonOk.length})</h2>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Service</th>
                <th>Signal</th>
                <th>Error Rate</th>
                <th>Prev Error Rate</th>
              </tr>
            </thead>
            <tbody>
              {nonOk.map((a) => {
                const ss = STATUS_STYLE[a.alertStatus] ?? STATUS_STYLE.ok;
                return (
                  <tr key={a.alertId}>
                    <td><span className={`${s.statusBadge} ${ss.className}`}>{ss.label}</span></td>
                    <td>
                      <Link to={`/service/${encodeURIComponent(a.service)}?range=-1h`} className={s.svcLink} style={{ color: serviceColor(a.service) }}>
                        {a.service}
                      </Link>
                    </td>
                    <td>{SIGNAL_LABELS[a.signalType] ?? a.signalType}</td>
                    <td>{(a.currErrorRate * 100).toFixed(2)}%</td>
                    <td>{(a.prevErrorRate * 100).toFixed(2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
