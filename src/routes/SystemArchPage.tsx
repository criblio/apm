import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRangeParam } from '../hooks/useRangeParam';
import DependencyGraph from '../components/DependencyGraph';
import IsometricGraph from '../components/IsometricGraph';
import StatusBanner from '../components/StatusBanner';
import {
  getDependencies,
  listServiceSummaries,
  getServiceTimeSeries,
  listOperationSummaries,
} from '../api/search';
import { listCachedSysarchPanels } from '../api/panelCache';
import { binSecondsFor } from '../components/timeRanges';
import { previousWindow } from '../utils/timeRange';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
import { HEALTH_LEGEND, serviceHealth } from '../utils/health';
import type {
  DependencyEdge,
  ServiceSummary,
  ServiceBucket,
} from '../api/types';
import s from './SystemArchPage.module.css';

const LOOKBACKS = [
  { label: 'Last 15 minutes', value: '-15m' },
  { label: 'Last 1 hour', value: '-1h' },
  { label: 'Last 6 hours', value: '-6h' },
  { label: 'Last 24 hours', value: '-24h' },
];

type ViewMode = 'graph' | 'isometric';
const VIEW_MODES: Array<{ value: ViewMode; label: string }> = [
  { value: 'graph', label: 'Graph' },
  { value: 'isometric', label: 'Isometric' },
];

export default function SystemArchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);

  // Unified with Home + Service Detail via ?range=. Keep reading the old
  // `?lookback=` param as a fallback so stale bookmarks don't silently
  // snap back to 1h, but write only to `?range=` going forward.
  const [rangeFromHook, setRange] = useRangeParam('-1h');
  const legacyLookback = searchParams.get('lookback');
  const lookback = searchParams.get('range') ?? legacyLookback ?? rangeFromHook;
  const viewParam = searchParams.get('view');
  const view: ViewMode = viewParam === 'isometric' ? 'isometric' : 'graph';
  const [edges, setEdges] = useState<DependencyEdge[]>([]);
  const [summaries, setSummaries] = useState<ServiceSummary[]>([]);
  const [prevSummaries, setPrevSummaries] = useState<ServiceSummary[]>([]);
  const [buckets, setBuckets] = useState<ServiceBucket[]>([]);
  const [loadingDeps, setLoadingDeps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const streamFilterEnabled = useStreamFilterEnabled();

  // Track container size for the SVG
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      const r = containerRef.current?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) setDims({ w: r.width, h: r.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Fetch dependencies + service stats + time-series. Tries the
  // batched $vt_results cache first when the user is on -1h and
  // the stream filter is on; falls through to live queries on
  // cache miss or non-default range.
  useEffect(() => {
    let cancelled = false;
    const binSeconds = binSecondsFor(lookback);
    setLoadingDeps(true);
    setError(null);

    // Previous-window summaries always live — range-dependent,
    // not cacheable. Fires in the background and feeds traffic-
    // drop detection in serviceHealth().
    const prev = previousWindow(lookback);
    listServiceSummaries(prev.earliest, prev.latest)
      .then((r) => {
        if (!cancelled) setPrevSummaries(r);
      })
      .catch(() => {
        if (!cancelled) setPrevSummaries([]);
      });

    const tryCache = async (): Promise<boolean> => {
      if (lookback !== '-1h' || !streamFilterEnabled) return false;
      try {
        const cached = await listCachedSysarchPanels();
        if (
          cached.serviceSummaries &&
          cached.serviceBuckets &&
          cached.dependencies
        ) {
          if (cancelled) return true;
          setSummaries(cached.serviceSummaries);
          setBuckets(cached.serviceBuckets);
          setEdges(cached.dependencies);
          setLoadingDeps(false);
          return true;
        }
      } catch {
        /* fall through to live */
      }
      return false;
    };

    (async () => {
      const cacheHit = await tryCache();
      if (cacheHit || cancelled) return;

      // Cache miss — live queries.
      const pDeps = getDependencies(lookback, 'now')
        .then((e) => {
          if (!cancelled) setEdges(e);
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setEdges([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingDeps(false);
        });

      listServiceSummaries(lookback, 'now')
        .then((r) => {
          if (!cancelled) setSummaries(r);
        })
        .catch(() => {
          if (!cancelled) setSummaries([]);
        });

      getServiceTimeSeries(binSeconds, undefined, lookback, 'now')
        .then((r) => {
          if (!cancelled) setBuckets(r);
        })
        .catch(() => {
          if (!cancelled) setBuckets([]);
        });

      void pDeps;
    })();

    return () => {
      cancelled = true;
    };
  }, [lookback, streamFilterEnabled]);

  function setLookback(value: string) {
    // Clear the legacy ?lookback= if present so we don't end up with
    // both keys. The hook handles the canonical ?range= write.
    if (legacyLookback != null) {
      const next = new URLSearchParams(searchParams);
      next.delete('lookback');
      setSearchParams(next, { replace: true });
    }
    setRange(value);
  }

  function setView(value: ViewMode) {
    const next = new URLSearchParams(searchParams);
    if (value === 'graph') next.delete('view');
    else next.set('view', value);
    setSearchParams(next, { replace: true });
  }

  // Build fast lookups used by the graph
  const servicesMap = useMemo(() => {
    const m = new Map<string, ServiceSummary>();
    for (const sv of summaries) m.set(sv.service, sv);
    return m;
  }, [summaries]);

  const prevServicesMap = useMemo(() => {
    const m = new Map<string, ServiceSummary>();
    for (const sv of prevSummaries) m.set(sv.service, sv);
    return m;
  }, [prevSummaries]);

  const bucketsByService = useMemo(() => {
    const m = new Map<string, ServiceBucket[]>();
    for (const b of buckets) {
      if (!m.has(b.service)) m.set(b.service, []);
      m.get(b.service)!.push(b);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.bucketMs - b.bucketMs);
    return m;
  }, [buckets]);

  // Summary count: current services + edge endpoints + any
  // prior-window service that crossed the ghost-node threshold and
  // will be drawn on the graph below.
  const serviceNames = new Set<string>();
  for (const sv of summaries) serviceNames.add(sv.service);
  for (const e of edges) {
    serviceNames.add(e.parent);
    serviceNames.add(e.child);
  }
  for (const sv of prevSummaries) {
    if (sv.requests >= 50 && !servicesMap.has(sv.service)) {
      serviceNames.add(sv.service);
    }
  }

  // Count unhealthy services for the toolbar summary. Includes
  // traffic-drop and silent (ghost) services so the count matches
  // what the user sees visually — a kafka-lag'd service with 0
  // errors still counts because its halo is purple, and a
  // silently-gone service still counts because it's drawn as a
  // ghost. Silent services are computed against the union of
  // current and prior summaries so the prior-only ghost nodes are
  // included in the total.
  const allSvcNames = new Set<string>([
    ...servicesMap.keys(),
    ...prevServicesMap.keys(),
  ]);
  const unhealthyCount = Array.from(allSvcNames).filter((name) => {
    const cur = servicesMap.get(name);
    const h = serviceHealth(cur, prevServicesMap.get(name));
    return (
      h.bucket === 'critical' ||
      h.bucket === 'warn' ||
      h.bucket === 'watch' ||
      h.bucket === 'traffic_drop' ||
      h.bucket === 'silent'
    );
  }).length;

  // Lazy loader passed to each NodeTooltip — fetches per-service
  // operations on hover. Pre-binds the current lookback so the
  // tooltip component doesn't need to know about time windows, and
  // its identity changes whenever the range does so the tooltip
  // cache keys stay consistent.
  const loadOperations = useCallback(
    (svc: string) => listOperationSummaries(svc, lookback, 'now'),
    [lookback],
  );

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <div className={s.viewSwitch} role="tablist" aria-label="View mode">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="tab"
              aria-selected={view === mode.value}
              className={`${s.viewBtn} ${view === mode.value ? s.viewBtnActive : ''}`}
              onClick={() => setView(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <span className={s.label}>Lookback</span>
        <select className={s.select} value={lookback} onChange={(e) => setLookback(e.target.value)}>
          {LOOKBACKS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <div className={s.legend} title="Health is shown by the halo ring around each node">
          {HEALTH_LEGEND.map((h) => {
            const isHealthy = h.bucket === 'healthy';
            const isIdle = h.bucket === 'idle';
            return (
              <span key={h.bucket} className={s.legendItem} title={h.label}>
                <span className={s.legendSwatch}>
                  <span className={s.legendSwatchDisc} />
                  {!isHealthy && (
                    <span
                      className={s.legendSwatchRing}
                      style={{
                        borderColor: h.color,
                        borderStyle: isIdle ? 'dashed' : 'solid',
                      }}
                    />
                  )}
                </span>
                {h.bucket === 'traffic_drop' ? 'traffic drop' : h.bucket}
              </span>
            );
          })}
        </div>
        <div className={s.spacer} />
        <div className={s.stats}>
          <span>
            Services <span className={s.statValue}>{serviceNames.size}</span>
          </span>
          <span>
            Edges{' '}
            <span className={s.statValue}>
              {edges.filter((e) => e.parent !== e.child).length}
            </span>
          </span>
          {unhealthyCount > 0 && (
            <span className={s.unhealthy}>
              {unhealthyCount} needing attention
            </span>
          )}
        </div>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className={s.canvasWrap} ref={containerRef}>
        {loadingDeps && <div className={s.empty}>Loading dependency graph…</div>}
        {!loadingDeps && edges.length === 0 && !error && (
          <div className={s.empty}>No service dependencies in this time range.</div>
        )}
        {!loadingDeps && edges.length > 0 && view === 'graph' && (
          <DependencyGraph
            edges={edges}
            services={servicesMap}
            prevServices={prevServicesMap}
            bucketsByService={bucketsByService}
            width={dims.w}
            height={dims.h}
            loadOperations={loadOperations}
            lookback={lookback}
          />
        )}
        {!loadingDeps && edges.length > 0 && view === 'isometric' && (
          <IsometricGraph
            edges={edges}
            services={servicesMap}
            prevServices={prevServicesMap}
            bucketsByService={bucketsByService}
            width={dims.w}
            height={dims.h}
            loadOperations={loadOperations}
            lookback={lookback}
          />
        )}
      </div>
    </div>
  );
}
