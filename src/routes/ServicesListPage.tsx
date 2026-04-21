import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import TimeRangePicker from '../components/TimeRangePicker';
import { binSecondsFor } from '../components/timeRanges';
import Sparkline from '../components/Sparkline';
import StatusBanner from '../components/StatusBanner';
import TraceClassList, { type ClassItem } from '../components/TraceClassList';
import OperationAnomalyList from '../components/OperationAnomalyList';
import {
  listServiceSummaries,
  getServiceTimeSeries,
  listSlowTraceClasses,
  listErrorClasses,
  listOperationAnomalies,
  getDependencies,
} from '../api/search';
import { listCachedHomePanels } from '../api/panelCache';
import { serviceColor } from '../utils/spans';
import { serviceHealth, healthRowBg } from '../utils/health';
import { previousWindow } from '../utils/timeRange';
import { useRangeParam } from '../hooks/useRangeParam';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
import DeltaChip from '../components/DeltaChip';
import InvestigateButton from '../components/InvestigateButton';
import type { InvestigationSeed } from '../api/agentContext';
import type {
  ServiceSummary,
  ServiceBucket,
  SlowTraceClass,
  ErrorClass,
  OperationAnomaly,
  DependencyEdge,
} from '../api/types';
import s from './HomePage.module.css';

type SortKey =
  | 'service'
  | 'requests'
  | 'errorRate'
  | 'p50Us'
  | 'p95Us'
  | 'p99Us';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const DEFAULT_RANGE = '-1h';
const MIN_PREV_SAMPLES = 10;

const REFRESH_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: 'Off', ms: 0 },
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '2m', ms: 120_000 },
  { label: '5m', ms: 300_000 },
];
const DEFAULT_REFRESH_MS = 60_000;
const PANEL_CACHE_STALE_THRESHOLD_MS = 15 * 60_000;

function fmtRate(requestsPerMin: number): string {
  if (requestsPerMin >= 1000) return `${(requestsPerMin / 1000).toFixed(1)}k/min`;
  if (requestsPerMin >= 10) return `${requestsPerMin.toFixed(0)}/min`;
  return `${requestsPerMin.toFixed(1)}/min`;
}

function fmtUs(us: number): string {
  if (!Number.isFinite(us) || us === 0) return '—';
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function fmtErrorRate(rate: number): { text: string; className: string } {
  if (rate === 0) return { text: '0.00%', className: s.errZero };
  const pct = rate * 100;
  const cls = pct >= 5 ? s.errHigh : pct >= 1 ? s.errHigh : s.errLow;
  return { text: `${pct.toFixed(2)}%`, className: cls };
}

function fmtAgo(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function staleAge(
  lastSeenMs: number | undefined,
  rangeMs: number,
  now: number,
): { ageMs: number } | null {
  if (!lastSeenMs || !Number.isFinite(lastSeenMs)) return null;
  const ageMs = now - lastSeenMs;
  if (ageMs <= 0) return null;
  if (ageMs < rangeMs * 0.25) return null;
  return { ageMs };
}

function buildHomeRowSeed(
  svc: ServiceSummary,
  bucket: string,
  prev: ServiceSummary | undefined,
  range: string,
): InvestigationSeed {
  const signals: string[] = [];
  const errPct = svc.errorRate * 100;
  signals.push(`Error rate: ${errPct.toFixed(2)}%`);
  if (prev) {
    const prevPct = prev.errorRate * 100;
    const delta = errPct - prevPct;
    if (Math.abs(delta) >= 0.5) {
      signals.push(
        `Error rate ${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)}pp vs prior window (was ${prevPct.toFixed(2)}%)`,
      );
    }
  }
  signals.push(`p95 latency: ${fmtUs(svc.p95Us)}`);
  if (prev && prev.p95Us > 0) {
    const ratio = svc.p95Us / prev.p95Us;
    if (ratio >= 1.3 || ratio <= 0.7) {
      signals.push(
        `p95 ${ratio >= 1 ? '▲' : '▼'} ${(ratio * 100 - 100).toFixed(0)}% vs prior window (was ${fmtUs(prev.p95Us)})`,
      );
    }
  }
  signals.push(`Traffic: ${svc.requests.toLocaleString()} requests in ${range}`);
  if (bucket && bucket !== 'healthy' && bucket !== 'idle') {
    signals.push(`Health bucket: ${bucket}`);
  }

  const hypothesis =
    errPct >= 5
      ? `The ${svc.service} service has an error rate of ${errPct.toFixed(2)}%. Investigate the root cause.`
      : bucket === 'latency_anomaly'
        ? `The ${svc.service} service has a latency anomaly (p95=${fmtUs(svc.p95Us)}). Investigate what's driving it.`
        : bucket === 'traffic_drop'
          ? `The ${svc.service} service's traffic dropped compared to the prior window. Investigate why.`
          : `Investigate the current state and recent behavior of the ${svc.service} service.`;

  return {
    question: hypothesis,
    service: svc.service,
    knownSignals: signals,
    earliest: range,
    latest: 'now',
  };
}

function relativeTimeMs(rel: string): number {
  const m = rel.match(/^-(\d+)([smhd])$/);
  if (!m) return 3600_000;
  const n = Number(m[1]);
  const unit = m[2];
  return n * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit as 's' | 'm' | 'h' | 'd'];
}

export default function ServicesListPage() {
  const [range, setRange] = useRangeParam(DEFAULT_RANGE);
  const navigate = useNavigate();
  const location = useLocation();
  const drillSuffix = location.search;
  const [summaries, setSummaries] = useState<ServiceSummary[]>([]);
  const [prevSummaries, setPrevSummaries] = useState<ServiceSummary[]>([]);
  const [edges, setEdges] = useState<DependencyEdge[]>([]);
  const [buckets, setBuckets] = useState<ServiceBucket[]>([]);
  const [slowClasses, setSlowClasses] = useState<SlowTraceClass[]>([]);
  const [errorClasses, setErrorClasses] = useState<ErrorClass[]>([]);
  const [anomalies, setAnomalies] = useState<OperationAnomaly[]>([]);
  const [loadingSummaries, setLoadingSummaries] = useState(true);
  const [loadingBuckets, setLoadingBuckets] = useState(true);
  const [loadingSlow, setLoadingSlow] = useState(true);
  const [loadingErrors, setLoadingErrors] = useState(true);
  const [loadingAnomalies, setLoadingAnomalies] = useState(true);
  const [panelCacheUpdatedMs, setPanelCacheUpdatedMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshMs, setRefreshMs] = useState<number>(DEFAULT_REFRESH_MS);
  const [sort, setSort] = useState<SortState>({ key: 'requests', dir: 'desc' });
  const [lastRefresh, setLastRefresh] = useState<number>(() => Date.now());
  const streamFilterEnabled = useStreamFilterEnabled();

  const fetchAll = useCallback(async () => {
    setError(null);
    const binSeconds = binSecondsFor(range);
    setLoadingSummaries(true);
    setLoadingBuckets(true);
    setLoadingSlow(true);
    setLoadingErrors(true);
    setLoadingAnomalies(true);
    setPanelCacheUpdatedMs(null);

    const prev = previousWindow(range);
    listServiceSummaries(prev.earliest, prev.latest)
      .then((r) => setPrevSummaries(r))
      .catch(() => setPrevSummaries([]));

    getDependencies(range, 'now')
      .then((r) => setEdges(r))
      .catch(() => setEdges([]));

    listOperationAnomalies(range, 'now')
      .then((r) => setAnomalies(r))
      .catch(() => setAnomalies([]))
      .finally(() => setLoadingAnomalies(false));

    if (range === '-1h' && streamFilterEnabled) {
      try {
        const cached = await listCachedHomePanels();
        if (cached.serviceSummaries && cached.serviceBuckets && cached.slowClasses) {
          setSummaries(cached.serviceSummaries);
          setBuckets(cached.serviceBuckets);
          setSlowClasses(cached.slowClasses);
          setLoadingSummaries(false);
          setLoadingBuckets(false);
          setLoadingSlow(false);
          setPanelCacheUpdatedMs(cached.lastUpdatedMs);

          if (cached.errorClasses && cached.errorClasses.length > 0) {
            setErrorClasses(cached.errorClasses);
            setLoadingErrors(false);
          } else {
            void listErrorClasses(range, 'now')
              .then((r) => setErrorClasses(r))
              .catch(() => setErrorClasses([]))
              .finally(() => setLoadingErrors(false));
          }
          setLastRefresh(Date.now());
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
      .finally(() => setLoadingSummaries(false));

    const pBuckets = getServiceTimeSeries(binSeconds, undefined, range, 'now')
      .then((r) => setBuckets(r))
      .catch(() => setBuckets([]))
      .finally(() => setLoadingBuckets(false));

    const pSlow = listSlowTraceClasses(range, 'now')
      .then((r) => setSlowClasses(r))
      .catch(() => setSlowClasses([]))
      .finally(() => setLoadingSlow(false));

    const pErrors = listErrorClasses(range, 'now')
      .then((r) => setErrorClasses(r))
      .catch(() => setErrorClasses([]))
      .finally(() => setLoadingErrors(false));

    await Promise.allSettled([pSummaries, pBuckets, pSlow, pErrors]);
    setLastRefresh(Date.now());
  }, [range, streamFilterEnabled]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (refreshMs <= 0) return;
    timerRef.current = window.setInterval(() => { void fetchAll(); }, refreshMs);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [refreshMs, fetchAll]);

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

  const rootCauseHints = useMemo(() => {
    const out = new Map<string, { child: string; errorRate: number }>();
    const byParent = new Map<string, Array<{ child: string; calls: number; errors: number }>>();
    for (const e of edges) {
      if ((e.kind ?? 'rpc') !== 'rpc' || e.parent === e.child || e.callCount < 5) continue;
      const list = byParent.get(e.parent) ?? [];
      list.push({ child: e.child, calls: e.callCount, errors: e.errorCount });
      byParent.set(e.parent, list);
    }
    for (const [parent, edgeList] of byParent) {
      let best: { child: string; errorRate: number } | null = null;
      for (const ed of edgeList) {
        if (ed.errors === 0) continue;
        const rate = ed.errors / ed.calls;
        if (rate < 0.005) continue;
        if (!best || rate > best.errorRate) best = { child: ed.child, errorRate: rate };
      }
      if (best) out.set(parent, best);
    }
    return out;
  }, [edges]);

  const sparksByService = useMemo(() => {
    const byService = new Map<string, { t: number; v: number }[]>();
    const p95ByService = new Map<string, { t: number; v: number }[]>();
    for (const b of buckets) {
      if (!byService.has(b.service)) byService.set(b.service, []);
      if (!p95ByService.has(b.service)) p95ByService.set(b.service, []);
      byService.get(b.service)!.push({ t: b.bucketMs, v: b.requests });
      p95ByService.get(b.service)!.push({ t: b.bucketMs, v: b.p95Us });
    }
    for (const arr of byService.values()) arr.sort((a, b) => a.t - b.t);
    for (const arr of p95ByService.values()) arr.sort((a, b) => a.t - b.t);
    return { requests: byService, p95: p95ByService };
  }, [buckets]);

  const sortedSummaries = useMemo(() => {
    const arr = [...summaries];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0;
      if (key === 'service') { av = a.service; bv = b.service; }
      else { av = a[key] ?? 0; bv = b[key] ?? 0; }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [summaries, sort]);

  const rangeMs = relativeTimeMs(range);
  const rangeMinutes = rangeMs / 60_000;
  function reqPerMin(totalRequests: number): number {
    return rangeMinutes > 0 ? totalRequests / rangeMinutes : 0;
  }

  const panelCacheStaleAgeMs = useMemo(() => {
    if (panelCacheUpdatedMs == null) return null;
    const age = lastRefresh - panelCacheUpdatedMs;
    if (age < PANEL_CACHE_STALE_THRESHOLD_MS) return null;
    return age;
  }, [panelCacheUpdatedMs, lastRefresh]);

  function toggleSort(key: SortKey) {
    setSort((cur) => {
      if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      return { key, dir: key === 'service' ? 'asc' : 'desc' };
    });
  }

  function sortIndicator(key: SortKey): string {
    if (sort.key !== key) return '';
    return sort.dir === 'desc' ? '▼' : '▲';
  }

  const lastRefreshText = new Date(lastRefresh).toLocaleTimeString();

  return (
    <div className={s.page}>
      <div className={s.hero}>
        <div>
          <h1 className={s.heroTitle}>Services</h1>
          <div className={s.heroSubtitle}>
            Service catalog with rate, errors, and latency metrics.
          </div>
        </div>
        <div className={s.heroControls}>
          <TimeRangePicker value={range} onChange={setRange} />
          <div className={s.refreshPicker}>
            <span
              className={`${s.refreshStatusDot} ${refreshMs > 0 ? s.refreshStatusDotLive : ''}`}
              title={refreshMs > 0 ? `Auto-refresh every ${refreshMs / 1000}s — last: ${lastRefreshText}` : `Auto-refresh off — last: ${lastRefreshText}`}
            />
            <span className={s.refreshLabel}>Refresh</span>
            <select className={s.refreshSelect} value={refreshMs} onChange={(e) => setRefreshMs(Number(e.target.value))} aria-label="Auto-refresh interval">
              {REFRESH_OPTIONS.map((opt) => (
                <option key={opt.ms} value={opt.ms}>{opt.label}</option>
              ))}
            </select>
          </div>
          <button type="button" className={s.refreshBtn} onClick={() => void fetchAll()}>Refresh now</button>
        </div>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className={s.catalog}>
        <div className={s.catalogHeader}>
          <span className={s.catalogTitle}>
            Services{' '}
            <span className={s.catalogCount}>{!loadingSummaries && `(${sortedSummaries.length})`}</span>
          </span>
          <span className={s.catalogCount}>Click a row for the service detail view</span>
        </div>
        {loadingSummaries ? (
          <div className={s.tableSkeleton}>
            {[82, 75, 88, 70, 94, 66, 80].map((w, i) => (
              <div key={i} style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : sortedSummaries.length === 0 ? (
          <div className={s.empty}>No services reported traces in this range.</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th onClick={() => toggleSort('service')}>Service <span className={s.sortChip}>{sortIndicator('service')}</span></th>
                <th className={s.num} onClick={() => toggleSort('requests')}>Rate <span className={s.sortChip}>{sortIndicator('requests')}</span></th>
                <th className={s.num} onClick={() => toggleSort('errorRate')}>Errors <span className={s.sortChip}>{sortIndicator('errorRate')}</span></th>
                <th className={s.num} onClick={() => toggleSort('p50Us')}>p50 <span className={s.sortChip}>{sortIndicator('p50Us')}</span></th>
                <th className={s.num} onClick={() => toggleSort('p95Us')}>p95 <span className={s.sortChip}>{sortIndicator('p95Us')}</span></th>
                <th className={s.num} onClick={() => toggleSort('p99Us')}>p99 <span className={s.sortChip}>{sortIndicator('p99Us')}</span></th>
                <th>Requests</th>
                <th>Latency p95</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedSummaries.map((svc) => {
                const color = serviceColor(svc.service);
                const err = fmtErrorRate(svc.errorRate);
                const reqSpark = sparksByService.requests.get(svc.service) ?? [];
                const p95Spark = sparksByService.p95.get(svc.service) ?? [];
                const prevRaw = prevByService.get(svc.service);
                const prev = prevRaw && prevRaw.requests >= MIN_PREV_SAMPLES ? prevRaw : undefined;
                const health = serviceHealth(svc, prevRaw, anomalousServices);
                const rowBg = healthRowBg(health.bucket);
                const prevReqPerMin = prev ? reqPerMin(prev.requests) : undefined;
                return (
                  <tr key={svc.service} style={rowBg !== 'transparent' ? { background: rowBg } : undefined} onClick={() => navigate(`/service/${encodeURIComponent(svc.service)}${drillSuffix}`)}>
                    <td>
                      <Link to={`/service/${encodeURIComponent(svc.service)}${drillSuffix}`} className={s.svcCell} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none', color: 'inherit' }}>
                        <span className={s.svcDot} style={{ background: color }} />
                        <span className={s.svcName}>{svc.service}</span>
                        {(() => {
                          const stale = staleAge(svc.lastSeenMs, rangeMs, lastRefresh);
                          if (!stale) return null;
                          return <span className={s.stalePill} title="This service has not emitted a span recently.">last seen {fmtAgo(stale.ageMs)}</span>;
                        })()}
                        {(() => {
                          const noisy = health.bucket === 'warn' || health.bucket === 'critical' || health.bucket === 'traffic_drop' || health.bucket === 'silent';
                          if (!noisy) return null;
                          const hint = rootCauseHints.get(svc.service);
                          if (!hint || hint.child === svc.service) return null;
                          const pct = (hint.errorRate * 100).toFixed(1);
                          return (
                            <span className={s.rootCauseHint} title={`Outgoing calls to ${hint.child} are erroring at ${pct}%`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/service/${encodeURIComponent(hint.child)}${drillSuffix}`); }}>
                              → likely {hint.child}
                            </span>
                          );
                        })()}
                      </Link>
                    </td>
                    <td className={s.num}><strong>{fmtRate(reqPerMin(svc.requests))}</strong><DeltaChip curr={reqPerMin(svc.requests)} prev={prevReqPerMin} mode="rateDrop" threshold={25} /></td>
                    <td className={`${s.num} ${err.className}`}>{err.text}<DeltaChip curr={svc.errorRate} prev={prev?.errorRate} mode="points" threshold={0.5} /></td>
                    <td className={s.num}>{fmtUs(svc.p50Us)}</td>
                    <td className={s.num}><strong>{fmtUs(svc.p95Us)}</strong><DeltaChip curr={svc.p95Us} prev={prev?.p95Us} mode="rel" threshold={30} /></td>
                    <td className={s.num}>{fmtUs(svc.p99Us)}<DeltaChip curr={svc.p99Us} prev={prev?.p99Us} mode="rel" threshold={30} /></td>
                    <td className={s.sparkCell}><Sparkline data={reqSpark} width={110} height={24} color={color} fill ariaLabel={`Request rate sparkline for ${svc.service}`} /></td>
                    <td className={s.sparkCell}><Sparkline data={p95Spark} width={110} height={24} color={color} strokeWidth={1.5} ariaLabel={`p95 latency sparkline for ${svc.service}`} /></td>
                    <td className={s.actionCell}><InvestigateButton seed={buildHomeRowSeed(svc, health.bucket, prev, range)} title={`Investigate ${svc.service}`} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className={s.panelsFull}>
        <OperationAnomalyList items={anomalies} loading={loadingAnomalies} lookback={range} />
      </div>

      <div className={s.panels}>
        <TraceClassList
          title="Slowest trace classes"
          subtitle="Grouped by root (service, operation) — click to view the worst example"
          items={slowClasses.map<ClassItem>((c) => ({ key: `${c.rootService}\u0000${c.rootOperation}`, service: c.rootService, operation: c.rootOperation, count: c.count, sampleTraceID: c.sampleTraceIDs[0] ?? '', maxDurationUs: c.maxDurationUs, p95DurationUs: c.p95DurationUs, p50DurationUs: c.p50DurationUs }))}
          loading={loadingSlow}
          mode="duration"
          emptyMessage="No traces in this range."
          staleCacheAgeMs={panelCacheStaleAgeMs}
        />
        <TraceClassList
          title="Error classes"
          subtitle="Grouped by (service, operation, message) — click to view a sample"
          items={errorClasses.map<ClassItem>((c) => ({ key: `${c.service}\u0000${c.operation}\u0000${c.message}`, service: c.service, operation: c.operation, count: c.count, message: c.message, sampleTraceID: c.sampleTraceIDs[0] ?? '', lastSeenMs: c.lastSeenMs }))}
          loading={loadingErrors}
          mode="errors"
          emptyMessage="No errors in this range — all clear."
          staleCacheAgeMs={panelCacheStaleAgeMs}
        />
      </div>
    </div>
  );
}
