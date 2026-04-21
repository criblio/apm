import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DependencyGraph from './DependencyGraph';
import IsometricGraph from './IsometricGraph';
import { serviceHealth } from '../utils/health';
import { listOperationSummaries } from '../api/search';
import type {
  DependencyEdge,
  ServiceSummary,
  ServiceBucket,
} from '../api/types';
import st from './SystemArchGraph.module.css';

type ViewMode = 'graph' | 'isometric';

export interface SystemArchGraphProps {
  edges: DependencyEdge[];
  services: Map<string, ServiceSummary>;
  prevServices: Map<string, ServiceSummary>;
  bucketsByService: Map<string, ServiceBucket[]>;
  loading: boolean;
  lookback: string;
  height?: number | string;
  error?: string | null;
}

export default function SystemArchGraph({
  edges,
  services,
  prevServices,
  bucketsByService,
  loading,
  lookback,
  height = 500,
  error,
}: SystemArchGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: typeof height === 'number' ? height : 500 });
  const [view, setView] = useState<ViewMode>('graph');

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      const r = containerRef.current?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) setDims({ w: r.width, h: r.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const serviceNames = useMemo(() => {
    const names = new Set<string>();
    for (const sv of services.values()) names.add(sv.service);
    for (const e of edges) {
      names.add(e.parent);
      names.add(e.child);
    }
    for (const sv of prevServices.values()) {
      if (sv.requests >= 50 && !services.has(sv.service)) {
        names.add(sv.service);
      }
    }
    return names;
  }, [services, prevServices, edges]);

  const unhealthyCount = useMemo(() => {
    const allNames = new Set([...services.keys(), ...prevServices.keys()]);
    return Array.from(allNames).filter((name) => {
      const cur = services.get(name);
      const h = serviceHealth(cur, prevServices.get(name));
      return (
        h.bucket === 'critical' ||
        h.bucket === 'warn' ||
        h.bucket === 'watch' ||
        h.bucket === 'traffic_drop' ||
        h.bucket === 'silent'
      );
    }).length;
  }, [services, prevServices]);

  const loadOperations = useCallback(
    (svc: string) => listOperationSummaries(svc, lookback, 'now'),
    [lookback],
  );

  const hasEdges = edges.filter((e) => e.parent !== e.child).length > 0;

  return (
    <div className={st.wrap}>
      <div className={st.toolbar}>
        <span className={st.toolbarTitle}>System Architecture</span>
        <div className={st.viewSwitch} role="tablist" aria-label="View mode">
          {(['graph', 'isometric'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={view === mode}
              className={`${st.viewBtn} ${view === mode ? st.viewBtnActive : ''}`}
              onClick={() => setView(mode)}
            >
              {mode === 'graph' ? 'Graph' : 'Isometric'}
            </button>
          ))}
        </div>
        <div className={st.spacer} />
        <div className={st.stats}>
          <span>
            Services <span className={st.statValue}>{serviceNames.size}</span>
          </span>
          <span>
            Edges{' '}
            <span className={st.statValue}>
              {edges.filter((e) => e.parent !== e.child).length}
            </span>
          </span>
          {unhealthyCount > 0 && (
            <span className={st.unhealthy}>
              {unhealthyCount} needing attention
            </span>
          )}
        </div>
      </div>

      <div
        className={st.canvas}
        ref={containerRef}
        style={{ height: typeof height === 'number' ? `${height}px` : height }}
      >
        {loading && <div className={st.empty}>Loading dependency graph...</div>}
        {!loading && !hasEdges && !error && (
          <div className={st.empty}>No service dependencies in this time range.</div>
        )}
        {!loading && hasEdges && view === 'graph' && (
          <DependencyGraph
            edges={edges}
            services={services}
            prevServices={prevServices}
            bucketsByService={bucketsByService}
            width={dims.w}
            height={dims.h}
            loadOperations={loadOperations}
            lookback={lookback}
          />
        )}
        {!loading && hasEdges && view === 'isometric' && (
          <IsometricGraph
            edges={edges}
            services={services}
            prevServices={prevServices}
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
