/**
 * Metrics explorer. Modeled after Datadog's metrics browser.
 *
 * Layout: facet sidebar on the left (metric picker with search,
 * detected metric type badge, service filter, group-by dimension
 * picker, aggregation pills, lookback), main area with a metadata
 * card and a LineChart rendering one or many series.
 *
 * Semantic features:
 *  - **Type detection** — samples one record for the selected metric
 *    and classifies it as counter / gauge / histogram based on the
 *    presence of `${name}_otel.is_monotonic` and `${name}_data._buckets`
 *    fields on the record.
 *  - **Smart defaults** — the default aggregation switches with the
 *    detected type: counter→rate, histogram→p95, gauge→avg.
 *  - **Rate derivation for counters** — the server returns per-bucket
 *    `max(_value)` and the client computes Δvalue / Δtime.
 *  - **Percentiles for histograms** — p50/p75/p95/p99 via KQL's
 *    `percentile` function over the pre-aggregated `_value` column.
 *    True histogram percentiles from bucket maps are a v2 follow-up.
 *  - **Group-by dimension** — split into multi-series by any
 *    attribute the metric carries (auto-detected from the sample
 *    record). Top-N limiting keeps the chart readable when a
 *    dimension has many values.
 *
 * Known limitations (tracked in ROADMAP.md):
 *  - No exemplar drill-down to traces from histogram points
 *  - No multi-metric overlay
 *  - Histogram percentiles are percentile-of-means, not true bucket-
 *    based percentiles
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import LineChart, { type LineSeries } from '../components/LineChart';
import TimeRangePicker from '../components/TimeRangePicker';
import StatusBanner from '../components/StatusBanner';
import {
  listMetrics,
  listMetricServices,
  getMetricInfo,
  getMetricSeries,
} from '../api/search';
import { binSecondsFor } from '../components/timeRanges';
import { useRangeParam } from '../hooks/useRangeParam';
import { serviceColor } from '../utils/spans';
import type {
  MetricSummary,
  MetricSeries,
  MetricInfo,
  MetricAgg,
  MetricType,
} from '../api/types';
import s from './MetricsPage.module.css';

const DEFAULT_RANGE = '-1h';

const AGG_OPTIONS: Array<{ id: MetricAgg; label: string; group: 'basic' | 'pct' | 'rate' }> = [
  { id: 'avg', label: 'avg', group: 'basic' },
  { id: 'sum', label: 'sum', group: 'basic' },
  { id: 'min', label: 'min', group: 'basic' },
  { id: 'max', label: 'max', group: 'basic' },
  { id: 'count', label: 'count', group: 'basic' },
  { id: 'p50', label: 'p50', group: 'pct' },
  { id: 'p75', label: 'p75', group: 'pct' },
  { id: 'p95', label: 'p95', group: 'pct' },
  { id: 'p99', label: 'p99', group: 'pct' },
  { id: 'rate', label: 'rate', group: 'rate' },
];

/** Default aggregation per detected metric type. Counter gets rate
 * so the chart is immediately human-readable instead of showing a
 * climbing cumulative line. Histogram defaults to p95 since mean
 * hides the tail the user usually cares about. */
function defaultAggForType(type: MetricType): MetricAgg {
  switch (type) {
    case 'counter':
      return 'rate';
    case 'histogram':
      return 'p95';
    default:
      return 'avg';
  }
}

/** Label shown in the type badge. */
function typeLabel(type: MetricType): string {
  switch (type) {
    case 'counter':
      return 'COUNTER';
    case 'gauge':
      return 'GAUGE';
    case 'histogram':
      return 'HISTOGRAM';
    default:
      return 'METRIC';
  }
}

/** Light unit inference from the metric name — powers the y-axis
 * formatter. Prefers explicit OTel semconv suffixes. */
function formatMetricValue(metric: string, agg: MetricAgg, v: number): string {
  if (!Number.isFinite(v)) return '—';
  const lower = metric.toLowerCase();
  const isBytes =
    lower.endsWith('_bytes') ||
    lower.endsWith('.bytes') ||
    lower.includes('memory') ||
    lower.includes('.disk.') ||
    lower.includes('heap_alloc');
  const isTime =
    lower.endsWith('_seconds') ||
    lower.includes('.time') ||
    lower.includes('.duration');

  // Rate of a byte counter → bytes/sec. Rate of a time counter →
  // dimensionless (seconds of time per second = unitless).
  if (agg === 'rate') {
    if (isBytes) {
      if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)} GB/s`;
      if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)} MB/s`;
      if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)} KB/s`;
      return `${v.toFixed(0)} B/s`;
    }
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k/s`;
    return `${v.toFixed(v < 10 ? 2 : 0)}/s`;
  }

  if (isBytes) {
    if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)} GB`;
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
    return `${v.toFixed(0)} B`;
  }
  if (isTime) {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} s`;
    return `${v.toFixed(1)} ms`;
  }
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(v < 10 ? 2 : 0);
}

/** How many groups to plot at most when group-by creates many
 * series. Beyond this they get truncated (sorted by most recent
 * value descending so the tallest lines survive). Matches Datadog's
 * default top-8 limit for "legend too busy". */
const TOP_N_GROUPS = 8;

export default function MetricsPage() {
  const [range, setRange] = useRangeParam(DEFAULT_RANGE);
  const [metrics, setMetrics] = useState<MetricSummary[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [info, setInfo] = useState<MetricInfo | null>(null);
  const [services, setServices] = useState<string[]>([]);
  const [service, setService] = useState<string>('');
  const [groupBy, setGroupBy] = useState<string>('');
  const [agg, setAgg] = useState<MetricAgg>('avg');
  /** Tracks whether the user has manually chosen an agg in the
   * current metric session. If true, we stop auto-setting the default
   * based on metric type — respects user intent. Reset on metric change. */
  const [userPickedAgg, setUserPickedAgg] = useState(false);
  const [series, setSeries] = useState<MetricSeries | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  // Populate the metric catalog whenever the range changes.
  useEffect(() => {
    let cancelled = false;
    setMetricsLoading(true);
    setMetricsError(null);
    listMetrics(range, 'now')
      .then((list) => {
        if (cancelled) return;
        setMetrics(list);
        if (list.length > 0 && !selected) {
          setSelected(list[0].name);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setMetricsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setMetricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // Services + info load when the selected metric changes.
  // Resets per-metric UI state: group-by, info, user-agg flag.
  useEffect(() => {
    if (!selected) {
      setServices([]);
      setInfo(null);
      return;
    }
    let cancelled = false;
    setGroupBy('');
    setUserPickedAgg(false);
    setInfo(null);

    void listMetricServices(selected, range, 'now')
      .then((list) => {
        if (cancelled) return;
        setServices(list);
        if (service && !list.includes(service)) setService('');
      })
      .catch(() => {
        if (!cancelled) setServices([]);
      });

    void getMetricInfo(selected, range, 'now')
      .then((metricInfo) => {
        if (cancelled) return;
        setInfo(metricInfo);
        // Smart default: set agg based on detected type, unless
        // the user has already manually chosen one for this metric.
        setAgg((cur) => {
          if (userPickedAgg) return cur;
          return defaultAggForType(metricInfo.type);
        });
      })
      .catch(() => {
        if (!cancelled) setInfo({ name: selected, type: 'unknown', dimensions: [] });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, range]);

  // Fetch chart data when any axis input changes.
  const fetchSeries = useCallback(async () => {
    if (!selected) {
      setSeries(null);
      return;
    }
    setChartLoading(true);
    setChartError(null);
    try {
      const result = await getMetricSeries(
        {
          metric: selected,
          service: service || undefined,
          binSeconds: binSecondsFor(range),
          agg,
          groupBy: groupBy || undefined,
        },
        range,
        'now',
      );
      setSeries(result);
    } catch (err) {
      setChartError(err instanceof Error ? err.message : String(err));
      setSeries(null);
    } finally {
      setChartLoading(false);
    }
  }, [selected, service, agg, groupBy, range]);

  useEffect(() => {
    void fetchSeries();
  }, [fetchSeries]);

  // Fuzzy search: matches if all query chars appear in order in the
  // metric name (subsequence match). Scores by how compact the match
  // is — tighter matches rank higher. Falls back to substring match
  // for single-word queries.
  const filteredMetrics = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return [...metrics].sort((a, b) => a.name.localeCompare(b.name));

    type Scored = MetricSummary & { score: number };
    const results: Scored[] = [];
    for (const m of metrics) {
      const name = m.name.toLowerCase();
      // Exact substring match scores highest
      const subIdx = name.indexOf(q);
      if (subIdx >= 0) {
        results.push({ ...m, score: 1000 - subIdx });
        continue;
      }
      // Subsequence match: all query chars appear in order
      let qi = 0;
      for (let ni = 0; ni < name.length && qi < q.length; ni++) {
        if (name[ni] === q[qi]) qi++;
      }
      if (qi === q.length) {
        results.push({ ...m, score: 500 - q.length });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }, [metrics, filter]);

  // Group metrics by prefix for the picker. Split on first '.' or '_'.
  const groupedMetrics = useMemo(() => {
    const groups = new Map<string, MetricSummary[]>();
    for (const m of filteredMetrics) {
      const dotIdx = m.name.indexOf('.');
      const uscIdx = m.name.indexOf('_');
      let sep = -1;
      if (dotIdx >= 0 && uscIdx >= 0) sep = Math.min(dotIdx, uscIdx);
      else if (dotIdx >= 0) sep = dotIdx;
      else if (uscIdx >= 0) sep = uscIdx;
      const prefix = sep > 0 ? m.name.slice(0, sep) : '(other)';
      let list = groups.get(prefix);
      if (!list) { list = []; groups.set(prefix, list); }
      list.push(m);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredMetrics]);

  // Build LineChart series from the (possibly multi-group) result.
  // When there's group-by, apply top-N limiting by most recent value
  // so the legend stays useful. When there's no group-by, render a
  // single-colored line. Colors derive from serviceColor() which
  // gives consistent identity coloring when group-by is service.name.
  const chartSeries: LineSeries[] = useMemo(() => {
    if (!series || series.groups.length === 0) return [];

    const valueFmt = (v: number) => formatMetricValue(selected, agg, v);

    if (!series.groupBy || series.groups.length === 1) {
      // Single series
      const g = series.groups[0];
      return [
        {
          name: `${agg}(${selected})${service ? ` · ${service}` : ''}`,
          color: 'var(--cds-color-accent)',
          data: g.points,
          format: valueFmt,
        },
      ];
    }

    // Multi-series: rank by most recent value descending, take top N.
    const ranked = [...series.groups].sort((a, b) => {
      const aLast = a.points[a.points.length - 1]?.v ?? 0;
      const bLast = b.points[b.points.length - 1]?.v ?? 0;
      return bLast - aLast;
    });
    const top = ranked.slice(0, TOP_N_GROUPS);
    return top.map((g) => ({
      name: g.key || '(empty)',
      color: serviceColor(g.key || 'other'),
      data: g.points,
      format: valueFmt,
    }));
  }, [series, agg, selected, service]);

  const selectedSummary = metrics.find((m) => m.name === selected);
  const detectedType: MetricType = info?.type ?? 'unknown';
  const availableDimensions = info?.dimensions ?? [];
  const hiddenGroupCount =
    series && series.groupBy && series.groups.length > TOP_N_GROUPS
      ? series.groups.length - TOP_N_GROUPS
      : 0;

  function pickAgg(next: MetricAgg) {
    setUserPickedAgg(true);
    setAgg(next);
  }

  return (
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <div className={s.panel}>
          <div className={s.panelHeader}>
            <span className={s.panelTitle}>Filters</span>
            <span className={s.panelHint}>
              {metricsLoading
                ? 'loading…'
                : `${metrics.length} metric${metrics.length === 1 ? '' : 's'}`}
            </span>
          </div>

          <div className={s.field}>
            <span className={s.fieldLabel}>Metric</span>
            <input
              type="text"
              className={s.input}
              placeholder="filter metric names…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className={s.metricList}>
              {metricsLoading && (
                <div className={s.metricHint}>Loading metrics…</div>
              )}
              {!metricsLoading && filteredMetrics.length === 0 && (
                <div className={s.metricHint}>No metrics match.</div>
              )}
              {groupedMetrics.map(([prefix, items]) => (
                <div key={prefix}>
                  <div className={s.metricGroupHeader}>{prefix}</div>
                  {items.map((m) => (
                    <button
                      key={m.name}
                      type="button"
                      className={`${s.metricItem} ${selected === m.name ? s.metricItemActive : ''}`}
                      onClick={() => setSelected(m.name)}
                      title={`${m.samples.toLocaleString()} samples · ${m.services} service${m.services === 1 ? '' : 's'}`}
                    >
                      <span className={s.metricName}>{m.name}</span>
                      {m.type && m.type !== 'unknown' && (
                        <span className={`${s.metricTypeBadge} ${s['mtype_' + m.type]}`}>
                          {m.type === 'counter' ? 'C' : m.type === 'gauge' ? 'G' : 'H'}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <label className={s.field}>
            <span className={s.fieldLabel}>Service</span>
            <select
              className={s.select}
              value={service}
              onChange={(e) => setService(e.target.value)}
              disabled={!selected || services.length === 0}
            >
              <option value="">
                {services.length === 0 && selected
                  ? 'Host-level metric (no service)'
                  : 'All services'}
              </option>
              {services.map((svc) => (
                <option key={svc} value={svc}>
                  {svc}
                </option>
              ))}
            </select>
          </label>

          <label className={s.field}>
            <span className={s.fieldLabel}>Group by</span>
            <select
              className={s.select}
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              disabled={!selected || availableDimensions.length === 0}
            >
              <option value="">(none)</option>
              {availableDimensions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <div className={s.field}>
            <span className={s.fieldLabel}>Aggregation</span>
            <div className={s.aggGroup}>
              {AGG_OPTIONS.filter((o) => o.group !== 'rate').map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`${s.aggBtn} ${agg === o.id ? s.aggBtnActive : ''}`}
                  onClick={() => pickAgg(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {/* Rate is separated since it's only meaningful for counters. */}
            <button
              type="button"
              className={`${s.aggBtn} ${s.rateBtn} ${agg === 'rate' ? s.aggBtnActive : ''}`}
              onClick={() => pickAgg('rate')}
              title="Per-second rate — best for cumulative counters"
            >
              rate (Δ/s)
            </button>
          </div>

          <label className={s.field}>
            <span className={s.fieldLabel}>Lookback</span>
            <TimeRangePicker value={range} onChange={setRange} />
          </label>
        </div>
      </aside>

      <main className={s.results}>
        <div className={s.hero}>
          <div>
            <h1 className={s.heroTitle}>Metrics</h1>
            <div className={s.heroSubtitle}>
              OTel metric explorer backed by the <code>otel</code> dataset.
            </div>
          </div>
        </div>

        {metricsError && <StatusBanner kind="error">{metricsError}</StatusBanner>}
        {chartError && <StatusBanner kind="error">{chartError}</StatusBanner>}

        {selected && (
          <div className={s.metricHeader}>
            <div className={s.metricHeaderTop}>
              <span
                className={`${s.typeBadge} ${s['type_' + detectedType]}`}
                title={`Detected metric type: ${detectedType}`}
              >
                {typeLabel(detectedType)}
              </span>
              <div className={s.metricTitle}>{selected}</div>
            </div>
            {selectedSummary && (
              <div className={s.metricMeta}>
                {selectedSummary.samples.toLocaleString()} samples ·{' '}
                {selectedSummary.services} service
                {selectedSummary.services === 1 ? '' : 's'} · agg ={' '}
                <strong>{agg}</strong>
                {service && (
                  <>
                    {' '}
                    · filtered to <strong>{service}</strong>
                  </>
                )}
                {groupBy && (
                  <>
                    {' '}
                    · grouped by <strong>{groupBy}</strong>
                  </>
                )}
                {availableDimensions.length > 0 && !groupBy && (
                  <>
                    {' '}
                    · {availableDimensions.length} dimension
                    {availableDimensions.length === 1 ? '' : 's'} available
                  </>
                )}
              </div>
            )}
            {hiddenGroupCount > 0 && (
              <div className={s.metricMetaWarn}>
                Showing top {TOP_N_GROUPS} of {series!.groups.length} groups by most
                recent value · {hiddenGroupCount} truncated
              </div>
            )}
          </div>
        )}

        {selected && (
          <LineChart
            title={selected}
            subtitle={`${agg}${service ? ` · ${service}` : ''}${groupBy ? ` · by ${groupBy}` : ''}`}
            series={chartSeries}
            yFormat={(v) => formatMetricValue(selected, agg, v)}
            emptyMessage={
              chartLoading
                ? 'Loading…'
                : chartError
                  ? 'Query failed'
                  : 'No data for this metric in the selected range.'
            }
          />
        )}

        {!selected && !metricsLoading && (
          <StatusBanner kind="info">
            Pick a metric from the sidebar to chart it.
          </StatusBanner>
        )}
      </main>
    </div>
  );
}
