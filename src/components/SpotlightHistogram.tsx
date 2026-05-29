import { useState } from 'react';
import type { SpotlightValueRow } from '../spotlight/computeSpotlight';
import s from './SpotlightHistogram.module.css';

interface Props {
  /** Per-value rows for one attribute, already ranked + filtered. */
  rows: readonly SpotlightValueRow[];
  /** Total height in px. Width is full container. */
  height?: number;
  /** Cap on rendered bar pairs. Above this, render the first N — the
   *  point of the histogram is visual scanning for asymmetry, not
   *  exhaustive enumeration. Detail expansion shows the full list. */
  maxBars?: number;
}

interface HoverState {
  idx: number;
  // Pixel position within the chart's bounding box, used to anchor
  // the tooltip without doing per-event getBoundingClientRect calls.
  xPct: number;
  yPct: number;
}

/**
 * SpotlightHistogram — small-multiple chart for one attribute. Each
 * value gets a pair of vertical bars: SELECTION (accent color) and
 * BASELINE (muted gray). The user scans for "which chart has the
 * most asymmetric skyline" — that's the most differentiating
 * attribute.
 *
 * Hover any bar pair → a tooltip overlays the value name and per-side
 * counts. Tooltip position tracks the hovered slot so the user can
 * read each bar without losing context.
 *
 * Pure SVG, no chart lib.
 */
export default function SpotlightHistogram({
  rows,
  height = 64,
  maxBars = 12,
}: Props) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const display = rows.slice(0, maxBars);

  if (display.length === 0) {
    return <div className={s.empty} style={{ height }} />;
  }

  // Normalize each bar to the max share across all values so the chart
  // fills its vertical space — what matters is the asymmetry between
  // sel and base, not the absolute share number.
  const maxShare = Math.max(
    ...display.map((r) => Math.max(r.selShare, r.baseShare)),
  );
  const denom = maxShare > 0 ? maxShare : 1;

  // SVG viewBox geometry. 100×100 canvas with padding so the axis
  // baseline never gets clipped at the edges.
  const W = 100;
  const H = 100;
  const padX = 2;
  const padY = 4;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const slot = innerW / display.length;
  const barGap = Math.max(0.4, slot * 0.06);
  const slotGap = Math.max(0.6, slot * 0.18);
  const barW = (slot - barGap - slotGap) / 2;
  const yAxis = H - padY;

  const hovered = hover ? display[hover.idx] : null;

  return (
    <div
      className={s.container}
      style={{ height }}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        className={s.svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <line
          x1={padX}
          x2={W - padX}
          y1={yAxis}
          y2={yAxis}
          className={s.axis}
        />
        {display.map((r, i) => {
          const slotX = padX + i * slot + slotGap / 2;
          const selH = (r.selShare / denom) * innerH;
          const baseH = (r.baseShare / denom) * innerH;
          const isHovered = hover?.idx === i;
          const xCenter = slotX + barW + barGap / 2;
          return (
            <g
              key={`${r.value}-${i}`}
              className={s.slot}
              data-hovered={isHovered ? 'true' : undefined}
              onMouseEnter={() =>
                setHover({
                  idx: i,
                  xPct: (xCenter / W) * 100,
                  yPct:
                    ((yAxis - Math.max(selH, baseH)) / H) * 100,
                })
              }
            >
              {/* Invisible hit region so the entire vertical strip
                * over the bar pair captures hover, not just the
                * skinny bars themselves. */}
              <rect
                className={s.hit}
                x={slotX - slotGap / 2}
                y={padY}
                width={slot}
                height={innerH}
              />
              <rect
                className={s.barSel}
                x={slotX}
                y={yAxis - selH}
                width={barW}
                height={Math.max(selH, 0.5)}
              />
              <rect
                className={s.barBase}
                x={slotX + barW + barGap}
                y={yAxis - baseH}
                width={barW}
                height={Math.max(baseH, 0.5)}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover && (
        <div
          className={s.tooltip}
          // Anchor at the hovered slot's horizontal center; the
          // tooltip pulls itself up via translate so it never covers
          // the bar it describes.
          style={{
            left: `${hover.xPct}%`,
            bottom: `${100 - hover.yPct + 6}%`,
          }}
          role="tooltip"
        >
          <div className={s.tooltipValue}>{hovered.value}</div>
          <div className={s.tooltipRow}>
            <span className={s.tooltipSel}>
              sel {hovered.selN.toLocaleString()}
            </span>
            <span className={s.tooltipPct}>
              {(hovered.selShare * 100).toFixed(1)}%
            </span>
          </div>
          <div className={s.tooltipRow}>
            <span className={s.tooltipBase}>
              base {hovered.baseN.toLocaleString()}
            </span>
            <span className={s.tooltipPct}>
              {(hovered.baseShare * 100).toFixed(1)}%
            </span>
          </div>
          <div
            className={`${s.tooltipDiff} ${
              hovered.diff >= 0 ? s.diffOver : s.diffUnder
            }`}
          >
            {hovered.diff >= 0 ? '+' : ''}
            {(hovered.diff * 100).toFixed(1)}% vs baseline
          </div>
        </div>
      )}
    </div>
  );
}
