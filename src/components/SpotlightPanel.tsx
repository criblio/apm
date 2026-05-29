import { useMemo, useState } from 'react';
import type { SpotlightBucket } from '../api/types';
import {
  computeSpotlight,
  type ComputeOptions,
} from '../spotlight/computeSpotlight';
import SpotlightHistogram from './SpotlightHistogram';
import s from './SpotlightPanel.module.css';

interface Props {
  /** Raw differential map from getSpotlightDiff. */
  diff: Map<string, SpotlightBucket[]>;
  /** When the user clicks a value row in an expanded attribute, surface
   *  (attr, value) so the parent can append it to the active selection
   *  or to filters. */
  onPickValue: (attr: string, value: string) => void;
  loading?: boolean;
  /** Tuning knobs forwarded to computeSpotlight. */
  options?: ComputeOptions;
  /** Optional caption shown above the first attribute. */
  caption?: string;
}

/**
 * SpotlightPanel — small-multiples differential view.
 *
 * Renders one compact mini-histogram per attribute (selection bars in
 * accent + baseline bars in muted). The user scans the rail for the
 * most asymmetric chart — that's the strongest differentiator. Click
 * an attribute to expand the per-value detail list inline with
 * click-to-filter actions.
 *
 * This replaces the older row-per-value card design which was visually
 * heavy: a single attribute could eat 20+ lines of UI. Small-multiples
 * fit ~6× more attributes into the same vertical space and let the
 * eye do the work it's good at — pattern matching.
 */
export default function SpotlightPanel({
  diff,
  onPickValue,
  loading,
  options,
  caption = 'Each chart shows one attribute. The colored bars are your selection’s share of each value; the gray bars are the rest of the time window. Asymmetric charts are the strongest differentiators — click any chart to see the per-value detail.',
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
        selection; charts appear as queries return…
      </div>
    );
  }
  if (ranked.length === 0) {
    return (
      <div className={s.placeholder}>
        Nothing stands out yet. Your selection looks like the rest of
        the time window — try a different filter, or widen the lookback.
      </div>
    );
  }

  return (
    <div className={s.panel} aria-label="Spotlight panel">
      <p className={s.caption}>{caption}</p>
      <ul className={s.grid}>
        {ranked.map((attr) => {
          const isOpen = openAttr === attr.name;
          const toggle = () => setOpenAttr(isOpen ? null : attr.name);
          return (
            <li key={attr.name} className={s.cell}>
              {/* The clickable surface is the WHOLE cell (header +
               * chart), so the user can click anywhere in the cell
               * to expand. The histogram's hover handlers don't
               * intercept clicks — they only set local tooltip
               * state. */}
              <div
                className={`${s.cellSurface} ${isOpen ? s.cellSurfaceOpen : ''}`}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                aria-controls={`spot-detail-${attr.name}`}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                  }
                }}
                title={
                  isOpen
                    ? `Hide values for ${attr.name}`
                    : `Show values for ${attr.name}`
                }
              >
                <div className={s.cellHeader}>
                  <span className={s.attrName}>{attr.name}</span>
                  <span
                    className={s.score}
                    title={`Score ${attr.score.toFixed(2)} — higher = stronger differentiator`}
                  >
                    {attr.score.toFixed(2)}
                  </span>
                </div>
                <SpotlightHistogram rows={attr.rows} />
              </div>
              {isOpen && (
                <ul
                  id={`spot-detail-${attr.name}`}
                  className={s.detailList}
                >
                  {attr.rows.map((row) => {
                    const direction =
                      row.diff > 0 ? 'over' : row.diff < 0 ? 'under' : 'flat';
                    return (
                      <li
                        key={row.value}
                        className={`${s.detailRow} ${s[direction]}`}
                      >
                        <button
                          type="button"
                          className={s.detailBtn}
                          onClick={() => onPickValue(attr.name, row.value)}
                          title={`Add ${attr.name} = ${row.value} as a filter`}
                        >
                          <span className={s.detailValue}>{row.value}</span>
                          <span className={s.detailPct}>
                            {row.diff >= 0 ? '+' : ''}
                            {(row.diff * 100).toFixed(1)}%
                          </span>
                          <span className={s.detailCounts}>
                            <span className={s.detailSel}>
                              {row.selN.toLocaleString()}
                            </span>
                            <span className={s.detailBase}>
                              {row.baseN.toLocaleString()}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className={s.legend}>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendSwatchSel}`} />
          selection
        </span>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendSwatchBase}`} />
          baseline
        </span>
      </div>
    </div>
  );
}
