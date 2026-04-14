/**
 * Compact SVG sparkline for in-row visualizations. No axes, no labels —
 * just a line (and optional filled area) that shows the trend shape.
 *
 * All layout is inline — the component accepts an explicit width/height so
 * it composes cleanly inside table cells without a ResizeObserver.
 */
import { useMemo } from 'react';
import { scaleLinear } from 'd3-scale';
import { line as d3Line, area as d3Area, curveMonotoneX } from 'd3-shape';
import { max as d3Max, min as d3Min } from 'd3-array';

interface Props {
  data: Array<{ t: number; v: number }>;
  width: number;
  height: number;
  color: string;
  fill?: boolean;
  strokeWidth?: number;
  /** Override the y-axis domain; defaults to [0, max(v)]. */
  yDomain?: [number, number];
  /** Show a small dot at the last datapoint. */
  lastDot?: boolean;
  ariaLabel?: string;
}

export default function Sparkline({
  data,
  width,
  height,
  color,
  fill = false,
  strokeWidth = 1.5,
  yDomain,
  lastDot = true,
  ariaLabel,
}: Props) {
  const paths = useMemo(() => {
    if (data.length === 0) return null;
    const sorted = [...data].sort((a, b) => a.t - b.t);
    const xMin = d3Min(sorted, (d) => d.t) ?? 0;
    const xMax = d3Max(sorted, (d) => d.t) ?? 1;
    const yMax = yDomain ? yDomain[1] : (d3Max(sorted, (d) => d.v) ?? 1);
    const yMin = yDomain ? yDomain[0] : 0;

    const x = scaleLinear().domain([xMin, xMax]).range([1, width - 1]);
    const y = scaleLinear().domain([yMin, Math.max(yMax, 1)]).range([height - 2, 2]);

    const lineGen = d3Line<{ t: number; v: number }>()
      .x((d) => x(d.t))
      .y((d) => y(d.v))
      .curve(curveMonotoneX);

    const areaGen = d3Area<{ t: number; v: number }>()
      .x((d) => x(d.t))
      .y0(height - 2)
      .y1((d) => y(d.v))
      .curve(curveMonotoneX);

    const last = sorted[sorted.length - 1];
    return {
      line: lineGen(sorted) ?? '',
      area: fill ? (areaGen(sorted) ?? '') : '',
      lastX: x(last.t),
      lastY: y(last.v),
    };
  }, [data, width, height, fill, yDomain]);

  if (!paths) {
    // Empty state — flat baseline
    return (
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel ?? 'No data'}
        style={{ display: 'block' }}
      >
        <line
          x1={1}
          x2={width - 1}
          y1={height - 2}
          y2={height - 2}
          stroke="var(--cds-color-border)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel ?? ''}
      style={{ display: 'block' }}
    >
      {fill && (
        <path
          d={paths.area}
          fill={color}
          fillOpacity={0.15}
          stroke="none"
        />
      )}
      <path
        d={paths.line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {lastDot && (
        <circle
          cx={paths.lastX}
          cy={paths.lastY}
          r={2}
          fill={color}
        />
      )}
    </svg>
  );
}
