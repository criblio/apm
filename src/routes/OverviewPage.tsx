import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import TimeRangePicker from '../components/TimeRangePicker';
import StatusBanner from '../components/StatusBanner';
import DetectedIssuesPanel from '../components/DetectedIssuesPanel';
import {
  listServiceSummaries,
  listOperationAnomalies,
  getDependencies,
} from '../api/search';
import { listCachedHomePanels } from '../api/panelCache';
import { runQuery } from '../api/cribl';
import { serviceColor } from '../utils/spans';
import { serviceHealth, healthRowBg } from '../utils/health';
import { buildDetectedIssues, buildDetectedIssuesFromCache } from '../utils/detectedIssues';
import InvestigateButton from '../components/InvestigateButton';
import { previousWindow } from '../utils/timeRange';
import { useRangeParam } from '../hooks/useRangeParam';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
import type {
  ServiceSummary,
  OperationAnomaly,
  DependencyEdge,
} from '../api/types';
import s from './OverviewPage.module.css';

const DEFAULT_RANGE = '-1h';

function fmtRate(rpm: number): string {
  if (rpm >= 1000) return `${(rpm / 1000).toFixed(1)}k/min`;
  if (rpm >= 10) return `${rpm.toFixed(0)}/min`;
  return `${rpm.toFixed(1)}/min`;
}

function relativeTimeMs(rel: string): number {
  const m = rel.match(/^-(\d+)([smhd])$/);
  if (!m) return 3600_000;
  const n = Number(m[1]);
  const unit = m[2] as 's' | 'm' | 'h' | 'd';
  return n * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit];
}

interface AlertEvent {
  time: number;
  eventType: string;
  service: string;
  signalType: string;
}

export default function OverviewPage() {
  const [range, setRange] = useRangeParam(DEFAULT_RANGE);
  const [summaries, setSummaries] = useState<ServiceSummary[]>([]);
  const [prevSummaries, setPrevSummaries] = useState<ServiceSummary[]>([]);
  const [edges, setEdges] = useState<DependencyEdge[]>([]);
  const [anomalies, setAnomalies] = useState<OperationAnomaly[]>([]);
  const [recentAlerts, setRecentAlerts] = useState<AlertEvent[]>([]);
  const [cachedIssues, setCachedIssues] = useState<import('../api/types').DetectedIssue[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamFilterEnabled = useStreamFilterEnabled();
  const hasDataRef = useRef(false);

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    if (!hasDataRef.current) setLoading(true);

    const prev = previousWindow(range);
    listServiceSummaries(prev.earliest, prev.latest)
      .then((r) => setPrevSummaries(r))
      .catch(() => setPrevSummaries([]));

    getDependencies(range, 'now')
      .then((r) => setEdges(r))
      .catch(() => setEdges([]));

    listOperationAnomalies(range, 'now')
      .then((r) => setAnomalies(r))
      .catch(() => setAnomalies([]));

    // Cache-fast path
    if (range === '-1h' && streamFilterEnabled) {
      try {
        const cached = await listCachedHomePanels();
        if (cached.serviceSummaries) {
          setSummaries(cached.serviceSummaries);
          setLoading(false);
          if (cached.alertRows && cached.alertRows.length > 0) {
            setCachedIssues(buildDetectedIssuesFromCache(cached.alertRows, 60));
          }
          hasDataRef.current = true;
          setRefreshing(false);

          // Fetch recent alert events (lightweight)
          runQuery(
            'dataset="otel" | where data_datatype == "criblapm_alert" | project _time, event_type, svc, signal_type | sort by _time desc | limit 5',
            '-24h', 'now', 5,
          ).then((rows) => setRecentAlerts(rows.map((r) => ({
            time: Number(r._time) * 1000,
            eventType: String(r.event_type ?? ''),
            service: String(r.svc ?? ''),
            signalType: String(r.signal_type ?? ''),
          })))).catch(() => {});
          return;
        }
      } catch { /* fall through */ }
    }

    const pSummaries = listServiceSummaries(range, 'now')
      .then((r) => setSummaries(r))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setSummaries([]);
      })
      .finally(() => setLoading(false));

    await pSummaries;
    hasDataRef.current = true;
    setRefreshing(false);

    runQuery(
      'dataset="otel" | where data_datatype == "criblapm_alert" | project _time, event_type, svc, signal_type | sort by _time desc | limit 5',
      '-24h', 'now', 5,
    ).then((rows) => setRecentAlerts(rows.map((r) => ({
      time: Number(r._time) * 1000,
      eventType: String(r.event_type ?? ''),
      service: String(r.svc ?? ''),
      signalType: String(r.signal_type ?? ''),
    })))).catch(() => {});
  }, [range, streamFilterEnabled]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const prevByService = useMemo(() => {
    const m = new Map<string, ServiceSummary>();
    for (const svc of prevSummaries) m.set(svc.service, svc);
    return m;
  }, [prevSummaries]);

  const anomalousServices = useMemo(() => {
    const set = new Set<string>();
    for (const a of anomalies) set.add(a.service);
    return set;
  }, [anomalies]);

  const rangeMs = relativeTimeMs(range);
  const rangeMinutes = rangeMs / 60_000;

  const detectedIssues = useMemo(() => {
    const anomalyIssues: import('../api/types').DetectedIssue[] = anomalies.map((a) => ({
      service: a.service,
      signalType: 'latency_anomaly' as const,
      severity: 'warn' as const,
      detail: `${a.operation} p95 ${a.currP95Us < 1_000_000 ? (a.currP95Us / 1000).toFixed(1) + 'ms' : (a.currP95Us / 1_000_000).toFixed(2) + 's'} (${a.ratio.toFixed(0)}x baseline)`,
      operation: a.operation,
    }));
    if (cachedIssues) return [...cachedIssues, ...anomalyIssues];
    return buildDetectedIssues(summaries, prevByService, edges, anomalies, anomalousServices, rangeMinutes);
  }, [cachedIssues, summaries, prevByService, edges, anomalies, anomalousServices, rangeMinutes]);

  // Key metrics
  const totalServices = summaries.length;
  const totalRequests = summaries.reduce((s, v) => s + v.requests, 0);
  const totalErrors = summaries.reduce((s, v) => s + v.errors, 0);
  const globalErrorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
  const globalReqPerMin = rangeMinutes > 0 ? totalRequests / rangeMinutes : 0;

  // Services with issues only
  const issueServices = useMemo(() => {
    return summaries
      .map((svc) => {
        const prev = prevByService.get(svc.service);
        const health = serviceHealth(svc, prev, anomalousServices);
        return { svc, health };
      })
      .filter(({ health }) => health.bucket !== 'healthy' && health.bucket !== 'idle')
      .sort((a, b) => {
        const order: Record<string, number> = { critical: 0, silent: 1, warn: 2, traffic_drop: 3, latency_anomaly: 4, watch: 5 };
        return (order[a.health.bucket] ?? 6) - (order[b.health.bucket] ?? 6);
      });
  }, [summaries, prevByService, anomalousServices]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Overview</h1>
          <p className={s.subtitle}>System health at a glance</p>
        </div>
        <div className={s.controls}>
          <TimeRangePicker value={range} onChange={setRange} />
          <button className={s.refreshBtn} onClick={() => void fetchAll()} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {refreshing && <div className={s.refreshBar} />}
      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <DetectedIssuesPanel
        issues={detectedIssues}
        loading={loading}
        lookback={range}
      />

      {/* Key metrics */}
      {!loading && (
        <div className={s.metricsRow}>
          <div className={s.metricCard}>
            <span className={s.metricValue}>{totalServices}</span>
            <span className={s.metricLabel}>Services</span>
          </div>
          <div className={s.metricCard}>
            <span className={s.metricValue}>{fmtRate(globalReqPerMin)}</span>
            <span className={s.metricLabel}>Request Rate</span>
          </div>
          <div className={s.metricCard}>
            <span className={`${s.metricValue} ${globalErrorRate > 0.01 ? s.metricValueError : ''}`}>
              {(globalErrorRate * 100).toFixed(2)}%
            </span>
            <span className={s.metricLabel}>Error Rate</span>
          </div>
          <div className={s.metricCard}>
            <span className={s.metricValue}>{detectedIssues.length}</span>
            <span className={s.metricLabel}>Active Issues</span>
          </div>
        </div>
      )}

      {/* Services with issues */}
      {issueServices.length > 0 && (
        <div className={s.card}>
          <div className={s.cardHeader}>
            <span className={s.cardTitle}>Services Needing Attention ({issueServices.length})</span>
            <Link to="/services" className={s.cardLink}>View all services →</Link>
          </div>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th className={s.num}>Error Rate</th>
                <th className={s.num}>Requests</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {issueServices.map(({ svc, health }) => (
                <tr key={svc.service} style={{ background: healthRowBg(health.bucket) }}>
                  <td>
                    <Link to={`/service/${encodeURIComponent(svc.service)}?range=${range}`} className={s.svcLink} style={{ color: serviceColor(svc.service) }}>
                      {svc.service}
                    </Link>
                  </td>
                  <td>
                    <span className={s.healthBadge} style={{ background: health.color + '20', color: health.color }}>
                      {health.bucket.replace('_', ' ')}
                    </span>
                  </td>
                  <td className={s.num}>{(svc.errorRate * 100).toFixed(2)}%</td>
                  <td className={s.num}>{svc.requests.toLocaleString()}</td>
                  <td>
                    <InvestigateButton
                      seed={{
                        question: `The ${svc.service} service is ${health.bucket.replace('_', ' ')}. Investigate the root cause.`,
                        service: svc.service,
                        knownSignals: [`Health: ${health.bucket}`, `Error rate: ${(svc.errorRate * 100).toFixed(2)}%`],
                        earliest: range,
                        latest: 'now',
                      }}
                      title={`Investigate ${svc.service}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent alert events */}
      {recentAlerts.length > 0 && (
        <div className={s.card}>
          <div className={s.cardHeader}>
            <span className={s.cardTitle}>Recent Alert Events</span>
            <Link to="/alerts" className={s.cardLink}>View all alerts →</Link>
          </div>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Service</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {recentAlerts.map((a, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(a.time).toLocaleString()}</td>
                  <td>
                    <span className={`${s.eventBadge} ${a.eventType === 'firing' ? s.eventFiring : s.eventResolved}`}>
                      {a.eventType}
                    </span>
                  </td>
                  <td>
                    <Link to={`/service/${encodeURIComponent(a.service)}?range=-1h`} className={s.svcLink} style={{ color: serviceColor(a.service) }}>
                      {a.service}
                    </Link>
                  </td>
                  <td>{a.signalType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Quick links */}
      {!loading && (
        <div className={s.quickLinks}>
          <Link to="/services" className={s.quickLink}>
            <span className={s.quickLinkIcon}>📋</span>
            <span>Service Catalog</span>
          </Link>
          <Link to="/map" className={s.quickLink}>
            <span className={s.quickLinkIcon}>🗺️</span>
            <span>Service Map</span>
          </Link>
          <Link to="/traces" className={s.quickLink}>
            <span className={s.quickLinkIcon}>🔍</span>
            <span>Search Traces</span>
          </Link>
          <Link to="/investigate" className={s.quickLink}>
            <span className={s.quickLinkIcon}>🤖</span>
            <span>Investigate</span>
          </Link>
        </div>
      )}
    </div>
  );
}
