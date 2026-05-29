import { useMemo } from 'react';
import type { AttrValueBucket } from '../api/types';
import s from './FacetPanel.module.css';

interface Props {
  /** Result of getFacetDistribution(): one entry per attribute. */
  distribution: Map<string, AttrValueBucket[]>;
  /** When the user clicks a value chip, surface (attr, value) to the
   *  parent so it can append a new FilterRow. */
  onPickValue: (attr: string, value: string) => void;
  loading?: boolean;
  /** Hide attributes with this many values or fewer. Useful for
   *  collapsing low-cardinality attrs (e.g. always one rpc.system). */
  hideSingletons?: boolean;
}

interface AttrGroup {
  name: string;
  rows: AttrValueBucket[];
  total: number;
}

export default function FacetPanel({
  distribution,
  onPickValue,
  loading,
  hideSingletons,
}: Props) {
  const groups = useMemo<AttrGroup[]>(() => {
    const out: AttrGroup[] = [];
    for (const [name, rows] of distribution.entries()) {
      if (hideSingletons && rows.length <= 1) continue;
      const total = rows.reduce((acc, r) => acc + r.n, 0);
      if (total === 0) continue;
      out.push({ name, rows, total });
    }
    // Order: most-distinct-values first. Gives the user the
    // "highest cardinality" attributes — likely candidates for
    // narrowing the search — at the top.
    out.sort((a, b) => b.rows.length - a.rows.length);
    return out;
  }, [distribution, hideSingletons]);

  if (loading) {
    return <div className={s.placeholder}>Loading facets…</div>;
  }
  if (groups.length === 0) {
    return (
      <div className={s.placeholder}>
        No facet values found for the current filter.
      </div>
    );
  }

  return (
    <div className={s.panel} aria-label="Facet panel">
      {groups.map((g) => (
        <div key={g.name} className={s.group}>
          <div className={s.groupHeader}>
            <span className={s.attrName}>{g.name}</span>
            <span className={s.attrCount}>{g.rows.length} values</span>
          </div>
          <ul className={s.values}>
            {g.rows.map((row) => {
              const pct = g.total > 0 ? row.n / g.total : 0;
              return (
                <li key={row.attrValue} className={s.valueRow}>
                  <button
                    type="button"
                    className={s.valueBtn}
                    onClick={() => onPickValue(g.name, row.attrValue)}
                    title={`Filter to ${g.name} = ${row.attrValue}`}
                  >
                    <span className={s.valueLabel}>{row.attrValue}</span>
                    <span className={s.valueCount}>
                      {row.n.toLocaleString()}
                    </span>
                  </button>
                  <div
                    className={s.bar}
                    style={{ width: `${(pct * 100).toFixed(1)}%` }}
                    aria-hidden
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
