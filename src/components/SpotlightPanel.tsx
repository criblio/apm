import { useMemo, useState } from 'react';
import type { SpotlightBucket } from '../api/types';
import {
  computeSpotlight,
  type ComputeOptions,
  type SpotlightAttribute,
  type SpotlightValueRow,
} from '../spotlight/computeSpotlight';
import s from './SpotlightPanel.module.css';

interface Props {
  diff: Map<string, SpotlightBucket[]>;
  /** Click handler for the per-value Search button. */
  onPickValue: (attr: string, value: string) => void;
  loading?: boolean;
  options?: ComputeOptions;
  /**
   * One-word noun for the selection in this context. Renders as e.g.
   * "98% errors" instead of generic "selection rate." Defaults to
   * "matching".
   */
  selectionNoun?: string;
  caption?: string;
}

/** Rows shown inline before expansion. */
const INLINE_ROWS = 4;

function pct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  const v = n * 100;
  if (Math.abs(v) >= 100) return '100%';
  if (Math.abs(v) >= 10) return `${v.toFixed(0)}%`;
  return `${v.toFixed(digits)}%`;
}

interface RateBarProps {
  rate: number;
  /** Render style — "high" highlights when the rate is meaningfully
   *  above the attribute's overall average. */
  highlight: 'high' | 'low' | 'flat';
}

function RateBar({ rate, highlight }: RateBarProps) {
  return (
    <div className={s.rateTrack} role="presentation">
      <div
        className={`${s.rateFill} ${s[`rateFill_${highlight}`]}`}
        style={{ width: `${Math.min(100, rate * 100)}%` }}
      />
    </div>
  );
}

interface AttrCardProps {
  attr: SpotlightAttribute;
  selectionNoun: string;
  onPickValue: (attr: string, value: string) => void;
}

function AttrCard({ attr, selectionNoun, onPickValue }: AttrCardProps) {
  const [expanded, setExpanded] = useState(false);

  const visibleRows = expanded
    ? attr.rows
    : attr.rows.slice(0, INLINE_ROWS);
  const hidden = attr.rows.length - visibleRows.length;
  const avg = attr.overallRate;

  function classifyRow(r: SpotlightValueRow): 'high' | 'low' | 'flat' {
    const delta = r.selectionRate - avg;
    if (Math.abs(delta) < 0.03) return 'flat';
    return delta > 0 ? 'high' : 'low';
  }

  return (
    <li className={s.cell}>
      <header className={s.cellHeader}>
        <span className={s.attrName} title={attr.name}>
          {attr.name}
        </span>
        <span
          className={s.avg}
          title={`Across ${(attr.selTotal + attr.baseTotal).toLocaleString()} spans, ${pct(avg)} are ${selectionNoun}`}
        >
          overall {pct(avg)} {selectionNoun}
        </span>
      </header>
      <ul className={s.valueList}>
        {visibleRows.map((row) => {
          const highlight = classifyRow(row);
          return (
            <li
              key={row.value}
              className={`${s.valueRow} ${s[`row_${highlight}`]}`}
            >
              <span className={s.valueLabel} title={row.value}>
                {row.value}
              </span>
              <RateBar rate={row.selectionRate} highlight={highlight} />
              <span className={s.rateText}>{pct(row.selectionRate)}</span>
              <span className={s.counts}>
                {row.total.toLocaleString()} total · {row.selN.toLocaleString()}{' '}
                {selectionNoun}
              </span>
              <button
                type="button"
                className={s.searchBtn}
                onClick={() => onPickValue(attr.name, row.value)}
                title={`Open Search filtered to ${attr.name} = ${row.value}`}
              >
                Search →
              </button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className={s.toggle}
          onClick={() => setExpanded(true)}
        >
          Show {hidden} more value{hidden === 1 ? '' : 's'}
        </button>
      )}
      {expanded && (
        <button
          type="button"
          className={s.toggle}
          onClick={() => setExpanded(false)}
        >
          Show fewer
        </button>
      )}
    </li>
  );
}

export default function SpotlightPanel({
  diff,
  onPickValue,
  loading,
  options,
  selectionNoun = 'matching',
  caption,
}: Props) {
  const ranked = useMemo(
    () => computeSpotlight(diff, options),
    [diff, options],
  );

  if (loading && ranked.length === 0) {
    return (
      <div className={s.placeholder}>
        Computing Spotlight — measuring {selectionNoun} rate for each
        attribute; results appear as queries return…
      </div>
    );
  }
  if (ranked.length === 0) {
    return (
      <div className={s.placeholder}>
        No attribute partitions the {selectionNoun} spans from the rest
        — they're spread evenly. The issue isn't correlated with any
        single dimension Spotlight knows about. Try widening the
        lookback, or look for a time-based pattern.
      </div>
    );
  }

  const defaultCaption = `For each attribute, the bar shows what fraction of spans with that value are ${selectionNoun}. Attributes are sorted by how much that rate varies across values — high variance is where the signal is. Click Search next to a value to open Traces filtered to its spans.`;

  return (
    <div className={s.panel} aria-label="Spotlight panel">
      <p className={s.caption}>{caption ?? defaultCaption}</p>
      <ul className={s.grid}>
        {ranked.map((attr) => (
          <AttrCard
            key={attr.name}
            attr={attr}
            selectionNoun={selectionNoun}
            onPickValue={onPickValue}
          />
        ))}
      </ul>
    </div>
  );
}
