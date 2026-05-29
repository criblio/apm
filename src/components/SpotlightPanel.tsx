import { useMemo } from 'react';
import type { SpotlightBucket } from '../api/types';
import {
  computeSpotlight,
  type ComputeOptions,
} from '../spotlight/computeSpotlight';
import s from './SpotlightPanel.module.css';

interface Props {
  /** Raw differential map from getSpotlightDiff. */
  diff: Map<string, SpotlightBucket[]>;
  /** When the user clicks a value row, surface (attr, value) so the
   *  parent can append it to the active selection or to filters. */
  onPickValue: (attr: string, value: string) => void;
  loading?: boolean;
  /** Tuning knobs forwarded to computeSpotlight. */
  options?: ComputeOptions;
  /** Optional caption shown above the first attribute. Defaults to a
   *  short explanation of what Spotlight is showing. */
  caption?: string;
}

/**
 * SpotlightPanel — Honeycomb-BubbleUp-style differential view.
 *
 * For each attribute in `diff`, computes per-value sel/base shares
 * and visualizes the differential as a pair of side-by-side bars:
 * the SEL bar (left, accent color) shows the value's share inside
 * the user's selection; the BASE bar (right, neutral) shows the
 * baseline. The visual asymmetry IS the signal.
 */
export default function SpotlightPanel({
  diff,
  onPickValue,
  loading,
  options,
  caption = 'Attributes whose values are over- or under-represented in your selection vs the rest of the time window.',
}: Props) {
  const ranked = useMemo(
    () => computeSpotlight(diff, options),
    [diff, options],
  );

  if (loading) {
    return <div className={s.placeholder}>Computing Spotlight…</div>;
  }
  if (ranked.length === 0) {
    return (
      <div className={s.placeholder}>
        No strong differentials found. Try widening your selection or
        lowering the noise threshold.
      </div>
    );
  }

  return (
    <div className={s.panel} aria-label="Spotlight panel">
      <p className={s.caption}>{caption}</p>
      {ranked.map((attr) => (
        <div key={attr.name} className={s.group}>
          <div className={s.groupHeader}>
            <span className={s.attrName}>{attr.name}</span>
            <span className={s.score} title={`score ${attr.score.toFixed(2)}`}>
              {attr.score.toFixed(2)}
            </span>
          </div>
          <ul className={s.values}>
            {attr.rows.map((row) => {
              const direction =
                row.diff > 0 ? 'over' : row.diff < 0 ? 'under' : 'flat';
              return (
                <li
                  key={row.value}
                  className={`${s.valueRow} ${s[direction]}`}
                  data-testid="spotlight-row"
                >
                  <button
                    type="button"
                    className={s.valueBtn}
                    onClick={() => onPickValue(attr.name, row.value)}
                    title={`Add ${attr.name} = ${row.value} to filters`}
                  >
                    <span className={s.valueLabel}>{row.value}</span>
                    <span className={s.diffPct}>
                      {row.diff >= 0 ? '+' : ''}
                      {(row.diff * 100).toFixed(1)}%
                    </span>
                  </button>
                  <div className={s.bars} aria-hidden>
                    <div className={s.barTrack}>
                      <div
                        className={s.barSel}
                        style={{ width: `${(row.selShare * 100).toFixed(1)}%` }}
                      />
                    </div>
                    <div className={s.barTrack}>
                      <div
                        className={s.barBase}
                        style={{ width: `${(row.baseShare * 100).toFixed(1)}%` }}
                      />
                    </div>
                  </div>
                  <div className={s.counts}>
                    <span className={s.countSel}>
                      sel {row.selN.toLocaleString()}
                    </span>
                    <span className={s.countBase}>
                      base {row.baseN.toLocaleString()}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
