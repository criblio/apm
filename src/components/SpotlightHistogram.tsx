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

/**
 * SpotlightHistogram — small-multiple chart for one attribute. Each
 * value gets a pair of vertical bars: SELECTION (accent color) and
 * BASELINE (muted gray). The user scans for "which chart has the
 * most asymmetric skyline" — that's the most differentiating
 * attribute.
 *
 * Pure SVG, no chart lib. Fixed aspect at the component level so a
 * grid of these renders as a true small-multiple matrix.
 */
export default function SpotlightHistogram({
  rows,
  height = 56,
  maxBars = 12,
}: Props) {
  const display = rows.slice(0, maxBars);
  if (display.length === 0) {
    return <div className={s.empty} style={{ height }} />;
  }

  // Normalize each bar to the max share seen across all values so the
  // chart fills its vertical space — the asymmetry between sel and
  // base is what matters, not the absolute share number.
  const maxShare = Math.max(
    ...display.map((r) => Math.max(r.selShare, r.baseShare)),
  );
  const denom = maxShare > 0 ? maxShare : 1;

  // SVG view-box geometry. Bars are normalized to a 100-unit canvas
  // with explicit padding so the stroke-rendered axis baseline never
  // gets clipped at the edges.
  const W = 100;
  const H = 100;
  const padX = 2;
  const padY = 4;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const slot = innerW / display.length;
  // Two bars per slot with a small gap between sel + base, and a
  // slot-gap between adjacent (value) pairs.
  const barGap = Math.max(0.4, slot * 0.06);
  const slotGap = Math.max(0.6, slot * 0.18);
  const barW = (slot - barGap - slotGap) / 2;

  return (
    <svg
      className={s.svg}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
      aria-hidden
    >
      {/* Baseline axis. Subtle visual anchor for "ground". */}
      <line
        x1={padX}
        x2={W - padX}
        y1={H - padY}
        y2={H - padY}
        className={s.axis}
      />
      {display.map((r, i) => {
        const x = padX + i * slot + slotGap / 2;
        const selH = (r.selShare / denom) * innerH;
        const baseH = (r.baseShare / denom) * innerH;
        const yAxis = H - padY;
        const title = `${r.value} — sel ${r.selN.toLocaleString()} (${(r.selShare * 100).toFixed(1)}%), base ${r.baseN.toLocaleString()} (${(r.baseShare * 100).toFixed(1)}%)`;
        return (
          <g key={`${r.value}-${i}`}>
            <title>{title}</title>
            <rect
              className={s.barSel}
              x={x}
              y={yAxis - selH}
              width={barW}
              height={Math.max(selH, 0.5)}
            />
            <rect
              className={s.barBase}
              x={x + barW + barGap}
              y={yAxis - baseH}
              width={barW}
              height={Math.max(baseH, 0.5)}
            />
          </g>
        );
      })}
    </svg>
  );
}
