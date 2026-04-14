/**
 * Reusable card used by the Service Detail Protocol / Runtime /
 * Infrastructure sections. Config-driven: the caller passes a list
 * of metric rows, each row specifies a label, one or more candidate
 * metric names (first-match wins to handle old/new semconv
 * variants), an aggregation, and an optional unit formatter. The
 * card auto-fetches the latest value and a sparkline for each row,
 * hides rows whose metrics don't exist for the current service, and
 * hides itself entirely if no rows survive detection.
 *
 * The filter-before-render pattern is what lets one card work for
 * a Python service, a JVM service, and a Node service — the
 * Runtime card lists jvm.*, process.runtime.cpython.*, and
 * process.runtime.go.* rows, and each service only shows the
 * subset it emits.
 */
import { useEffect, useMemo, useState } from 'react';
import Sparkline from './Sparkline';
import { getServiceMetricDelta } from '../api/search';
import s from './MetricsCard.module.css';

/** One row in a metrics card. */
export interface MetricsCardRow {
  /** Human label shown on the left. */
  label: string;
  /**
   * One or more candidate metric names. The first one that has data
   * wins — this is how we support old vs new OTel semconv variants
   * like `http.client.duration` (old) vs `http.client.request.duration`
   * (new) without the caller having to know which one a given
   * service's instrumentation emits.
   */
  metric: string | string[];
  /** How to fetch the current value. */
  fetch?: 'latest' | 'delta';
  /** Aggregation for the sparkline time series. */
  agg?: 'avg' | 'max' | 'p95';
  /** Format the scalar for display. Receives the raw metric value. */
  format?: (v: number) => string;
  /** Show this row as a warning (red) when the value is above/below a threshold. */
  warn?: (v: number) => boolean;
  /** Hide the sparkline on this row — used for stats that don't vary meaningfully. */
  noSparkline?: boolean;
}

interface Props {
  /** Title shown at the top of the card. */
  title: string;
  /** Short subtitle / hint. */
  subtitle?: string;
  /** Candidate rows. Each is conditionally rendered based on data. */
  rows: MetricsCardRow[];
  /** Scoped to this service. */
  service: string;
  /** Time range, shared with the rest of the Service Detail page. */
  range: string;
  /**
   * Pre-fetched list of metric names that exist for this service,
   * or `undefined` while still loading. When undefined, the card
   * renders its skeleton state. When a Set, rows whose candidate
   * metrics aren't present are filtered out (and if zero rows
   * survive, the card hides itself).
   */
  availableMetrics?: Set<string>;
  /**
   * Pre-fetched series data for all metrics the card might show,
   * or `undefined` while still loading. The Service Detail page
   * loads this in a single batched query and passes the same Map
   * to every card so all three cards share one round trip.
   */
  seriesByMetric?: Map<string, Array<{ t: number; v: number }>>;
}

interface RowData {
  row: MetricsCardRow;
  /** Which candidate metric name resolved for this row. */
  resolvedMetric: string;
  value: number | undefined;
  series: Array<{ t: number; v: number }>;
  loading: boolean;
}

/** Short number formatter — used by default when a row doesn't pass
 * its own format function. */
function defaultFormat(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(v < 10 ? 2 : 0);
}

export default function MetricsCard({
  title,
  subtitle,
  rows,
  service,
  range,
  availableMetrics,
  seriesByMetric,
}: Props) {
  // Resolve each row's metric to the first candidate that exists for
  // this service (if we have the catalog). Rows whose metric isn't
  // available are dropped up front.
  const resolvedRows = useMemo(() => {
    return rows
      .map((row) => {
        const candidates = Array.isArray(row.metric) ? row.metric : [row.metric];
        const resolved = availableMetrics
          ? candidates.find((name) => availableMetrics.has(name))
          : candidates[0];
        return resolved ? { row, resolvedMetric: resolved } : null;
      })
      .filter((x): x is { row: MetricsCardRow; resolvedMetric: string } => x !== null);
  }, [rows, availableMetrics]);

  const [rowData, setRowData] = useState<RowData[]>([]);

  useEffect(() => {
    if (!service || resolvedRows.length === 0) {
      setRowData([]);
      return;
    }
    let cancelled = false;

    // Seed latest-kind rows from the batched series map immediately
    // (no extra round trip); `delta` rows still need their own
    // delta query. `seriesByMetric` might be undefined on the first
    // render before the page-level batch fetch resolves — in that
    // case rows stay in a loading state.
    const latestRows: RowData[] = resolvedRows.map(({ row, resolvedMetric }) => {
      const fetchKind = row.fetch ?? 'latest';
      if (fetchKind === 'delta') {
        return {
          row,
          resolvedMetric,
          value: undefined,
          series: [],
          loading: true,
        };
      }
      const series = seriesByMetric?.get(resolvedMetric) ?? [];
      const last = series.length > 0 ? series[series.length - 1].v : undefined;
      return {
        row,
        resolvedMetric,
        value: last,
        series: row.noSparkline ? [] : series,
        loading: !seriesByMetric,
      };
    });
    setRowData(latestRows);

    // Fire delta queries in parallel for any delta-kind rows. These
    // are few (k8s.container.restarts, python.gc_count) and don't
    // need to be batched.
    const deltaTasks = resolvedRows
      .map(({ row, resolvedMetric }, idx) => ({ row, resolvedMetric, idx }))
      .filter(({ row }) => (row.fetch ?? 'latest') === 'delta');

    if (deltaTasks.length > 0) {
      Promise.all(
        deltaTasks.map(async ({ row, resolvedMetric, idx }) => {
          try {
            const scalar = await getServiceMetricDelta(
              service,
              resolvedMetric,
              range,
              'now',
            );
            return { idx, row, resolvedMetric, scalar };
          } catch {
            return { idx, row, resolvedMetric, scalar: 0 };
          }
        }),
      ).then((results) => {
        if (cancelled) return;
        setRowData((prev) => {
          const next = [...prev];
          for (const { idx, row, resolvedMetric, scalar } of results) {
            const series = row.noSparkline
              ? []
              : (seriesByMetric?.get(resolvedMetric) ?? []);
            next[idx] = {
              row,
              resolvedMetric,
              value: scalar,
              series,
              loading: false,
            };
          }
          return next;
        });
      });
    }

    return () => {
      cancelled = true;
    };
  }, [service, range, resolvedRows, seriesByMetric]);

  // While the catalog or the batched series data is still in
  // flight, render a skeleton that matches the opsCard style used
  // by the other cards on Service Detail. We can't decide whether
  // to hide the card yet — that only makes sense once we know
  // which rows actually have data.
  const isLoading = !availableMetrics || !seriesByMetric;

  if (isLoading) {
    return (
      <div className={s.card}>
        <div className={s.header}>
          <div className={s.title}>{title}</div>
          {subtitle && <div className={s.subtitle}>{subtitle}</div>}
        </div>
        <div className={s.skeletonRows}>
          {[82, 72, 88].map((w, i) => (
            <div key={i} style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    );
  }

  // A row is "present" if it has a finite value OR a non-empty series.
  // If nothing lands for any row, hide the card entirely so empty
  // sections don't clutter Service Detail.
  const presentRows = rowData.filter(
    (r) =>
      (typeof r.value === 'number' && Number.isFinite(r.value)) ||
      r.series.length > 0,
  );

  if (resolvedRows.length === 0) return null;
  if (!rowData.some((r) => r.loading) && presentRows.length === 0) return null;

  return (
    <div className={s.card}>
      <div className={s.header}>
        <div className={s.title}>{title}</div>
        {subtitle && <div className={s.subtitle}>{subtitle}</div>}
      </div>
      <div className={s.rows}>
        {rowData.map((r) => {
          const hasValue =
            typeof r.value === 'number' && Number.isFinite(r.value);
          const hasSeries = r.series.length > 0;
          if (!r.loading && !hasValue && !hasSeries) return null;
          const fmt = r.row.format ?? defaultFormat;
          const valText = hasValue ? fmt(r.value as number) : '—';
          const isWarn =
            hasValue && r.row.warn ? r.row.warn(r.value as number) : false;
          return (
            <div key={r.resolvedMetric} className={s.row}>
              <div className={s.rowLabel}>{r.row.label}</div>
              <div className={`${s.rowValue} ${isWarn ? s.rowValueWarn : ''}`}>
                {r.loading ? (
                  <span className={s.rowLoading}>…</span>
                ) : (
                  valText
                )}
              </div>
              {!r.row.noSparkline && hasSeries && (
                <div className={s.rowSpark}>
                  <Sparkline
                    data={r.series}
                    width={120}
                    height={22}
                    color={isWarn ? '#dc2626' : 'var(--cds-color-accent)'}
                    strokeWidth={1.5}
                    ariaLabel={`${r.row.label} sparkline`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
