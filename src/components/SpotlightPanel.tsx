import { useMemo, useState } from 'react';
import type { SpotlightBucket } from '../api/types';
import {
  computeSpotlight,
  type ComputeOptions,
  type SpotlightValueRow,
} from '../spotlight/computeSpotlight';
import SpotlightHistogram from './SpotlightHistogram';
import s from './SpotlightPanel.module.css';

interface Props {
  diff: Map<string, SpotlightBucket[]>;
  /** Click handler for the per-value Search button. */
  onPickValue: (attr: string, value: string) => void;
  loading?: boolean;
  options?: ComputeOptions;
  caption?: string;
}

/**
 * Number of value rows shown inline (without expansion). Small enough
 * to keep cells compact, large enough to surface the actionable values
 * for a typical 2–5 value attribute. The expand toggle reveals the
 * rest.
 */
const INLINE_ROWS = 3;

function formatPct(n: number): string {
  if (Math.abs(n) >= 1) return `${(n * 100).toFixed(0)}%`;
  if (Math.abs(n) >= 0.1) return `${(n * 100).toFixed(1)}%`;
  return `${(n * 100).toFixed(2)}%`;
}

function formatDiff(diff: number): string {
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${(diff * 100).toFixed(1)} pp`;
}

interface ValueRowProps {
  attrName: string;
  row: SpotlightValueRow;
  onPick: (attr: string, value: string) => void;
}

function ValueRow({ attrName, row, onPick }: ValueRowProps) {
  const direction =
    row.diff > 0.005 ? 'over' : row.diff < -0.005 ? 'under' : 'flat';
  return (
    <li className={`${s.valueRow} ${s[direction]}`}>
      <div className={s.valueMain}>
        <span className={s.valueLabel} title={row.value}>
          {row.value}
        </span>
        <span className={s.valueDiff}>{formatDiff(row.diff)}</span>
      </div>
      <div className={s.valueCounts}>
        <span className={s.countSel}>
          sel {row.selN.toLocaleString()} ({formatPct(row.selShare)})
        </span>
        <span className={s.countBase}>
          base {row.baseN.toLocaleString()} ({formatPct(row.baseShare)})
        </span>
      </div>
      <button
        type="button"
        className={s.searchBtn}
        onClick={(e) => {
          e.stopPropagation();
          onPick(attrName, row.value);
        }}
        title={`Open Search with ${attrName} = ${row.value}`}
      >
        Search →
      </button>
    </li>
  );
}

export default function SpotlightPanel({
  diff,
  onPickValue,
  loading,
  options,
  caption = 'Each card is one attribute that differs between your selection and the comparison set. Rows show the values driving the difference — "sel" is the selection’s share of that value, "base" is the comparison’s share. Click Search to open Traces filtered to spans matching that value.',
}: Props) {
  const ranked = useMemo(
    () => computeSpotlight(diff, options),
    [diff, options],
  );
  const [openAttr, setOpenAttr] = useState<string | null>(null);

  if (loading && ranked.length === 0) {
    return (
      <div className={s.placeholder}>
        Computing Spotlight — checking each attribute against your
        selection; results appear as queries return…
      </div>
    );
  }
  if (ranked.length === 0) {
    return (
      <div className={s.placeholder}>
        Nothing stands out yet. The selection's distribution looks the
        same as the comparison's — try a different filter, or widen the
        lookback.
      </div>
    );
  }

  return (
    <div className={s.panel} aria-label="Spotlight panel">
      <p className={s.caption}>{caption}</p>
      <ul className={s.grid}>
        {ranked.map((attr) => {
          const isOpen = openAttr === attr.name;
          const visibleRows = isOpen
            ? attr.rows
            : attr.rows.slice(0, INLINE_ROWS);
          const hiddenCount = attr.rows.length - visibleRows.length;
          // TL;DR is the strongest single row — either the top
          // over-represented or top under-represented value, whichever
          // has the larger absolute diff. Surfacing the headline as a
          // sentence makes the cell readable at-a-glance, even when
          // the only attribute that surfaced is a single sparse one
          // (which was the user's complaint with the chart-only view).
          const top = attr.rows[0];
          const bottom = attr.rows[attr.rows.length - 1];
          const headlineRow =
            top && bottom &&
            Math.abs(top.diff) >= Math.abs(bottom.diff)
              ? top
              : bottom ?? top;
          return (
            <li key={attr.name} className={s.cell}>
              <div className={s.cellHeader}>
                <span className={s.attrName} title={attr.name}>
                  {attr.name}
                </span>
                <span
                  className={s.score}
                  title={`Score ${attr.score.toFixed(2)} — higher = stronger differentiator`}
                >
                  score {attr.score.toFixed(2)}
                </span>
              </div>
              {headlineRow && (
                <p className={s.headline}>
                  {headlineRow.diff >= 0 ? 'Selection over-represents' : 'Selection under-represents'}{' '}
                  <code>{headlineRow.value}</code> by{' '}
                  <strong>{formatDiff(headlineRow.diff)}</strong>{' '}
                  ({headlineRow.selN.toLocaleString()} sel vs{' '}
                  {headlineRow.baseN.toLocaleString()} base).
                </p>
              )}
              <SpotlightHistogram rows={attr.rows} />
              <ul className={s.valueList}>
                {visibleRows.map((row) => (
                  <ValueRow
                    key={row.value}
                    attrName={attr.name}
                    row={row}
                    onPick={onPickValue}
                  />
                ))}
              </ul>
              {!isOpen && hiddenCount > 0 && (
                <button
                  type="button"
                  className={s.toggleMore}
                  onClick={() => setOpenAttr(attr.name)}
                >
                  Show {hiddenCount} more value
                  {hiddenCount === 1 ? '' : 's'}
                </button>
              )}
              {isOpen && (
                <button
                  type="button"
                  className={s.toggleMore}
                  onClick={() => setOpenAttr(null)}
                >
                  Show fewer
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className={s.legend}>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendSwatchSel}`} />
          selection (the spans you're investigating)
        </span>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendSwatchBase}`} />
          baseline (what they're being compared against)
        </span>
      </div>
    </div>
  );
}
