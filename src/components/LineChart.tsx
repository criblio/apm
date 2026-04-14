/**
 * A multi-series line chart with hover tooltip, axes, and gridlines.
 * Used for the Rate / Errors / Duration cards on the Service detail page.
 *
 * Resizes to its container width via ResizeObserver so it composes into
 * flexible grids without per-parent width plumbing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { scaleLinear, scaleTime } from 'd3-scale';
import { line as d3Line, curveMonotoneX } from 'd3-shape';
import { max as d3Max, min as d3Min, bisector } from 'd3-array';
import { timeFormat } from 'd3-time-format';
import s from './LineChart.module.css';

export interface LineSeries {
  name: string;
  color: string;
  data: Array<{ t: number; v: number }>;
  format?: (v: number) => string;
}

interface Props {
  title: string;
  subtitle?: string;
  series: LineSeries[];
  /** Explicit y-axis formatter; defaults to the first series' format. */
  yFormat?: (v: number) => string;
  /** Explicit y-axis max; defaults to max across all series. */
  yMax?: number;
  height?: number;
  /** Optional tooltip header override (e.g. show "error rate" instead of raw). */
  emptyMessage?: string;
}

const M = { top: 8, right: 12, bottom: 22, left: 56 };
const fmtTick = timeFormat('%H:%M');

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v === 0) return '0';
  return v.toFixed(v < 10 ? 2 : 0);
}

export default function LineChart({
  title,
  subtitle,
  series,
  yFormat,
  yMax,
  height = 180,
  emptyMessage = 'No data in this time range',
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setWidth(Math.floor(r.width - 2 * parseInt(getComputedStyle(el).paddingLeft || '0', 10)) || 600);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chartWidth = Math.max(200, width);
  const innerW = chartWidth - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  const { xScale, yScale, paths, tickX, tickY, hasData } = useMemo(() => {
    const allPts: Array<{ t: number; v: number }> = [];
    for (const s of series) allPts.push(...s.data);
    if (allPts.length === 0) {
      return {
        xScale: null,
        yScale: null,
        paths: [],
        tickX: [],
        tickY: [],
        hasData: false,
      };
    }
    const xMin = d3Min(allPts, (d) => d.t) ?? 0;
    const xMax = d3Max(allPts, (d) => d.t) ?? 1;
    const yResolved = yMax ?? d3Max(allPts, (d) => d.v) ?? 1;
    const x = scaleTime().domain([xMin, xMax]).range([0, innerW]);
    const y = scaleLinear().domain([0, Math.max(yResolved * 1.1, 1)]).range([innerH, 0]);
    const lineGen = d3Line<{ t: number; v: number }>()
      .x((d) => x(d.t))
      .y((d) => y(d.v))
      .curve(curveMonotoneX)
      .defined((d) => Number.isFinite(d.v));
    const tickCount = Math.max(3, Math.min(6, Math.floor(innerW / 80)));
    return {
      xScale: x,
      yScale: y,
      paths: series.map((s) => ({ ...s, d: lineGen(s.data) ?? '' })),
      tickX: x.ticks(tickCount),
      tickY: y.ticks(4),
      hasData: true,
    };
  }, [series, innerW, innerH, yMax]);

  const yFmt = yFormat ?? defaultFormat;

  // Hover: find nearest time across all series
  const hoverSamples = useMemo(() => {
    if (hoverX == null || !xScale) return null;
    const tHover = xScale.invert(hoverX).getTime();
    const bisect = bisector<{ t: number; v: number }, number>((d) => d.t).left;
    const samples: Array<{ name: string; color: string; t: number; v: number; formatted: string }> = [];
    let nearestT = tHover;
    for (const s of series) {
      if (s.data.length === 0) continue;
      const sorted = s.data;
      const i = bisect(sorted, tHover);
      const a = sorted[Math.max(0, i - 1)];
      const b = sorted[Math.min(sorted.length - 1, i)];
      const nearest = !a ? b : !b ? a : Math.abs(a.t - tHover) < Math.abs(b.t - tHover) ? a : b;
      if (nearest) {
        nearestT = nearest.t;
        samples.push({
          name: s.name,
          color: s.color,
          t: nearest.t,
          v: nearest.v,
          formatted: (s.format ?? yFmt)(nearest.v),
        });
      }
    }
    return { t: nearestT, samples };
  }, [hoverX, series, xScale, yFmt]);

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
                <span className={s.legendSwatch} style={{ background: sr.color }} />
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
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = e.clientX - rect.left - M.left;
          if (x >= 0 && x <= innerW) setHoverX(x);
          else setHoverX(null);
        }}
        onMouseLeave={() => setHoverX(null)}
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
          {/* Data paths */}
          {paths.map((p) => (
            <path
              key={p.name}
              d={p.d}
              fill="none"
              stroke={p.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {/* Hover crosshair + dots */}
          {hasData && hoverX != null && hoverSamples && (
            <g pointerEvents="none">
              <line
                x1={xScale!(new Date(hoverSamples.t))}
                x2={xScale!(new Date(hoverSamples.t))}
                y1={0}
                y2={innerH}
                stroke="var(--cds-color-fg-muted)"
                strokeDasharray="2 3"
              />
              {hoverSamples.samples.map((smp, i) => (
                <circle
                  key={i}
                  cx={xScale!(new Date(smp.t))}
                  cy={yScale!(smp.v)}
                  r={3.5}
                  fill={smp.color}
                  stroke="var(--cds-color-bg)"
                  strokeWidth={1.5}
                />
              ))}
            </g>
          )}
        </g>
      </svg>

      {!hasData && <div className={s.empty}>{emptyMessage}</div>}

      {hasData && hoverX != null && hoverSamples && hoverSamples.samples.length > 0 && (
        <div
          className={s.tooltip}
          style={{
            left: Math.min(Math.max(M.left + hoverX, 10), chartWidth - 160),
            top: 8,
          }}
        >
          <div className={s.tooltipTime}>{timeFormat('%H:%M:%S')(new Date(hoverSamples.t))}</div>
          {hoverSamples.samples.map((smp, i) => (
            <div key={i} className={s.tooltipRow}>
              <span className={s.tooltipDot} style={{ background: smp.color }} />
              {smp.name}: <strong>{smp.formatted}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
