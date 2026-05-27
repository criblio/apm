/**
 * Multi-series stacked column chart with hover tooltip, axes, and
 * gridlines. Used for the Status mix card on the Service detail
 * page, where each column is a time bucket and the segments inside
 * it are the per-(status class) counts stacked bottom-up.
 *
 * Series array order = stack order, bottom-to-top.
 *
 * Resizes to its container width via ResizeObserver. Shares CSS
 * with LineChart so the wrapper / legend / tooltip / empty-state
 * styling matches the sibling chart panels.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { scaleLinear, scaleTime } from 'd3-scale';
import { max as d3Max, min as d3Min } from 'd3-array';
import { timeFormat } from 'd3-time-format';
import s from './LineChart.module.css';

export interface StackedSeries {
  name: string;
  color: string;
  /** Per-bucket values keyed by epoch ms. Missing buckets are treated
   * as zero (the segment simply has no height in that column). */
  data: Array<{ t: number; v: number }>;
  format?: (v: number) => string;
}

interface Props {
  title: string;
  subtitle?: string;
  series: StackedSeries[];
  /** Explicit y-axis formatter; defaults to integer-K shortening. */
  yFormat?: (v: number) => string;
  height?: number;
  emptyMessage?: string;
}

const M = { top: 8, right: 12, bottom: 22, left: 56 };
const fmtTick = timeFormat('%H:%M');

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v === 0) return '0';
  return v.toFixed(0);
}

export default function StackedColumnChart({
  title,
  subtitle,
  series,
  yFormat,
  height = 180,
  emptyMessage = 'No data in this time range',
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0)
        setWidth(
          Math.floor(
            r.width -
              2 *
                parseInt(
                  getComputedStyle(el).paddingLeft || '0',
                  10,
                ),
          ) || 600,
        );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chartWidth = Math.max(200, width);
  const innerW = chartWidth - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  /**
   * Pivot per-series long-format rows into per-bucket stacked
   * segments. The result is one row per unique bucket timestamp,
   * with each series' value + the cumulative running sum (used as
   * the segment's bottom edge when drawing).
   */
  const { buckets, barWidth, xScale, yScale, tickX, tickY, hasData } =
    useMemo(() => {
      const byBucket = new Map<number, Map<string, number>>();
      for (const sr of series) {
        for (const pt of sr.data) {
          let row = byBucket.get(pt.t);
          if (!row) {
            row = new Map();
            byBucket.set(pt.t, row);
          }
          row.set(sr.name, (row.get(sr.name) ?? 0) + pt.v);
        }
      }
      const sortedTs = Array.from(byBucket.keys()).sort((a, b) => a - b);
      if (sortedTs.length === 0) {
        return {
          buckets: [] as Array<{
            t: number;
            segments: Array<{ name: string; y0: number; y1: number }>;
            total: number;
          }>,
          barWidth: 0,
          xScale: null,
          yScale: null,
          tickX: [] as Date[],
          tickY: [] as number[],
          hasData: false,
        };
      }
      const xMin = d3Min(sortedTs) ?? 0;
      const xMax = d3Max(sortedTs) ?? 1;
      // Build per-bucket segments. Order follows the input `series`
      // array (stack-bottom first). Each segment carries (y0, y1) in
      // domain units; the renderer converts to pixels.
      const bucketRows = sortedTs.map((t) => {
        const row = byBucket.get(t)!;
        let running = 0;
        const segments: Array<{ name: string; y0: number; y1: number }> = [];
        for (const sr of series) {
          const v = row.get(sr.name) ?? 0;
          if (v > 0) {
            segments.push({ name: sr.name, y0: running, y1: running + v });
            running += v;
          }
        }
        return { t, segments, total: running };
      });
      const totalMax = d3Max(bucketRows, (b) => b.total) ?? 1;
      const x = scaleTime()
        .domain([xMin, xMax])
        .range([0, innerW]);
      const y = scaleLinear()
        .domain([0, Math.max(totalMax * 1.1, 1)])
        .range([innerH, 0]);
      // Bar width is derived from the typical bucket spacing rather
      // than scaleBand so the x-axis stays time-based (tick labels
      // line up with the time-formatted ticks). 85% of the slot
      // leaves a faint gap between columns; bigger gap if there are
      // very few buckets so they don't read as solid blocks.
      const slotPx = innerW / Math.max(sortedTs.length, 1);
      const bw = Math.max(1, slotPx * (sortedTs.length > 30 ? 0.92 : 0.8));
      const tickCount = Math.max(3, Math.min(6, Math.floor(innerW / 80)));
      return {
        buckets: bucketRows,
        barWidth: bw,
        xScale: x,
        yScale: y,
        tickX: x.ticks(tickCount),
        tickY: y.ticks(4),
        hasData: true,
      };
    }, [series, innerW, innerH]);

  const yFmt = yFormat ?? defaultFormat;

  const seriesColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const sr of series) m.set(sr.name, sr.color);
    return m;
  }, [series]);

  const hoverRow =
    hoverBucket != null
      ? buckets.find((b) => b.t === hoverBucket) ?? null
      : null;

  return (
    <div className={s.wrap} ref={wrapRef}>
      <div className={s.header}>
        <div>
          <div className={s.title}>{title}</div>
          {subtitle && <div className={s.subtitle}>{subtitle}</div>}
        </div>
        {series.length > 1 && (
          <div className={s.legend}>
            {series.map((sr) => (
              <span key={sr.name}>
                <span
                  className={s.legendSwatch}
                  style={{ background: sr.color }}
                />
                {sr.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <svg
        className={s.svg}
        width={chartWidth}
        height={height}
        onMouseMove={(e) => {
          if (!xScale || buckets.length === 0) return;
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = e.clientX - rect.left - M.left;
          if (x < 0 || x > innerW) {
            setHoverBucket(null);
            return;
          }
          const tHover = xScale.invert(x).getTime();
          // Nearest bucket by absolute time delta.
          let best = buckets[0];
          let bestDelta = Math.abs(best.t - tHover);
          for (const b of buckets) {
            const d = Math.abs(b.t - tHover);
            if (d < bestDelta) {
              best = b;
              bestDelta = d;
            }
          }
          setHoverBucket(best.t);
        }}
        onMouseLeave={() => setHoverBucket(null)}
      >
        <g transform={`translate(${M.left},${M.top})`}>
          {/* Y gridlines + labels */}
          {hasData &&
            tickY.map((t, i) => (
              <g key={`gy-${i}`}>
                <line
                  x1={0}
                  x2={innerW}
                  y1={yScale!(t)}
                  y2={yScale!(t)}
                  stroke="var(--cds-color-border-subtle)"
                  strokeDasharray="2 3"
                />
                <text
                  x={-8}
                  y={yScale!(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill="var(--cds-color-fg-muted)"
                  fontSize={11}
                  fontFamily='"Open Sans", sans-serif'
                >
                  {yFmt(t)}
                </text>
              </g>
            ))}
          {/* X tick labels */}
          {hasData &&
            tickX.map((t, i) => (
              <text
                key={`xt-${i}`}
                x={xScale!(t)}
                y={innerH + 14}
                textAnchor="middle"
                fill="var(--cds-color-fg-muted)"
                fontSize={11}
                fontFamily='"Open Sans", sans-serif'
              >
                {fmtTick(t)}
              </text>
            ))}
          {/* Baseline */}
          <line
            x1={0}
            x2={innerW}
            y1={innerH}
            y2={innerH}
            stroke="var(--cds-color-border)"
            strokeWidth={1}
          />
          {/* Stacked columns — one <rect> per (bucket, segment).
              The y-axis is inverted in pixel space (0 at top), so
              segment y in pixels = yScale(segment.y1) (top edge),
              and height = yScale(y0) - yScale(y1). */}
          {hasData &&
            buckets.map((b) => {
              const xCenter = xScale!(new Date(b.t));
              const left = xCenter - barWidth / 2;
              return (
                <g key={b.t}>
                  {b.segments.map((seg) => (
                    <rect
                      key={`${b.t}-${seg.name}`}
                      x={left}
                      y={yScale!(seg.y1)}
                      width={barWidth}
                      height={Math.max(
                        0,
                        yScale!(seg.y0) - yScale!(seg.y1),
                      )}
                      fill={seriesColors.get(seg.name) ?? '#999'}
                    />
                  ))}
                </g>
              );
            })}
          {/* Hover crosshair */}
          {hasData && hoverRow && (
            <line
              x1={xScale!(new Date(hoverRow.t))}
              x2={xScale!(new Date(hoverRow.t))}
              y1={0}
              y2={innerH}
              stroke="var(--cds-color-fg-muted)"
              strokeDasharray="2 3"
              pointerEvents="none"
            />
          )}
        </g>
      </svg>

      {!hasData && <div className={s.empty}>{emptyMessage}</div>}

      {hasData && hoverRow && (
        <div
          className={s.tooltip}
          style={{
            left: Math.min(
              Math.max(M.left + xScale!(new Date(hoverRow.t)), 10),
              chartWidth - 200,
            ),
            top: 8,
          }}
        >
          <div className={s.tooltipTime}>
            {timeFormat('%H:%M:%S')(new Date(hoverRow.t))}
          </div>
          {/* Tooltip lists top-to-bottom = visual top-to-bottom of
              the column (errors first, ok last), which matches what
              the operator sees onscreen. */}
          {[...hoverRow.segments].reverse().map((seg) => {
            const sr = series.find((x) => x.name === seg.name);
            const v = seg.y1 - seg.y0;
            const fmt = sr?.format ?? yFmt;
            return (
              <div key={seg.name} className={s.tooltipRow}>
                <span
                  className={s.tooltipDot}
                  style={{ background: seriesColors.get(seg.name) }}
                />
                {seg.name}: <strong>{fmt(v)}</strong>
              </div>
            );
          })}
          <div className={s.tooltipRow} style={{ marginTop: 4, opacity: 0.7 }}>
            <em>total: {yFmt(hoverRow.total)}</em>
          </div>
        </div>
      )}
    </div>
  );
}
