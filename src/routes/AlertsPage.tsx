import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import StatusBanner from '../components/StatusBanner';
import AlertTimeline from '../components/AlertTimeline';
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
  fireCount: number;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<CachedAlertRow[]>([]);
  const [history, setHistory] = useState<AlertEvent[]>([]);
  const [timeRange, setTimeRange] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [alertRows, historyRows] = await Promise.all([
        runQuery('dataset="$vt_results" | where jobName == "criblapm__home_alerts"', '-1h', 'now', 500),
        runQuery('dataset="otel" | where data_datatype == "criblapm_alert" | project _time, event_type, svc, signal_type, curr_error_rate, prev_error_rate, fire_count | sort by _time desc | limit 50', '-24h', 'now', 50),
      ]);
      setAlerts(parseAlertRows(alertRows));
      setHistory(historyRows.map((r) => ({
        time: Number(r._time) * 1000,
        eventType: String(r.event_type ?? ''),
        service: String(r.svc ?? ''),
        signalType: String(r.signal_type ?? ''),
        errorRate: Number(r.curr_error_rate ?? 0),
        prevErrorRate: Number(r.prev_error_rate ?? 0),
        fireCount: Number(r.fire_count ?? 0),
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAlerts(); }, [fetchAlerts]);

  const nonOk = alerts.filter((a) => a.alertStatus !== 'ok' || a.isBad);

  const filteredHistory = useMemo(() => {
    if (!timeRange) return history;
    return history.filter((h) => h.time >= timeRange[0] && h.time <= timeRange[1]);
  }, [history, timeRange]);

  const timelineEvents = useMemo(() =>
    history.map((h) => ({ time: h.time, eventType: h.eventType, service: h.service })),
  [history]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Alerts</h1>
          <p className={s.subtitle}>
            Auto-detected issues with debounce state tracking.
            Alerts fire after 2 consecutive bad evaluations and resolve after 3 consecutive good.
          </p>
        </div>
        <button className={s.refreshBtn} onClick={() => void fetchAlerts()} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <AlertTimeline
        events={timelineEvents}
        onRangeSelect={(start, end) => setTimeRange([start, end])}
        onRangeClear={() => setTimeRange(null)}
      />

      {loading && alerts.length === 0 ? (
        <div className={s.card}>
          <div className={s.empty}>Loading alert states...</div>
        </div>
      ) : alerts.length === 0 ? (
        <div className={s.card}>
          <div className={s.empty}>
            No alert data yet. The alert evaluator runs every few minutes —
            check back shortly, or verify the scheduled searches are provisioned in Settings.
          </div>
        </div>
      ) : (
        <>
          {nonOk.length > 0 && (
            <div className={s.card}>
              <h2 className={s.sectionTitle}>Active ({nonOk.length})</h2>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Service</th>
                    <th>Signal</th>
                    <th>Error Rate</th>
                    <th>Prev Error Rate</th>
                    <th>Requests</th>
                    <th>Consecutive Bad</th>
                    <th>Fire Count</th>
                  </tr>
                </thead>
                <tbody>
                  {nonOk.map((a) => {
                    const ss = STATUS_STYLE[a.alertStatus] ?? STATUS_STYLE.ok;
                    return (
                      <tr key={a.alertId}>
                        <td>
                          <span className={`${s.statusBadge} ${ss.className}`}>
                            {ss.label}
                          </span>
                        </td>
                        <td>
                          <Link
                            to={`/service/${encodeURIComponent(a.service)}?range=-1h`}
                            className={s.svcLink}
                            style={{ color: serviceColor(a.service) }}
                          >
                            {a.service}
                          </Link>
                        </td>
                        <td>{SIGNAL_LABELS[a.signalType] ?? a.signalType}</td>
                        <td>{(a.currErrorRate * 100).toFixed(2)}%</td>
                        <td>{(a.prevErrorRate * 100).toFixed(2)}%</td>
                        <td>{a.currRequests.toLocaleString()}</td>
                        <td>{a.consecutiveBad}</td>
                        <td>{a.fireCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className={s.card}>
            <h2 className={s.sectionTitle}>
              All Services ({alerts.length})
            </h2>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Service</th>
                  <th>Signal</th>
                  <th>Error Rate</th>
                  <th>Requests</th>
                </tr>
              </thead>
              <tbody>
                {alerts
                  .sort((a, b) => {
                    const order: Record<string, number> = { firing: 0, pending: 1, resolving: 2, ok: 3 };
                    return (order[a.alertStatus] ?? 4) - (order[b.alertStatus] ?? 4);
                  })
                  .map((a) => {
                    const ss = STATUS_STYLE[a.alertStatus] ?? STATUS_STYLE.ok;
                    return (
                      <tr key={a.alertId || a.service}>
                        <td>
                          <span className={`${s.statusBadge} ${ss.className}`}>
                            {ss.label}
                          </span>
                        </td>
                        <td>
                          <Link
                            to={`/service/${encodeURIComponent(a.service)}?range=-1h`}
                            className={s.svcLink}
                            style={{ color: serviceColor(a.service) }}
                          >
                            {a.service}
                          </Link>
                        </td>
                        <td>{SIGNAL_LABELS[a.signalType] ?? a.signalType}</td>
                        <td>{(a.currErrorRate * 100).toFixed(2)}%</td>
                        <td>{a.currRequests.toLocaleString()}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {filteredHistory.length > 0 && (
            <div className={s.card}>
              <h2 className={s.sectionTitle}>
                {timeRange ? `Alert Events (${filteredHistory.length} in selection)` : 'Recent Alert Events'}
              </h2>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Service</th>
                    <th>Signal</th>
                    <th>Error Rate</th>
                    <th>Prev Error Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map((h, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(h.time).toLocaleString()}</td>
                      <td>
                        <span className={`${s.statusBadge} ${h.eventType === 'firing' ? s.statusFiring : s.statusOk}`}>
                          {h.eventType}
                        </span>
                      </td>
                      <td>
                        <Link
                          to={`/service/${encodeURIComponent(h.service)}?range=-1h`}
                          className={s.svcLink}
                          style={{ color: serviceColor(h.service) }}
                        >
                          {h.service}
                        </Link>
                      </td>
                      <td>{SIGNAL_LABELS[h.signalType] ?? h.signalType}</td>
                      <td>{(h.errorRate * 100).toFixed(2)}%</td>
                      <td>{(h.prevErrorRate * 100).toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
