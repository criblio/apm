import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import TimeRangePicker from '../components/TimeRangePicker';
import { binSecondsFor } from '../components/timeRanges';
import LineChart, { type LineSeries } from '../components/LineChart';
import TraceBriefList from '../components/TraceBriefList';
import StatusBanner from '../components/StatusBanner';
import MetricsCard, { type MetricsCardRow } from '../components/MetricsCard';
import {
  listServiceSummaries,
  getServiceTimeSeries,
  listOperationSummaries,
  listServiceInstances,
  listRecentErrorTraces,
  getDependencies,
  listServiceMetricNames,
  getServiceMetricsBatch,
} from '../api/search';
import { runQuery } from '../api/cribl';
import { listCachedSvcDetailPanels } from '../api/panelCache';
import { serviceColor } from '../utils/spans';
import { previousWindow } from '../utils/timeRange';
import { useRangeParam } from '../hooks/useRangeParam';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
import DeltaChip from '../components/DeltaChip';
import InvestigateButton from '../components/InvestigateButton';
import type { InvestigationSeed } from '../api/agentContext';
import type {
  ServiceSummary,
  ServiceBucket,
  OperationSummary,
  InstanceSummary,
  TraceBrief,
  DependencyEdge,
} from '../api/types';
import s from './ServiceDetailPage.module.css';

const DEFAULT_RANGE = '-1h';

/** See HomePage — same rationale. */
const MIN_PREV_SAMPLES = 10;

/**
 * Static union of every candidate metric that any card might show.
 * Used to issue a single batched series query at page load time
 * in parallel with the catalog lookup — accepting a small amount
 * of over-fetch for metrics the service doesn't actually emit, in
 * exchange for firing both round trips concurrently. Keep in sync
 * with the row configs below.
 */
const ALL_CARD_METRICS: string[] = [
  // Protocol
  'http.client.request.duration',
  'http.client.duration',
  'http.server.request.duration',
  'http.server.duration',
  'rpc.client.duration',
  'rpc.server.duration',
  'db.client.operation.duration',
  'db.client.connection.count',
  // Runtime
  'jvm.memory.used',
  'jvm.gc.duration',
  'jvm.thread.count',
  'jvm.cpu.recent_utilization',
  'process.runtime.cpython.memory',
  'process.runtime.cpython.cpu.utilization',
  'process.runtime.cpython.gc_count',
  'process.runtime.cpython.thread_count',
  'process.cpu.utilization',
  'process.memory.usage',
  // Infrastructure
  'k8s.container.restarts',
  'k8s.container.ready',
  'k8s.pod.phase',
  'k8s.container.memory_limit',
  'k8s.container.memory_request',
  'k8s.container.cpu_limit',
];

function fmtUs(us: number): string {
  if (!Number.isFinite(us) || us === 0) return '—';
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function fmtUsAxis(us: number): string {
  if (us === 0) return '0';
  if (us < 1000) return `${us.toFixed(0)}μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(0)}ms`;
  return `${(us / 1_000_000).toFixed(1)}s`;
}

function fmtRate(requestsPerMin: number): string {
  if (requestsPerMin >= 1000) return `${(requestsPerMin / 1000).toFixed(1)}k/min`;
  if (requestsPerMin >= 10) return `${requestsPerMin.toFixed(0)}/min`;
  return `${requestsPerMin.toFixed(1)}/min`;
}

function errClass(rate: number): string {
  if (rate === 0) return s.errZero;
  return rate * 100 >= 1 ? s.errHigh : s.errLow;
}

/**
 * Build an InvestigationSeed for the Service Detail page. Threads
 * the service's current error rate, p95 delta, and top anomalous
 * operations so the agent starts with specific evidence instead of
 * a generic "investigate this service".
 */
function buildServiceSeed(
  serviceName: string,
  summary: ServiceSummary | null,
  prev: ServiceSummary | null,
  operations: OperationSummary[],
  range: string,
): InvestigationSeed {
  const signals: string[] = [];
  if (summary) {
    signals.push(`Error rate: ${(summary.errorRate * 100).toFixed(2)}%`);
    signals.push(`p95: ${fmtUs(summary.p95Us)}, p99: ${fmtUs(summary.p99Us)}`);
    signals.push(`Total requests: ${summary.requests.toLocaleString()}`);
  }
  if (prev && summary) {
    const deltaPct = (summary.errorRate - prev.errorRate) * 100;
    if (Math.abs(deltaPct) >= 0.5) {
      signals.push(
        `Error rate delta: ${deltaPct >= 0 ? '▲' : '▼'}${Math.abs(deltaPct).toFixed(2)}pp vs prior window`,
      );
    }
    if (prev.p95Us > 0) {
      const ratio = summary.p95Us / prev.p95Us;
      if (ratio >= 1.3 || ratio <= 0.7) {
        signals.push(
          `p95 delta: ${ratio >= 1 ? '▲' : '▼'}${(ratio * 100 - 100).toFixed(0)}% vs prior window`,
        );
      }
    }
  }
  // Top erroring operations
  const erroring = operations
    .filter((o) => o.errorRate > 0)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 3);
  if (erroring.length > 0) {
    const list = erroring
      .map((o) => `${o.operation} (${(o.errorRate * 100).toFixed(1)}% errors)`)
      .join(', ');
    signals.push(`Top erroring operations: ${list}`);
  }
  // Top slow operations (by p95)
  const slow = [...operations].sort((a, b) => b.p95Us - a.p95Us).slice(0, 3);
  if (slow.length > 0) {
    const list = slow
      .map((o) => `${o.operation} (p95=${fmtUs(o.p95Us)})`)
      .join(', ');
    signals.push(`Slowest operations by p95: ${list}`);
  }

  const hasErrors = summary && summary.errorRate > 0.01;
  const question = hasErrors
    ? `The ${serviceName} service has an error rate of ${((summary?.errorRate ?? 0) * 100).toFixed(2)}%. Investigate the root cause and identify which operations and downstream dependencies are involved.`
    : `Investigate the current behavior of the ${serviceName} service. Look for any anomalies in latency, error patterns, or traffic compared to baseline.`;

  return {
    question,
    service: serviceName,
    knownSignals: signals,
    earliest: range,
    latest: 'now',
  };
}

/** Parse a relative-time like "-1h" into ms duration, for rate normalization. */
function relativeTimeMs(rel: string): number {
  const m = rel.match(/^-(\d+)([smhd])$/);
  if (!m) return 3600_000;
  const n = Number(m[1]);
  const unit = m[2] as 's' | 'm' | 'h' | 'd';
  return n * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit];
}

export default function ServiceDetailPage() {
  const { serviceName = '' } = useParams();
  const navigate = useNavigate();
  const [range, setRange] = useRangeParam(DEFAULT_RANGE);
  const [summary, setSummary] = useState<ServiceSummary | null>(null);
  const [prevSummary, setPrevSummary] = useState<ServiceSummary | null>(null);
  const [buckets, setBuckets] = useState<ServiceBucket[]>([]);
  const [operations, setOperations] = useState<OperationSummary[]>([]);
  const [opSort, setOpSort] = useState<{
    key: 'operation' | 'requests' | 'errorRate' | 'p50Us' | 'p95Us' | 'p99Us';
    dir: 'asc' | 'desc';
  }>({ key: 'requests', dir: 'desc' });
  const [errorTraces, setErrorTraces] = useState<TraceBrief[]>([]);
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [edges, setEdges] = useState<DependencyEdge[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingBuckets, setLoadingBuckets] = useState(true);
  const [loadingOps, setLoadingOps] = useState(true);
  const [loadingErrors, setLoadingErrors] = useState(true);
  const [loadingInstances, setLoadingInstances] = useState(true);
  const [loadingDeps, setLoadingDeps] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [alertStatus, setAlertStatus] = useState<string>('ok');
  const [alertHistory, setAlertHistory] = useState<Array<{ time: number; eventType: string; signalType: string; detail: string }>>([]);
  // Trigger a re-fetch when the Settings stream-filter toggle changes,
  // so the Recent errors panel doesn't keep stale server-filtered data.
  const streamFilterEnabled = useStreamFilterEnabled();
  // Catalog of metrics this service emits (by name). Used by the
  // Protocol / Runtime / Infrastructure cards to hide sections the
  // service doesn't actually have data for, and to pick between old
  // and new semconv metric names.
  const [serviceMetricSet, setServiceMetricSet] = useState<
    Set<string> | undefined
  >(undefined);
  // Pre-fetched series data for every metric the cards might show,
  // loaded in a single batched query (instead of one query per row,
  // which saturated the Cribl search worker pool and queued page
  // loads for 30+ seconds).
  const [cardSeriesByMetric, setCardSeriesByMetric] = useState<
    Map<string, Array<{ t: number; v: number }>> | undefined
  >(undefined);

  const fetchAll = useCallback(async () => {
    setError(null);
    setNotFound(false);
    setLoadingSummary(true);
    setLoadingBuckets(true);
    setLoadingOps(true);
    setLoadingErrors(true);
    setLoadingInstances(true);
    setLoadingDeps(true);
    const binSeconds = binSecondsFor(range);

    // Previous-window summary for delta chips. Always live because
    // the previous window changes with every range pick and isn't
    // part of the cacheable set. Non-fatal on error.
    const prev = previousWindow(range);
    listServiceSummaries(prev.earliest, prev.latest, serviceName)
      .then((all) => setPrevSummary(all.find((x) => x.service === serviceName) ?? null))
      .catch(() => setPrevSummary(null));

    // Cache-fast path: when the user is on the default -1h range
    // with the stream filter enabled, read all five ServiceDetail
    // panels from $vt_results in one batched query. The cached
    // scheduled searches run every 5 minutes and contain per-service
    // data — the reader filters client-side to `serviceName`.
    // Any cache miss falls through to the live query fan-out below.
    if (range === '-1h' && streamFilterEnabled) {
      try {
        const cached = await listCachedSvcDetailPanels(serviceName);
        if (cached.summary && cached.buckets && cached.operations) {
          setSummary(cached.summary);
          setNotFound(false);
          setLoadingSummary(false);
          setBuckets(cached.buckets);
          setLoadingBuckets(false);
          setOperations(cached.operations);
          setLoadingOps(false);
          if (cached.dependencies) {
            setEdges(cached.dependencies);
            setLoadingDeps(false);
          } else {
            void getDependencies(range, 'now')
              .then((e) => setEdges(e))
              .catch(() => setEdges([]))
              .finally(() => setLoadingDeps(false));
          }
          if (cached.recentErrors && cached.recentErrors.length > 0) {
            setErrorTraces(cached.recentErrors);
            setLoadingErrors(false);
          } else {
            // Tighten the fallback to -15m instead of the full range.
            // The cache miss means the 5-min scheduled search hasn't
            // caught the recent errors yet; scanning the full -1h
            // range is expensive and the errors we want are recent.
            void listRecentErrorTraces(serviceName, '-15m', 'now')
              .then((et) => setErrorTraces(et))
              .catch(() => setErrorTraces([]))
              .finally(() => setLoadingErrors(false));
          }
          // Instances aren't cached — always live.
          void listServiceInstances(serviceName, range, 'now')
            .then((inst) => setInstances(inst))
            .catch(() => setInstances([]))
            .finally(() => setLoadingInstances(false));
          return;
        }
      } catch {
        // Cache read failed — fall through to live.
      }
    }

    // Live query fan-out — either the user picked a non-default
    // range, or the cache came back empty.
    listServiceSummaries(range, 'now', serviceName)
      .then((all) => {
        const mine = all.find((x) => x.service === serviceName);
        setSummary(mine ?? null);
        setNotFound(!mine);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoadingSummary(false));

    getServiceTimeSeries(binSeconds, serviceName, range, 'now')
      .then((rows) => setBuckets(rows))
      .catch(() => setBuckets([]))
      .finally(() => setLoadingBuckets(false));

    listOperationSummaries(serviceName, range, 'now')
      .then((ops) => setOperations(ops))
      .catch(() => setOperations([]))
      .finally(() => setLoadingOps(false));

    listRecentErrorTraces(serviceName, range, 'now')
      .then((et) => setErrorTraces(et))
      .catch(() => setErrorTraces([]))
      .finally(() => setLoadingErrors(false));

    getDependencies(range, 'now')
      .then((e) => setEdges(e))
      .catch(() => setEdges([]))
      .finally(() => setLoadingDeps(false));

    listServiceInstances(serviceName, range, 'now')
      .then((inst) => setInstances(inst))
      .catch(() => setInstances([]))
      .finally(() => setLoadingInstances(false));

    // Alert status from the evaluator's $vt_results
    const svcEsc = serviceName.replace(/"/g, '\\"');
    runQuery(
      `dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "${svcEsc}" | project alert_status, signal_type`,
      '-1h', 'now', 1,
    )
      .then((rows) => {
        if (rows.length > 0) setAlertStatus(String(rows[0].alert_status ?? 'ok'));
      })
      .catch(() => {});

    // Alert history from the otel dataset
    runQuery(
      `dataset="otel" | where data_datatype == "criblapm_alert" and svc == "${svcEsc}" | project _time, event_type, signal_type, curr_error_rate, prev_error_rate | sort by _time desc | limit 20`,
      '-7d', 'now', 20,
    )
      .then((rows) => {
        setAlertHistory(rows.map((r) => ({
          time: Number(r._time) * 1000,
          eventType: String(r.event_type ?? ''),
          signalType: String(r.signal_type ?? ''),
          detail: r.curr_error_rate != null
            ? `Error rate ${(Number(r.curr_error_rate) * 100).toFixed(1)}% (was ${(Number(r.prev_error_rate ?? 0) * 100).toFixed(1)}%)`
            : '',
        })));
      })
      .catch(() => {});
  }, [range, serviceName, streamFilterEnabled]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Metric cards fire TWO queries in parallel: the catalog (which
  // tells us which rows to render) and a single batched series
  // fetch for every candidate metric (which feeds all sparklines).
  // The batch query over-fetches a bit — it asks for metrics that
  // may not exist for this service — but running both round trips
  // concurrently cuts Service Detail load time meaningfully, and
  // `_metric in (...)` is an indexed filter in Cribl so the over-
  // fetch costs little. Client-side, we filter the resulting Map
  // down to metrics that are also in the catalog.
  useEffect(() => {
    if (!serviceName) return;
    let cancelled = false;
    setServiceMetricSet(undefined);
    setCardSeriesByMetric(undefined);
    const binSeconds = binSecondsFor(range);
    Promise.all([
      listServiceMetricNames(serviceName, range, 'now').catch(() => [] as string[]),
      getServiceMetricsBatch(
        serviceName,
        ALL_CARD_METRICS,
        binSeconds,
        range,
        'now',
      ).catch(() => new Map<string, Array<{ t: number; v: number }>>()),
    ]).then(([list, map]) => {
      if (cancelled) return;
      setServiceMetricSet(new Set(list));
      setCardSeriesByMetric(map);
    });
    return () => {
      cancelled = true;
    };
  }, [serviceName, range]);

  const color = serviceColor(serviceName);
  const rangeMinutes = relativeTimeMs(range) / 60_000;

  // ─────────────────────────────────────────────────────────────
  // Metrics card row configs (P2 / P3 / P4)
  //
  // Each card is declarative — the config lists every candidate
  // metric the card might show. The MetricsCard component hides
  // rows whose metrics don't exist in serviceMetricSet, so one
  // config works across different runtimes and deployment targets.
  //
  // Formatters duplicate a little logic from MetricsPage's unit
  // inference to keep this file self-contained. They could be
  // lifted into utils/metrics if more callers need them.
  // ─────────────────────────────────────────────────────────────

  const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`);
  const fmtBytes = (v: number) => {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
    return `${v.toFixed(0)} B`;
  };
  const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const fmtInt = (v: number) => v.toFixed(0);

  /**
   * P2: downstream dependency latencies. Picks up the OTel semconv
   * HTTP / gRPC / DB client histograms emitted by instrumentation
   * libraries. Old and new semconv names are grouped into one row
   * (first match wins). A service only shows the subset of
   * protocols it actually talks — e.g., a service with only RPC
   * downstream shows one row, while a service with HTTP + DB shows
   * two.
   */
  const protocolRows: MetricsCardRow[] = [
    {
      label: 'HTTP client p95',
      metric: ['http.client.request.duration', 'http.client.duration'],
      fetch: 'latest',
      agg: 'p95',
      format: fmtMs,
    },
    {
      label: 'HTTP server p95',
      metric: ['http.server.request.duration', 'http.server.duration'],
      fetch: 'latest',
      agg: 'p95',
      format: fmtMs,
    },
    {
      label: 'gRPC client p95',
      metric: 'rpc.client.duration',
      fetch: 'latest',
      agg: 'p95',
      format: fmtMs,
    },
    {
      label: 'gRPC server p95',
      metric: 'rpc.server.duration',
      fetch: 'latest',
      agg: 'p95',
      format: fmtMs,
    },
    {
      label: 'DB query p95',
      metric: 'db.client.operation.duration',
      fetch: 'latest',
      agg: 'p95',
      format: fmtMs,
    },
    {
      label: 'DB connections',
      metric: 'db.client.connection.count',
      fetch: 'latest',
      agg: 'max',
      format: fmtInt,
      noSparkline: true,
    },
  ];

  /**
   * P3: runtime health. JVM, Python (cpython), and generic process
   * metrics all coexist in one config — the card picks whichever
   * the service actually emits. Services running on the Node SDK
   * wouldn't emit any of these, and the card would hide itself.
   */
  const runtimeRows: MetricsCardRow[] = [
    // JVM
    {
      label: 'JVM memory used',
      metric: 'jvm.memory.used',
      fetch: 'latest',
      agg: 'max',
      format: fmtBytes,
    },
    {
      label: 'JVM GC duration p95',
      metric: 'jvm.gc.duration',
      fetch: 'latest',
      agg: 'p95',
      format: fmtMs,
    },
    {
      label: 'JVM threads',
      metric: 'jvm.thread.count',
      fetch: 'latest',
      agg: 'max',
      format: fmtInt,
    },
    {
      label: 'JVM CPU',
      metric: 'jvm.cpu.recent_utilization',
      fetch: 'latest',
      agg: 'max',
      format: fmtPct,
      warn: (v) => v > 0.8,
    },
    // Python cpython runtime
    {
      label: 'Python memory',
      metric: 'process.runtime.cpython.memory',
      fetch: 'latest',
      agg: 'max',
      format: fmtBytes,
    },
    {
      label: 'Python CPU',
      metric: 'process.runtime.cpython.cpu.utilization',
      fetch: 'latest',
      agg: 'max',
      format: fmtPct,
      warn: (v) => v > 0.8,
    },
    {
      label: 'Python GC cycles',
      metric: 'process.runtime.cpython.gc_count',
      fetch: 'delta',
      agg: 'max',
      format: fmtInt,
    },
    {
      label: 'Python threads',
      metric: 'process.runtime.cpython.thread_count',
      fetch: 'latest',
      agg: 'max',
      format: fmtInt,
    },
    // Generic process (covers Go / Node / anything that sets these)
    {
      label: 'Process CPU',
      metric: 'process.cpu.utilization',
      fetch: 'latest',
      agg: 'max',
      format: fmtPct,
      warn: (v) => v > 0.8,
    },
    {
      label: 'Process memory',
      metric: 'process.memory.usage',
      fetch: 'latest',
      agg: 'max',
      format: fmtBytes,
    },
  ];

  /**
   * P4: k8s / host infrastructure context. Only appears when the
   * k8s cluster receiver or host metrics are feeding the dataset.
   * Restarts fetch the delta in the window — the lifetime count is
   * misleading; what matters is "did this number change". Memory
   * limits/requests are gauges so we show the latest value.
   */
  const infraRows: MetricsCardRow[] = [
    {
      label: 'Restarts in window',
      metric: 'k8s.container.restarts',
      fetch: 'delta',
      agg: 'max',
      format: fmtInt,
      warn: (v) => v > 0,
      noSparkline: true,
    },
    {
      label: 'Container ready',
      metric: 'k8s.container.ready',
      fetch: 'latest',
      agg: 'avg',
      format: (v) => (v >= 1 ? 'yes' : 'no'),
      warn: (v) => v < 1,
      noSparkline: true,
    },
    {
      label: 'Pod phase',
      metric: 'k8s.pod.phase',
      fetch: 'latest',
      agg: 'max',
      // OTel k8s pod phase values: 1=pending, 2=running, 3=succeeded,
      // 4=failed, 5=unknown. Treat anything other than running as warn.
      format: (v) => {
        if (v === 2) return 'running';
        if (v === 1) return 'pending';
        if (v === 4) return 'failed';
        if (v === 3) return 'succeeded';
        if (v === 5) return 'unknown';
        return String(v);
      },
      warn: (v) => v !== 2,
      noSparkline: true,
    },
    {
      label: 'Memory limit',
      metric: 'k8s.container.memory_limit',
      fetch: 'latest',
      agg: 'max',
      format: fmtBytes,
      noSparkline: true,
    },
    {
      label: 'Memory request',
      metric: 'k8s.container.memory_request',
      fetch: 'latest',
      agg: 'max',
      format: fmtBytes,
      noSparkline: true,
    },
    {
      label: 'CPU limit',
      metric: 'k8s.container.cpu_limit',
      fetch: 'latest',
      agg: 'max',
      format: (v) => `${v.toFixed(2)} cores`,
      noSparkline: true,
    },
  ];

  // Prepare chart series from buckets
  const chartSeries = useMemo(() => {
    const sorted = [...buckets].sort((a, b) => a.bucketMs - b.bucketMs);
    const binMs = binSecondsFor(range) * 1000;
    const ratePoints = sorted.map((b) => ({
      t: b.bucketMs,
      // Express as req/min regardless of bin width for a stable y-axis unit
      v: (b.requests * 60_000) / binMs,
    }));
    const errorPoints = sorted.map((b) => ({
      t: b.bucketMs,
      v: b.requests > 0 ? (b.errors / b.requests) * 100 : 0,
    }));
    const p50Points = sorted.map((b) => ({ t: b.bucketMs, v: b.p50Us }));
    const p95Points = sorted.map((b) => ({ t: b.bucketMs, v: b.p95Us }));
    const p99Points = sorted.map((b) => ({ t: b.bucketMs, v: b.p99Us }));
    return { ratePoints, errorPoints, p50Points, p95Points, p99Points };
  }, [buckets, range]);

  const rateSeries: LineSeries[] = [
    {
      name: 'Requests/min',
      color,
      data: chartSeries.ratePoints,
      format: (v) => fmtRate(v),
    },
  ];
  const errorsSeries: LineSeries[] = [
    {
      name: 'Error rate',
      color: 'var(--cds-color-danger)',
      data: chartSeries.errorPoints,
      format: (v) => `${v.toFixed(2)}%`,
    },
  ];
  const durSeries: LineSeries[] = [
    {
      name: 'p50',
      color: '#60a5fa',
      data: chartSeries.p50Points,
      format: fmtUs,
    },
    {
      name: 'p95',
      color: '#f59e0b',
      data: chartSeries.p95Points,
      format: fmtUs,
    },
    {
      name: 'p99',
      color: '#ef4444',
      data: chartSeries.p99Points,
      format: fmtUs,
    },
  ];

  // Sort the operations table according to the user's click state.
  // Default (requests desc) preserves the prior behavior — the
  // sortable headers just *extend* the existing table with new orderings,
  // notably p95/p99 which makes imageSlowLoad-style "one slow endpoint"
  // failures easy to find.
  const sortedOperations = useMemo(() => {
    const arr = [...operations];
    const { key, dir } = opSort;
    arr.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      if (key === 'operation') {
        av = a.operation;
        bv = b.operation;
      } else {
        av = a[key] ?? 0;
        bv = b[key] ?? 0;
      }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [operations, opSort]);

  function toggleOpSort(key: typeof opSort.key) {
    setOpSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'operation' ? 'asc' : 'desc' },
    );
  }
  function opSortIndicator(key: typeof opSort.key): string {
    if (opSort.key !== key) return '';
    return opSort.dir === 'desc' ? ' ▼' : ' ▲';
  }

  // Significance-gated previous summary — used as the delta-chip baseline.
  // We drop the prev comparison when the window had too few samples; its
  // percentiles would be too noisy to flag anything meaningfully.
  const prevSig =
    prevSummary && prevSummary.requests >= MIN_PREV_SAMPLES ? prevSummary : null;

  // Derive upstream / downstream from dependencies
  const { upstream, downstream } = useMemo(() => {
    const up = edges
      .filter((e) => e.child === serviceName && e.parent !== serviceName)
      .sort((a, b) => b.callCount - a.callCount);
    const down = edges
      .filter((e) => e.parent === serviceName && e.child !== serviceName)
      .sort((a, b) => b.callCount - a.callCount);
    return { upstream: up, downstream: down };
  }, [edges, serviceName]);

  if (notFound && !loadingSummary) {
    return (
      <div className={s.page}>
        <div className={s.crumbs}>
          <Link to="/">Home</Link>
          <span className={s.crumbSep}>/</span>
          <span>{serviceName}</span>
        </div>
        <div className={s.notFound}>
          <strong>{serviceName}</strong> has no traces in this time range. Try a wider
          lookback or <Link to="/">return to Home</Link>.
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <TimeRangePicker value={range} onChange={setRange} />
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.crumbs}>
        <Link to="/">Home</Link>
        <span className={s.crumbSep}>/</span>
        <span>Service</span>
        <span className={s.crumbSep}>/</span>
        <span>{serviceName}</span>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className={s.hero} style={
        alertStatus === 'firing' ? { borderLeft: '4px solid #dc2626' } :
        alertStatus === 'pending' ? { borderLeft: '4px solid #f59e0b' } :
        alertStatus === 'resolving' ? { borderLeft: '4px solid #06b6d4' } :
        undefined
      }>
        <div className={s.heroSwatch} style={{ background: color }} />
        <div className={s.heroMain}>
          <h1 className={s.heroName}>
            {serviceName}
            {alertStatus !== 'ok' && (
              <span data-testid="alert-badge" className={s.alertBadge} style={{
                background: alertStatus === 'firing' ? 'rgba(220,38,38,0.12)' : alertStatus === 'pending' ? 'rgba(245,158,11,0.12)' : 'rgba(6,182,212,0.12)',
                color: alertStatus === 'firing' ? '#dc2626' : alertStatus === 'pending' ? '#f59e0b' : '#06b6d4',
              }}>
                {alertStatus}
              </span>
            )}
          </h1>
          <div className={s.heroSubtitle}>
            {loadingSummary
              ? 'Loading…'
              : summary
                ? `${summary.requests.toLocaleString()} requests · ${operations.length} operations · ${upstream.length} upstream / ${downstream.length} downstream`
                : 'No data'}
          </div>
        </div>
        <div className={s.heroStats}>
          <div className={s.stat}>
            <span className={s.statLabel}>Rate</span>
            <span className={s.statValue}>
              {summary ? fmtRate(summary.requests / rangeMinutes) : '—'}
              <DeltaChip
                curr={summary ? summary.requests / rangeMinutes : undefined}
                prev={prevSig ? prevSig.requests / rangeMinutes : undefined}
                mode="relNeutral"
                threshold={25}
              />
            </span>
          </div>
          <div className={s.stat}>
            <span className={s.statLabel}>Error rate</span>
            <span
              className={`${s.statValue} ${summary && summary.errorRate > 0 ? s.statValueError : ''}`}
            >
              {summary ? `${(summary.errorRate * 100).toFixed(2)}%` : '—'}
              <DeltaChip
                curr={summary?.errorRate}
                prev={prevSig?.errorRate}
                mode="points"
                threshold={0.5}
              />
            </span>
          </div>
          <div className={s.stat}>
            <span className={s.statLabel}>p95</span>
            <span className={s.statValue}>
              {summary ? fmtUs(summary.p95Us) : '—'}
              <DeltaChip
                curr={summary?.p95Us}
                prev={prevSig?.p95Us}
                mode="rel"
                threshold={30}
              />
            </span>
          </div>
          <div className={s.stat}>
            <span className={s.statLabel}>p99</span>
            <span className={s.statValue}>
              {summary ? fmtUs(summary.p99Us) : '—'}
              <DeltaChip
                curr={summary?.p99Us}
                prev={prevSig?.p99Us}
                mode="rel"
                threshold={30}
              />
            </span>
          </div>
          <TimeRangePicker value={range} onChange={setRange} />
          <InvestigateButton
            seed={buildServiceSeed(serviceName, summary, prevSig, operations, range)}
            variant="primary"
            title={`Investigate ${serviceName}`}
          />
        </div>
      </div>

      {/* RED charts */}
      <div className={s.charts}>
        <LineChart
          title="Rate"
          subtitle="Requests per minute"
          series={rateSeries}
          yFormat={(v) => (v >= 1 ? v.toFixed(0) : v.toFixed(1))}
          emptyMessage={loadingBuckets ? 'Loading…' : 'No data'}
        />
        <LineChart
          title="Errors"
          subtitle="Error rate (%)"
          series={errorsSeries}
          yFormat={(v) => `${v.toFixed(1)}%`}
          emptyMessage={loadingBuckets ? 'Loading…' : 'No data'}
        />
        <LineChart
          title="Duration"
          subtitle="Latency p50 / p95 / p99"
          series={durSeries}
          yFormat={fmtUsAxis}
          emptyMessage={loadingBuckets ? 'Loading…' : 'No data'}
        />
      </div>

      {/* Metric-backed cards: dependency latencies, runtime, infra.
          Each card hides itself entirely when the service has no
          data for any of its rows, so non-k8s services show two
          cards, services without instrumented downstream calls
          show one, and a fully-uninstrumented service shows none. */}
      <div className={s.metricCards}>
        <MetricsCard
          title="Dependency latencies"
          subtitle="p95 of outgoing calls by protocol"
          rows={protocolRows}
          service={serviceName}
          range={range}
          availableMetrics={serviceMetricSet}
          seriesByMetric={cardSeriesByMetric}
        />
        <MetricsCard
          title="Runtime health"
          subtitle="Process / VM metrics from the instrumentation SDK"
          rows={runtimeRows}
          service={serviceName}
          range={range}
          availableMetrics={serviceMetricSet}
          seriesByMetric={cardSeriesByMetric}
        />
        <MetricsCard
          title="Infrastructure"
          subtitle="Container + pod metrics from the k8s cluster receiver"
          rows={infraRows}
          service={serviceName}
          range={range}
          availableMetrics={serviceMetricSet}
          seriesByMetric={cardSeriesByMetric}
        />
      </div>

      {/* Lower grid */}
      <div className={s.grid}>
        <div className={s.opsCard}>
          <div className={s.cardHeader}>
            <span className={s.cardTitle}>
              Top operations{' '}
              {!loadingOps && (
                <span className={s.cardSubtitle}>({operations.length})</span>
              )}
            </span>
            <span className={s.cardSubtitle}>Click a row to search for matching traces</span>
          </div>
          {loadingOps ? (
            <div className={s.skeletonRows}>
              {[85, 72, 90, 65, 78, 82, 60].map((w, i) => (
                <div key={i} style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : operations.length === 0 ? (
            <div className={s.emptyState}>No operations in this range.</div>
          ) : (
            <table className={s.opsTable}>
              <thead>
                <tr>
                  <th
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleOpSort('operation')}
                  >
                    Operation{opSortIndicator('operation')}
                  </th>
                  <th
                    className={s.num}
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleOpSort('requests')}
                  >
                    Requests{opSortIndicator('requests')}
                  </th>
                  <th
                    className={s.num}
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleOpSort('errorRate')}
                  >
                    Errors{opSortIndicator('errorRate')}
                  </th>
                  <th
                    className={s.num}
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleOpSort('p50Us')}
                  >
                    p50{opSortIndicator('p50Us')}
                  </th>
                  <th
                    className={s.num}
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleOpSort('p95Us')}
                  >
                    p95{opSortIndicator('p95Us')}
                  </th>
                  <th
                    className={s.num}
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleOpSort('p99Us')}
                  >
                    p99{opSortIndicator('p99Us')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedOperations.map((op) => (
                  <tr
                    key={op.operation}
                    onClick={() =>
                      navigate(
                        `/signals/traces?service=${encodeURIComponent(serviceName)}&operation=${encodeURIComponent(op.operation)}&lookback=${range}`,
                      )
                    }
                  >
                    <td>
                      <div className={s.opName}>{op.operation}</div>
                    </td>
                    <td className={s.num}>{op.requests.toLocaleString()}</td>
                    <td className={`${s.num} ${errClass(op.errorRate)}`}>
                      {op.errorRate === 0 ? '0' : `${(op.errorRate * 100).toFixed(1)}%`}
                    </td>
                    <td className={s.num}>{fmtUs(op.p50Us)}</td>
                    <td className={s.num}>{fmtUs(op.p95Us)}</td>
                    <td className={s.num}>{fmtUs(op.p99Us)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className={s.sideCol}>
          <TraceBriefList
            title="Recent errors"
            subtitle={`Error traces touching ${serviceName}`}
            traces={errorTraces}
            loading={loadingErrors}
            mode="errors"
            emptyMessage="No error traces in this range — all clear."
          />

          <div className={s.depsCard}>
            <div className={s.cardHeader}>
              <span className={s.cardTitle}>
                Dependencies{' '}
                {!loadingDeps && (
                  <span className={s.cardSubtitle}>
                    ({upstream.length} ↑ · {downstream.length} ↓)
                  </span>
                )}
              </span>
            </div>
            {loadingDeps ? (
              <div className={s.skeletonRows}>
                {[75, 60, 80, 55].map((w, i) => (
                  <div key={i} style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : upstream.length + downstream.length === 0 ? (
              <div className={s.depsEmpty}>No edges involving {serviceName}.</div>
            ) : (
              <>
                {upstream.length > 0 && (
                  <div>
                    <div
                      style={{
                        padding: '6px 16px',
                        fontSize: '11px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.4px',
                        color: 'var(--cds-color-fg-muted)',
                        background: 'var(--cds-color-bg-subtle)',
                      }}
                    >
                      Upstream ({upstream.length})
                    </div>
                    <ul className={s.depsList}>
                      {upstream.map((e) => (
                        <li key={`up-${e.parent}`}>
                          <Link
                            to={`/service/${encodeURIComponent(e.parent)}`}
                            className={s.depsItem}
                          >
                            <div className={s.depsLeft}>
                              <span
                                className={s.depsSvcDot}
                                style={{ background: serviceColor(e.parent) }}
                              />
                              <span className={s.depsSvc}>{e.parent}</span>
                            </div>
                            <span className={s.depsCount}>
                              {e.callCount.toLocaleString()} calls
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {downstream.length > 0 && (
                  <div>
                    <div
                      style={{
                        padding: '6px 16px',
                        fontSize: '11px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.4px',
                        color: 'var(--cds-color-fg-muted)',
                        background: 'var(--cds-color-bg-subtle)',
                      }}
                    >
                      Downstream ({downstream.length})
                    </div>
                    <ul className={s.depsList}>
                      {downstream.map((e) => (
                        <li key={`down-${e.child}`}>
                          <Link
                            to={`/service/${encodeURIComponent(e.child)}`}
                            className={s.depsItem}
                          >
                            <div className={s.depsLeft}>
                              <span
                                className={s.depsSvcDot}
                                style={{ background: serviceColor(e.child) }}
                              />
                              <span className={s.depsSvc}>{e.child}</span>
                            </div>
                            <span className={s.depsCount}>
                              {e.callCount.toLocaleString()} calls
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Instances section — per-pod RED metrics */}
      <div className={s.instancesCard}>
        <div className={s.cardHeader}>
          <span className={s.cardTitle}>
            Instances{' '}
            {!loadingInstances && (
              <span className={s.cardSubtitle}>({instances.length})</span>
            )}
          </span>
          <span className={s.cardSubtitle}>
            Per-pod metrics via service.instance.id
          </span>
        </div>
        {loadingInstances ? (
          <div className={s.skeletonRows}>
            {[85, 72, 60].map((w, i) => (
              <div key={i} style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : instances.length <= 1 ? (
          <div className={s.emptyState}>
            {instances.length === 1
              ? 'Single instance — per-pod breakdown is only useful with multiple replicas.'
              : 'No instance data in this range.'}
          </div>
        ) : (
          <table className={s.opsTable}>
            <thead>
              <tr>
                <th>Instance</th>
                <th className={s.num}>Requests</th>
                <th className={s.num}>Errors</th>
                <th className={s.num}>p50</th>
                <th className={s.num}>p95</th>
                <th className={s.num}>p99</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((inst) => (
                <tr key={inst.instanceId}>
                  <td>
                    <div className={s.opName}>{inst.instanceId}</div>
                  </td>
                  <td className={s.num}>{inst.requests.toLocaleString()}</td>
                  <td className={`${s.num} ${errClass(inst.errorRate)}`}>
                    {inst.errorRate === 0
                      ? '0'
                      : `${(inst.errorRate * 100).toFixed(1)}%`}
                  </td>
                  <td className={s.num}>{fmtUs(inst.p50Us)}</td>
                  <td className={s.num}>{fmtUs(inst.p95Us)}</td>
                  <td className={s.num}>{fmtUs(inst.p99Us)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Alert history */}
      {alertHistory.length > 0 && (
        <div className={s.section}>
          <h2 className={s.sectionHeader}>Alert History</h2>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Signal</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {alertHistory.map((h, i) => (
                <tr key={i}>
                  <td>{new Date(h.time).toLocaleString()}</td>
                  <td>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      background: h.eventType === 'firing' ? 'rgba(220,38,38,0.12)' : 'rgba(16,185,129,0.12)',
                      color: h.eventType === 'firing' ? '#dc2626' : '#059669',
                    }}>
                      {h.eventType}
                    </span>
                  </td>
                  <td>{h.signalType}</td>
                  <td>{h.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
