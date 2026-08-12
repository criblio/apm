import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Menu, Tag, type TagColor } from '@capra/core';
import { ChevronDown } from '@capra/icons';
import StatusBanner from '../components/StatusBanner';
import AlertTimeline from '../components/AlertTimeline';
import InvestigateButton from '../components/InvestigateButton';
import { buildAlertSeed } from '../api/agentContext';
import { runQuery } from '../api/cribl';
import { newQueryGeneration, captureQueryGeneration } from '../api/queryGeneration';
import * as Q from '../api/queries';
import { serviceColor } from '../utils/spans';
import type { CachedAlertRow } from '../api/panelCache';
import { useServerInvestigations } from '../hooks/useServerInvestigations';
import {
  indexInvestigations,
  badgeForIncident,
  type InvestigationEventRow,
} from '../utils/investigationBadges';
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

const STATUS_STYLE: Record<string, { label: string; color: TagColor }> = {
  ok: { label: 'OK', color: 'success' },
  pending: { label: 'Pending', color: 'warning' },
  firing: { label: 'Firing', color: 'danger' },
  resolving: { label: 'Resolving', color: 'info' },
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
  const [investigations, setInvestigations] = useState<InvestigationEventRow[]>([]);
  const serverInvestigations = useServerInvestigations();

  const hasData = useRef(false);
  const fetchAlerts = useCallback(async (silent = false) => {
    newQueryGeneration(); // cancel prior page/poll's in-flight KQL on nav/refresh
    const isCurrent = captureQueryGeneration();
    if (!silent) { setLoading(true); setError(null); }
    try {
      // PRIMARY: the Active-alerts table. Paint this first.
      const alertRows = await runQuery(
        'dataset="$vt_results" | where jobName == "criblapm__home_alerts"',
        '-1h', 'now', 500,
      );
      if (!isCurrent()) return;
      setAlerts(parseAlertRows(alertRows));
      hasData.current = true;
      if (!silent) setLoading(false);

      // SECONDARY: alert history (timeline + incidents). Fire AFTER the
      // primary table so its search job doesn't contend on first paint.
      runQuery(Q.alertHistory(500, undefined, 'asc'), historyRange, 'now', 500)
        .then((historyRows) => {
          if (!isCurrent()) return;
          setHistory(historyRows.map((r) => ({
            time: Number(r._time) * 1000,
            eventType: String(r.event_type ?? ''),
            service: String(r.svc ?? ''),
            signalType: String(r.signal_type ?? ''),
            errorRate: Number(r.curr_error_rate ?? 0),
            prevErrorRate: Number(r.prev_error_rate ?? 0),
          })));
        })
        .catch(() => { /* history is best-effort; primary already shown */ });

      // TERTIARY (flag-gated): server-side investigation lifecycle
      // events for the "Investigating…"/"Investigated" badges. Purely
      // additive — its failure never affects the alert tables.
      if (serverInvestigations) {
        runQuery(Q.investigationEvents(500), historyRange, 'now', 500)
          .then((rows) => {
            if (!isCurrent()) return;
            setInvestigations(rows.map((r) => ({
              timeMs: Number(r._time) * 1000,
              eventType: String(r.event_type ?? ''),
              alertId: String(r.alert_id ?? ''),
              investigationId: String(r.investigation_id ?? ''),
              svc: String(r.svc ?? ''),
              conclusion: String(r.conclusion ?? ''),
            })));
          })
          .catch(() => { /* badges are best-effort */ });
      } else {
        setInvestigations([]);
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (!silent) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
    }
  }, [historyRange, serverInvestigations]);

  useEffect(() => { void fetchAlerts(); }, [fetchAlerts]);

  const refreshRef = useRef(fetchAlerts);
  refreshRef.current = fetchAlerts;
  useEffect(() => {
    const id = setInterval(() => { void refreshRef.current(true); }, 30_000);
    return () => clearInterval(id);
  }, []);

  const nonOk = alerts.filter((a) => a.alertStatus !== 'ok' || a.isBad);

  const incidents = useMemo(() => buildIncidents(history), [history]);

  const investigationsByAlert = useMemo(
    () => indexInvestigations(investigations),
    [investigations],
  );

  const filteredIncidents = useMemo(() => {
    if (!timelineSelection) return incidents;
    return incidents.filter((inc) => {
      // eslint-disable-next-line react-hooks/purity -- live "now" for open incidents
      const end = inc.endTime ?? Date.now();
      return inc.startTime <= timelineSelection[1] && end >= timelineSelection[0];
    });
  }, [incidents, timelineSelection]);

  const timelineIntervals = useMemo(() =>
    incidents.map((inc) => ({
      service: inc.service,
      startTime: inc.startTime,
      endTime: inc.endTime,
    })),
  [incidents]);

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
          <Menu
            trigger={
              <Button variant="secondary" size="sm" trailingIcon={ChevronDown}>
                {HISTORY_RANGES.find((r) => r.value === historyRange)?.label ?? historyRange}
              </Button>
            }
          >
            {HISTORY_RANGES.map((r) => (
              <Menu.Item key={r.value} label={r.label} onClick={() => setHistoryRange(r.value)} />
            ))}
          </Menu>
          <Button variant="secondary" size="sm" pending={loading} onClick={() => void fetchAlerts()}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      {/* Timeline + Incidents (primary content) */}
      <AlertTimeline
        intervals={timelineIntervals}
        onRangeSelect={(start, end) => setTimelineSelection([start, end])}
        onRangeClear={() => setTimelineSelection(null)}
      />

      {/* Alert incidents — paired firing→resolved with duration */}
      <Card className={s.card}>
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
                      <Tag color="danger">Active</Tag>
                    )}
                  </td>
                  <td>
                    {inc.duration != null ? fmtDuration(inc.duration) : (
                      <span style={{ color: 'var(--cds-color-danger)' }}>
                        {/* eslint-disable-next-line react-hooks/purity -- live "so far" duration */}
                        {fmtDuration(Date.now() - inc.startTime)} so far
                      </span>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const badge = serverInvestigations
                        ? badgeForIncident(inc, investigationsByAlert)
                        : null;
                      if (badge?.state === 'investigated') {
                        return (
                          <Link
                            to={`/investigate?investigation=${encodeURIComponent(badge.investigationId)}`}
                            title={badge.conclusion || 'View the server-side investigation'}
                          >
                            <Tag color="success">Investigated</Tag>
                          </Link>
                        );
                      }
                      if (badge?.state === 'investigating') {
                        return (
                          <Link
                            to={`/investigate?investigation=${encodeURIComponent(badge.investigationId)}`}
                            title="A server-side investigation is running"
                          >
                            <Tag color="info">Investigating…</Tag>
                          </Link>
                        );
                      }
                      if (badge?.state === 'failed') {
                        return (
                          <Link
                            to={`/investigate?investigation=${encodeURIComponent(badge.investigationId)}`}
                            title="The server-side investigation did not complete"
                          >
                            <Tag color="warning">Investigation failed</Tag>
                          </Link>
                        );
                      }
                      return (
                        <InvestigateButton
                          seed={buildAlertSeed({
                            service: inc.service,
                            signalType: inc.signalType,
                            errorRate: inc.errorRate,
                          })}
                          title={`Investigate ${inc.service}`}
                        />
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Currently active alerts */}
      {nonOk.length > 0 && (
        <Card className={s.card}>
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
                    <td><Tag color={ss.color}>{ss.label}</Tag></td>
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
        </Card>
      )}
    </div>
  );
}
