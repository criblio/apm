import { newQueryGeneration, captureQueryGeneration } from '../api/queryGeneration';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Tag, type TagColor } from '@capra/core';
import TimeRangePicker from '../components/TimeRangePicker';
import StatusBanner from '../components/StatusBanner';
import DetectedIssuesPanel from '../components/DetectedIssuesPanel';
import ResilienceBoundary from '../components/ResilienceBoundary';
import PartialFailureBanner from '../components/PartialFailureBanner';
import {
  listServiceSummaries,
  listServiceCounts,
  listServiceLatencies,
  listOperationAnomalies,
  getDependencies,
} from '../api/search';
import { listCachedHomePanels } from '../api/panelCache';
import { runQuery } from '../api/cribl';
import * as Q from '../api/queries';
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

/** Health-bucket → Capra Tag color. Matches the SIGNAL_TAG_COLOR
 *  map in DetectedIssuesPanel so the home table + the issues panel
 *  speak the same color vocabulary for the same conditions. */
const HEALTH_TAG_COLOR: Record<string, TagColor> = {
  healthy: 'success',
  watch: 'warning',
  warn: 'warning',
  critical: 'danger',
  idle: 'default',
  silent: 'danger',
  traffic_drop: 'purple',
  latency_anomaly: 'cyan',
};

/** Alert event-type → Tag color. Recent alerts table on the home. */
const ALERT_EVENT_TAG_COLOR: Record<string, TagColor> = {
  firing: 'danger',
  resolved: 'success',
  pending: 'warning',
  resolving: 'info',
};

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
  const [partialFailures, setPartialFailures] = useState<Record<string, string>>({});
  const streamFilterEnabled = useStreamFilterEnabled();
  const hasDataRef = useRef(false);

  // Alert history panel — same query in the fast (cache-hit) and
  // slow (live) branches below. Built once per call so we pick up
  // the current dataset even if the user just changed it in Settings.
  const recentAlertsQuery = () => Q.alertHistory(5);

  const fetchAll = useCallback(async () => {
    newQueryGeneration(); // cancel the prior page/fetch's in-flight reads
    const isCurrent = captureQueryGeneration(); // guard stale async setState
    setRefreshing(true);
    setError(null);
    setPartialFailures({});
    if (range !== DEFAULT_RANGE) setCachedIssues(null);
    if (!hasDataRef.current) setLoading(true);

    const prev = previousWindow(range);
    listServiceSummaries(prev.earliest, prev.latest)
      .then((r) => { if (isCurrent()) setPrevSummaries(r); })
      .catch((e: unknown) => { if (isCurrent()) setPartialFailures((current) => ({
        ...current,
        'Previous-window comparison': e instanceof Error ? e.message : String(e),
      })); });

    getDependencies(range, 'now')
      .then((r) => { if (isCurrent()) setEdges(r); })
      .catch((e: unknown) => { if (isCurrent()) setPartialFailures((current) => ({
        ...current,
        Dependencies: e instanceof Error ? e.message : String(e),
      })); });

    listOperationAnomalies(range, 'now')
      .then((r) => { if (isCurrent()) setAnomalies(r); })
      .catch((e: unknown) => { if (isCurrent()) setPartialFailures((current) => ({
        ...current,
        'Latency anomalies': e instanceof Error ? e.message : String(e),
      })); });

    // Detected issues come from the $vt_results alert cache — load them
    // NON-BLOCKING so they never gate the fast metrics-backed panels.
    if (range === '-1h' && streamFilterEnabled) {
      listCachedHomePanels()
        .then((cached) => {
          if (isCurrent() && cached.alertRows && cached.alertRows.length > 0) {
            setCachedIssues(buildDetectedIssuesFromCache(cached.alertRows, 60));
          }
        })
        .catch(() => { /* issues are best-effort; don't surface */ });
    }

    // PRIMARY fast panel: per-service RED via metrics (off the worker
    // pool). Counts-first — render from the ~114ms counter read, then fill
    // p50/p95/p99 from the ~700ms histogram reads without blocking. First
    // content waits ONLY on the counts; everything else fills in around it.
    await listServiceCounts(range, 'now')
      .then((r) => {
        if (!isCurrent()) return;
        setSummaries(r);
        void listServiceLatencies(range, 'now')
          .then((lat) => {
            if (!lat || !isCurrent()) return;
            setSummaries((prev) =>
              prev.map((sv) => {
                const l = lat.get(sv.service);
                return l ? { ...sv, ...l } : sv;
              }),
            );
          })
          .catch(() => { /* best-effort latency */ });
      })
      .catch((e: unknown) => {
        if (!isCurrent()) return;
        setError(e instanceof Error ? e.message : String(e));
        setSummaries([]);
      })
      .finally(() => { if (isCurrent()) setLoading(false); });
    if (!isCurrent()) return;

    // Recent alert history — the only live-KQL job on this page. Fire it
    // AFTER the primary metric counts resolve so its search-job POST
    // doesn't contend with the fast metric reads during first paint.
    runQuery(recentAlertsQuery(), '-24h', 'now', 5)
      .then((rows) => { if (isCurrent()) setRecentAlerts(rows.map((r) => ({
        time: Number(r._time) * 1000,
        eventType: String(r.event_type ?? ''),
        service: String(r.svc ?? ''),
        signalType: String(r.signal_type ?? ''),
      }))); })
      .catch((e: unknown) => { if (isCurrent()) setPartialFailures((current) => ({
        ...current,
        'Recent alert history': e instanceof Error ? e.message : String(e),
      })); });

    hasDataRef.current = true;
    setRefreshing(false);
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
          <Button variant="secondary" size="sm" pending={refreshing} onClick={() => void fetchAll()}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {refreshing && <div className={s.refreshBar} />}
      {error && <StatusBanner kind="error">{error}</StatusBanner>}
      <PartialFailureBanner failures={partialFailures} onRetry={() => void fetchAll()} />

      <ResilienceBoundary title="Detected Issues panel is unavailable">
        <DetectedIssuesPanel
          issues={detectedIssues}
          loading={loading}
          lookback={range}
        />
      </ResilienceBoundary>

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
        <Card className={s.card}>
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
                    <Tag color={HEALTH_TAG_COLOR[health.bucket] ?? 'default'}>
                      {health.bucket.replace('_', ' ')}
                    </Tag>
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
        </Card>
      )}

      {/* Recent alert events */}
      {recentAlerts.length > 0 && (
        <Card className={s.card}>
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
                    <Tag color={ALERT_EVENT_TAG_COLOR[a.eventType] ?? 'default'}>
                      {a.eventType}
                    </Tag>
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
        </Card>
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
