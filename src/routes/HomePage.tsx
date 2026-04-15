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

/** Minimum previous-window sample count before we trust its percentiles
 * enough to render a delta chip. Smaller windows produce noisy tails. */
const MIN_PREV_SAMPLES = 10;

/** Auto-refresh interval options. 0 = off. */
const REFRESH_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: 'Off', ms: 0 },
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '2m', ms: 120_000 },
  { label: '5m', ms: 300_000 },
];
const DEFAULT_REFRESH_MS = 60_000;

/** Threshold beyond which the "cached panels" stamp is treated as
 *  stale and surfaced as a chip on the affected panel headers. Set to
 *  3× the 5-minute scheduled-search cadence: a single missed run is
 *  still within normal drift, but three missed runs means the scheduler
 *  is not keeping up (cluster outage, Cribl Search backpressure, etc.)
 *  and the UI should warn the user before they mistake cached emptiness
 *  for a healthy system. */
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

/** Format a Date.now() - lastSeenMs gap as a short "Ns ago" / "Nm ago"
 *  string for the stale-row pill. */
function fmtAgo(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

/** Decide whether a service row is "stale" relative to the current
 *  range — i.e. its newest span is older than ~25% of the lookback
 *  window. The fraction is conservative on purpose: a service that's
 *  been silent for >¼ of the window is definitely showing residue
 *  and the user needs to know, but routine same-minute jitter
 *  shouldn't fire. */
function staleAge(
  lastSeenMs: number | undefined,
  rangeMs: number,
  now: number,
): { ageMs: number } | null {
  if (!lastSeenMs || !Number.isFinite(lastSeenMs)) return null;
  const ageMs = now - lastSeenMs;
  if (ageMs <= 0) return null;
  const threshold = rangeMs * 0.25;
  if (ageMs < threshold) return null;
  return { ageMs };
}

/**
 * Build an InvestigationSeed for a Home catalog row. Threads the
 * known anomaly signals (error rate delta, p95 delta, health bucket,
 * traffic rate) into the agent so it starts with the right
 * hypothesis instead of re-discovering them.
 */
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

/** Parse relative-time string like "-1h" / "-30m" into ms duration. */
function relativeTimeMs(rel: string): number {
  const m = rel.match(/^-(\d+)([smhd])$/);
  if (!m) return 3600_000;
  const n = Number(m[1]);
  const unit = m[2];
  return n * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit as 's' | 'm' | 'h' | 'd'];
}

export default function HomePage() {
  const [range, setRange] = useRangeParam(DEFAULT_RANGE);
  const navigate = useNavigate();
  const location = useLocation();
  // Passthrough the current search string (including ?range=) so
  // clicking into a service detail keeps the range context.
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
  // Timestamp (ms since epoch) of the latest bucket observed in the
  // most recent cached-panels read, or null when the current fetch
  // didn't read from cache. Used to render a "cache Nm stale" chip on
  // the Home panels when the scheduled-search cadence has slipped.
  const [panelCacheUpdatedMs, setPanelCacheUpdatedMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshMs, setRefreshMs] = useState<number>(DEFAULT_REFRESH_MS);
  const [sort, setSort] = useState<SortState>({ key: 'requests', dir: 'desc' });
  // Lazy initializer keeps Date.now() out of the render body (purity rule).
  const [lastRefresh, setLastRefresh] = useState<number>(() => Date.now());
  // Subscribing to the stream-filter toggle so the page re-fetches
  // when the user flips it in Settings. The value isn't used directly
  // in render; it just needs to be in fetchAll's dep list below.
  const streamFilterEnabled = useStreamFilterEnabled();

  const fetchAll = useCallback(async () => {
    setError(null);
    const binSeconds = binSecondsFor(range);
    setLoadingSummaries(true);
    setLoadingBuckets(true);
    setLoadingSlow(true);
    setLoadingErrors(true);
    setLoadingAnomalies(true);
    // Reset the cache stamp so the stale chip disappears when the
    // user navigates away from a cached range. It is repopulated
    // below only if the cache-fast path actually reads cached rows.
    setPanelCacheUpdatedMs(null);

    // Previous window of the same length — fuels the delta-vs-baseline
    // chips. Failure here is non-fatal; we just skip the chips. Fired
    // unconditionally because it's not part of the cacheable set
    // (the prior window changes with every user range pick).
    const prev = previousWindow(range);
    const pPrevSummaries = listServiceSummaries(prev.earliest, prev.latest)
      .then((r) => setPrevSummaries(r))
      .catch(() => setPrevSummaries([]));

    // Dependency edges — fuels the per-row "errors on call to <child>"
    // root-cause hint. Async, non-blocking; the catalog renders fine
    // without it, the hints just light up when the query lands.
    // Drawn from the same dependency query SystemArchPage uses, so
    // the data shape is consistent between Home and the graph view.
    const pEdges = getDependencies(range, 'now')
      .then((r) => setEdges(r))
      .catch(() => setEdges([]));

    // Latency anomaly detection — joins the current window against
    // the criblapm_op_baselines lookup maintained by the scheduled
    // baseline search (ROADMAP §2b.1). Fires unconditionally in the
    // background; populates the anomaly widget when it lands. If
    // the lookup doesn't exist yet (fresh install), the query
    // returns zero rows and the widget shows its empty state.
    const pAnomalies = listOperationAnomalies(range, 'now')
      .then((r) => setAnomalies(r))
      .catch(() => setAnomalies([]))
      .finally(() => setLoadingAnomalies(false));

    // Cache-fast path: when the user is on the default -1h range,
    // try a single batched $vt_results read for all four panels
    // before firing the live queries. A full cache hit returns
    // ~1 s end-to-end instead of the 8-15 s the live path needs.
    // Any miss (cache not populated, scheduled search hasn't run,
    // partial panel failure) transparently falls through to the
    // live queries.
    //
    // Stream-filter state is baked into the scheduled queries at
    // provision time, so when the user toggles the stream filter
    // we skip the cache too — otherwise they'd see stale filtered
    // data until the next scheduled run + re-provision.
    if (range === '-1h' && streamFilterEnabled) {
      try {
        const cached = await listCachedHomePanels();
        if (
          cached.serviceSummaries &&
          cached.serviceBuckets &&
          cached.slowClasses
        ) {
          setSummaries(cached.serviceSummaries);
          setBuckets(cached.serviceBuckets);
          setSlowClasses(cached.slowClasses);
          setLoadingSummaries(false);
          setLoadingBuckets(false);
          setLoadingSlow(false);
          setPanelCacheUpdatedMs(cached.lastUpdatedMs);

          // The error-spans scheduled search can write zero rows
          // during a cluster outage and then take several scheduled
          // runs to re-populate once telemetry recovers. Fall back
          // to a live listErrorClasses call when the cache returns
          // null or an empty array so the panel catches up on the
          // next render instead of waiting out the scheduler. The
          // other cached panels keep their fast-path values — only
          // the error classes panel pays the live-query latency.
          if (cached.errorClasses && cached.errorClasses.length > 0) {
            setErrorClasses(cached.errorClasses);
            setLoadingErrors(false);
          } else {
            void listErrorClasses(range, 'now')
              .then((r) => setErrorClasses(r))
              .catch(() => setErrorClasses([]))
              .finally(() => setLoadingErrors(false));
          }

          // Don't await the prev summary or anomaly query here —
          // let them resolve in the background and light up the
          // delta chips + anomaly widget when they land. The main
          // catalog is already usable.
          setLastRefresh(Date.now());
          return;
        }
      } catch {
        // Cache read failed — fall through to live fetch. Common on
        // fresh installs before the first scheduled run lands.
      }
    }

    // Fan out live queries — either because the user picked a
    // non-default range, flipped off the stream filter, or because
    // the cache came back empty.
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

    await Promise.allSettled([
      pSummaries,
      pPrevSummaries,
      pBuckets,
      pSlow,
      pErrors,
      pAnomalies,
      pEdges,
    ]);
    setLastRefresh(Date.now());
    // streamFilterEnabled is in the dep list so (a) flipping the
    // toggle triggers a re-fetch and (b) the cache-fast path
    // above reads the current value directly.
  }, [range, streamFilterEnabled]);

  // Initial load + on range change
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Auto-refresh with configurable interval. refreshMs === 0 disables.
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (refreshMs <= 0) return;
    timerRef.current = window.setInterval(() => {
      void fetchAll();
    }, refreshMs);
    return () => {
      if (timerRef.current != null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [refreshMs, fetchAll]);

  // Index previous-window summaries for O(1) lookup in the render loop.
  const prevByService = useMemo(() => {
    const m = new Map<string, ServiceSummary>();
    for (const svc of prevSummaries) m.set(svc.service, svc);
    return m;
  }, [prevSummaries]);

  // Services with at least one anomalous operation — used by
  // serviceHealth() to tint the catalog row cyan when any op for
  // that service is flagged, regardless of where it ranks in the
  // anomaly widget's own table.
  const anomalousServices = useMemo(() => {
    const set = new Set<string>();
    for (const a of anomalies) set.add(a.service);
    return set;
  }, [anomalies]);

  // Per-service "likely root cause" hint, derived from the dependency
  // edges. For each service, look at its outgoing rpc edges and pick
  // the downstream child with the highest error-rate-on-edge (errors
  // attributed to spans where this parent called that child). The
  // intent is to cut through error-propagation cascades like
  // cartFailure: frontend-proxy is the row tinted red, but the
  // outgoing-edge view shows the failure is on calls to its
  // downstream — and the user can click straight to the actual
  // root-cause service. Renders as a small "→ <child>" hint chip
  // next to the service name on rows where any downstream edge has
  // a meaningful error rate. Excludes ghost / silent / messaging
  // edges to keep the hint focused on the most common pattern.
  const rootCauseHints = useMemo(() => {
    const out = new Map<string, { child: string; errorRate: number }>();
    type EdgeAgg = { child: string; calls: number; errors: number };
    const byParent = new Map<string, EdgeAgg[]>();
    for (const e of edges) {
      if ((e.kind ?? 'rpc') !== 'rpc') continue;
      if (e.parent === e.child) continue;
      if (e.callCount < 5) continue; // skip noise-floor edges
      const list = byParent.get(e.parent) ?? [];
      list.push({
        child: e.child,
        calls: e.callCount,
        errors: e.errorCount,
      });
      byParent.set(e.parent, list);
    }
    for (const [parent, edgeList] of byParent.entries()) {
      let best: { child: string; errorRate: number } | null = null;
      for (const ed of edgeList) {
        if (ed.errors === 0) continue;
        const rate = ed.errors / ed.calls;
        if (rate < 0.005) continue; // sub-0.5% is below the noise floor
        if (!best || rate > best.errorRate) {
          best = { child: ed.child, errorRate: rate };
        }
      }
      if (best) out.set(parent, best);
    }
    return out;
  }, [edges]);

  // Group time-series buckets by service for sparklines
  const sparksByService = useMemo(() => {
    const byService = new Map<string, { t: number; v: number }[]>();
    const p95ByService = new Map<string, { t: number; v: number }[]>();
    for (const b of buckets) {
      if (!byService.has(b.service)) byService.set(b.service, []);
      if (!p95ByService.has(b.service)) p95ByService.set(b.service, []);
      byService.get(b.service)!.push({ t: b.bucketMs, v: b.requests });
      p95ByService.get(b.service)!.push({ t: b.bucketMs, v: b.p95Us });
    }
    // sort each series by time
    for (const arr of byService.values()) arr.sort((a, b) => a.t - b.t);
    for (const arr of p95ByService.values()) arr.sort((a, b) => a.t - b.t);
    return { requests: byService, p95: p95ByService };
  }, [buckets]);

  // Sort service table
  const sortedSummaries = useMemo(() => {
    const arr = [...summaries];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      if (key === 'service') {
        av = a.service;
        bv = b.service;
      } else {
        av = a[key] ?? 0;
        bv = b[key] ?? 0;
      }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [summaries, sort]);

  // Convert total requests over range → requests per minute
  const rangeMs = relativeTimeMs(range);
  const rangeMinutes = rangeMs / 60_000;
  function reqPerMin(totalRequests: number): number {
    return rangeMinutes > 0 ? totalRequests / rangeMinutes : 0;
  }

  // Age of the panel-cache snapshot, in ms, when the current
  // fetch actually read from cache AND that snapshot is older than
  // the staleness threshold. Passed to each panel whose data came
  // from the same cached scheduled-search batch so they can render
  // a "cache Nm stale" chip. When the current fetch bypassed the
  // cache (non-default range, stream filter off, cache-miss
  // fallback) or the snapshot is still within the expected
  // cadence, this stays null and no chip is rendered. Recomputes
  // on every refresh tick so the chip age ticks forward visibly.
  const panelCacheStaleAgeMs = useMemo(() => {
    if (panelCacheUpdatedMs == null) return null;
    const age = lastRefresh - panelCacheUpdatedMs;
    if (age < PANEL_CACHE_STALE_THRESHOLD_MS) return null;
    return age;
  }, [panelCacheUpdatedMs, lastRefresh]);

  function toggleSort(key: SortKey) {
    setSort((cur) => {
      if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      // Default direction: text = asc, numeric = desc (show highest first)
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
      {/* Hero bar with title, range picker, auto-refresh toggle */}
      <div className={s.hero}>
        <div>
          <h1 className={s.heroTitle}>Cribl APM</h1>
          <div className={s.heroSubtitle}>
            Service catalog, recent activity, and live trace data from the{' '}
            <code>otel</code> dataset.
          </div>
        </div>
        <div className={s.heroControls}>
          <TimeRangePicker value={range} onChange={setRange} />
          <div className={s.refreshPicker}>
            <span
              className={`${s.refreshStatusDot} ${refreshMs > 0 ? s.refreshStatusDotLive : ''}`}
              title={
                refreshMs > 0
                  ? `Auto-refresh every ${refreshMs / 1000}s — last: ${lastRefreshText}`
                  : `Auto-refresh off — last: ${lastRefreshText}`
              }
            />
            <span className={s.refreshLabel}>Refresh</span>
            <select
              className={s.refreshSelect}
              value={refreshMs}
              onChange={(e) => setRefreshMs(Number(e.target.value))}
              aria-label="Auto-refresh interval"
            >
              {REFRESH_OPTIONS.map((opt) => (
                <option key={opt.ms} value={opt.ms}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className={s.refreshBtn} onClick={() => void fetchAll()}>
            Refresh now
          </button>
        </div>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      {/* Service catalog */}
      <div className={s.catalog}>
        <div className={s.catalogHeader}>
          <span className={s.catalogTitle}>
            Services{' '}
            <span className={s.catalogCount}>
              {!loadingSummaries && `(${sortedSummaries.length})`}
            </span>
          </span>
          <span className={s.catalogCount}>
            Click a row for the service detail view
          </span>
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
                <th onClick={() => toggleSort('service')}>
                  Service <span className={s.sortChip}>{sortIndicator('service')}</span>
                </th>
                <th className={s.num} onClick={() => toggleSort('requests')}>
                  Rate <span className={s.sortChip}>{sortIndicator('requests')}</span>
                </th>
                <th className={s.num} onClick={() => toggleSort('errorRate')}>
                  Errors <span className={s.sortChip}>{sortIndicator('errorRate')}</span>
                </th>
                <th className={s.num} onClick={() => toggleSort('p50Us')}>
                  p50 <span className={s.sortChip}>{sortIndicator('p50Us')}</span>
                </th>
                <th className={s.num} onClick={() => toggleSort('p95Us')}>
                  p95 <span className={s.sortChip}>{sortIndicator('p95Us')}</span>
                </th>
                <th className={s.num} onClick={() => toggleSort('p99Us')}>
                  p99 <span className={s.sortChip}>{sortIndicator('p99Us')}</span>
                </th>
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
                // Only compare against the previous window when it had
                // enough samples to trust the percentiles. Without this,
                // services with tiny prev-window volume (flagd, image-
                // provider) produce noisy chips that misfire in the
                // wrong direction.
                const prevRaw = prevByService.get(svc.service);
                const prev = prevRaw && prevRaw.requests >= MIN_PREV_SAMPLES ? prevRaw : undefined;
                // serviceHealth takes the previous window + the
                // anomalous-services set so it can promote a row
                // to `traffic_drop` (rate fell off sharply vs
                // baseline) or `latency_anomaly` (some op for this
                // service is 5×+ slower than its durable baseline).
                // Both signals that error-rate-only bucketing
                // misses.
                const health = serviceHealth(svc, prevRaw, anomalousServices);
                const rowBg = healthRowBg(health.bucket);
                const prevReqPerMin = prev ? reqPerMin(prev.requests) : undefined;
                return (
                  <tr
                    key={svc.service}
                    style={rowBg !== 'transparent' ? { background: rowBg } : undefined}
                    onClick={() =>
                      navigate(`/service/${encodeURIComponent(svc.service)}${drillSuffix}`)
                    }
                  >
                    <td>
                      <Link
                        to={`/service/${encodeURIComponent(svc.service)}${drillSuffix}`}
                        className={s.svcCell}
                        onClick={(e) => e.stopPropagation()}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <span className={s.svcDot} style={{ background: color }} />
                        <span className={s.svcName}>{svc.service}</span>
                        {(() => {
                          // Stale-row indicator: when the newest span
                          // for this service is older than ~25% of
                          // the lookback window, the row is showing
                          // residue, not live data. Pin a small
                          // "last seen Ns ago" pill so the user knows
                          // they're looking at a snapshot of a
                          // service that's stopped reporting.
                          const stale = staleAge(svc.lastSeenMs, rangeMs, lastRefresh);
                          if (!stale) return null;
                          return (
                            <span
                              className={s.stalePill}
                              title={
                                'This service has not emitted a span recently — the row is residue from earlier in the window. ' +
                                'Click in for the per-minute timeline.'
                              }
                            >
                              last seen {fmtAgo(stale.ageMs)}
                            </span>
                          );
                        })()}
                        {(() => {
                          // Root-cause hint: only show when this row
                          // is itself anomalous (warn / critical) AND
                          // there's a downstream edge with meaningful
                          // errors. Without the row-level gate every
                          // service that calls anything erroring
                          // would carry a hint and the column gets
                          // noisy.
                          const noisy =
                            health.bucket === 'warn' ||
                            health.bucket === 'critical' ||
                            health.bucket === 'traffic_drop' ||
                            health.bucket === 'silent';
                          if (!noisy) return null;
                          const hint = rootCauseHints.get(svc.service);
                          if (!hint) return null;
                          // Don't suggest the row's own service.
                          if (hint.child === svc.service) return null;
                          const pct = (hint.errorRate * 100).toFixed(1);
                          return (
                            <span
                              className={s.rootCauseHint}
                              title={
                                `Outgoing calls from ${svc.service} to ${hint.child} are erroring at ${pct}% — ` +
                                `this row is likely red because of a downstream cascade. Click ${hint.child} to drill in.`
                              }
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                navigate(
                                  `/service/${encodeURIComponent(hint.child)}${drillSuffix}`,
                                );
                              }}
                            >
                              → likely {hint.child}
                            </span>
                          );
                        })()}
                      </Link>
                    </td>
                    <td className={s.num}>
                      <strong>{fmtRate(reqPerMin(svc.requests))}</strong>
                      <DeltaChip
                        curr={reqPerMin(svc.requests)}
                        prev={prevReqPerMin}
                        mode="rateDrop"
                        threshold={25}
                      />
                    </td>
                    <td className={`${s.num} ${err.className}`}>
                      {err.text}
                      <DeltaChip
                        curr={svc.errorRate}
                        prev={prev?.errorRate}
                        mode="points"
                        threshold={0.5}
                      />
                    </td>
                    <td className={s.num}>{fmtUs(svc.p50Us)}</td>
                    <td className={s.num}>
                      <strong>{fmtUs(svc.p95Us)}</strong>
                      <DeltaChip
                        curr={svc.p95Us}
                        prev={prev?.p95Us}
                        mode="rel"
                        threshold={30}
                      />
                    </td>
                    <td className={s.num}>
                      {fmtUs(svc.p99Us)}
                      <DeltaChip
                        curr={svc.p99Us}
                        prev={prev?.p99Us}
                        mode="rel"
                        threshold={30}
                      />
                    </td>
                    <td className={s.sparkCell}>
                      <Sparkline
                        data={reqSpark}
                        width={110}
                        height={24}
                        color={color}
                        fill
                        ariaLabel={`Request rate sparkline for ${svc.service}`}
                      />
                    </td>
                    <td className={s.sparkCell}>
                      <Sparkline
                        data={p95Spark}
                        width={110}
                        height={24}
                        color={color}
                        strokeWidth={1.5}
                        ariaLabel={`p95 latency sparkline for ${svc.service}`}
                      />
                    </td>
                    <td className={s.actionCell}>
                      <InvestigateButton
                        seed={buildHomeRowSeed(svc, health.bucket, prev, range)}
                        title={`Investigate ${svc.service}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Latency anomaly panel — full width, sits above the
          slow / error row. Only surfaces actionable rows; when
          nothing is anomalous the widget shows its empty state. */}
      <div className={s.panelsFull}>
        <OperationAnomalyList
          items={anomalies}
          loading={loadingAnomalies}
          lookback={range}
        />
      </div>

      {/* Bottom panels: slow trace classes + error classes */}
      <div className={s.panels}>
        <TraceClassList
          title="Slowest trace classes"
          subtitle="Grouped by root (service, operation) — click to view the worst example"
          items={slowClasses.map<ClassItem>((c) => ({
            key: `${c.rootService}\u0000${c.rootOperation}`,
            service: c.rootService,
            operation: c.rootOperation,
            count: c.count,
            sampleTraceID: c.sampleTraceIDs[0] ?? '',
            maxDurationUs: c.maxDurationUs,
            p95DurationUs: c.p95DurationUs,
            p50DurationUs: c.p50DurationUs,
          }))}
          loading={loadingSlow}
          mode="duration"
          emptyMessage="No traces in this range."
          staleCacheAgeMs={panelCacheStaleAgeMs}
        />
        <TraceClassList
          title="Error classes"
          subtitle="Grouped by (service, operation, message) — click to view a sample"
          items={errorClasses.map<ClassItem>((c) => ({
            key: `${c.service}\u0000${c.operation}\u0000${c.message}`,
            service: c.service,
            operation: c.operation,
            count: c.count,
            message: c.message,
            sampleTraceID: c.sampleTraceIDs[0] ?? '',
            lastSeenMs: c.lastSeenMs,
          }))}
          loading={loadingErrors}
          mode="errors"
          emptyMessage="No errors in this range — all clear."
          staleCacheAgeMs={panelCacheStaleAgeMs}
        />
      </div>

      {loadingBuckets && null /* sparklines fill in when buckets arrive */}
    </div>
  );
}
