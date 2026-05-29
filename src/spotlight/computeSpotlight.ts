/**
 * Spotlight engine — turns raw per-attribute (sel_n, base_n) buckets
 * into a ranked list of "interesting" attributes for the panel.
 *
 * The shape mirrors Honeycomb's BubbleUp: for each attribute the user
 * could facet by, compute how each value's share inside the selection
 * differs from its share in the baseline. Attributes where one value
 * is strongly over- or under-represented bubble to the top; attributes
 * whose values track the baseline are de-prioritized.
 *
 * Inputs are pure — a Map from `getSpotlightDiff()` — so the engine
 * is unit-testable against fixtures without touching the network.
 */

import type { SpotlightBucket } from '../api/types';

/** A single value's contribution to the differential. */
export interface SpotlightValueRow {
  /** The attribute value (e.g. "200", "checkoutservice"). */
  value: string;
  /** Raw counts in selection / baseline. */
  selN: number;
  baseN: number;
  /** Share of the selection that has this value, 0..1. */
  selShare: number;
  /** Share of the baseline that has this value, 0..1. */
  baseShare: number;
  /** selShare - baseShare. Positive = over-represented in selection. */
  diff: number;
}

/** A scored attribute group with its top-N value rows. */
export interface SpotlightAttribute {
  /** Attribute name (e.g. "http.status_code"). */
  name: string;
  /** Rows sorted by diff desc (most over-represented first). */
  rows: SpotlightValueRow[];
  /** Score used to rank attributes against each other. Higher = more
   *  interesting (a value's share differs strongly between sel and base). */
  score: number;
  /** Total spans in the selection that had ANY value for this attribute. */
  selTotal: number;
  /** Total spans in the baseline that had ANY value for this attribute. */
  baseTotal: number;
}

export interface ComputeOptions {
  /**
   * Minimum total observations (sel + base) for a value to count.
   * Values seen only once or twice produce noisy shares; we drop them
   * to avoid promoting one-shot outliers. Default 3.
   */
  minTotal?: number;
  /**
   * Drop attributes whose top value's |diff| is below this threshold.
   * Default 0.05 (5 percentage points). Lower = noisier ranking, more
   * "meh" attributes promoted.
   */
  minTopDiff?: number;
  /** Cap rows per attribute in the output. Default 10. */
  maxRowsPerAttr?: number;
}

const DEFAULTS: Required<ComputeOptions> = {
  minTotal: 3,
  minTopDiff: 0.05,
  maxRowsPerAttr: 10,
};

/**
 * Score one attribute. The score we use is the max |diff| across its
 * rows, weighted by the log of the value's total volume so a tiny
 * value with a huge relative skew doesn't out-rank a high-volume
 * value with a moderate skew.
 *
 * Equivalent to the L∞ norm of the per-value (volume-weighted) diff
 * vector. Cheap to compute, easy to reason about, and matches how
 * humans scan the panel — "show me the attribute whose biggest bar
 * is biggest."
 */
function scoreAttribute(rows: SpotlightValueRow[]): number {
  let best = 0;
  for (const r of rows) {
    const total = r.selN + r.baseN;
    if (total <= 0) continue;
    const weight = Math.log1p(total);
    const candidate = Math.abs(r.diff) * weight;
    if (candidate > best) best = candidate;
  }
  return best;
}

/**
 * Compute Spotlight rankings from the raw differential buckets.
 *
 * The result is sorted attributes-first by score desc, then within
 * each attribute by diff desc (over-represented values first). Empty
 * attributes — those that pass nothing after `minTotal` / `minTopDiff`
 * filtering — are dropped. Callers can rely on the returned array being
 * already in display order.
 */
export function computeSpotlight(
  diff: Map<string, SpotlightBucket[]>,
  opts: ComputeOptions = {},
): SpotlightAttribute[] {
  const { minTotal, minTopDiff, maxRowsPerAttr } = { ...DEFAULTS, ...opts };

  const out: SpotlightAttribute[] = [];

  for (const [name, buckets] of diff.entries()) {
    // Compute denominators across all of this attr's values. We treat
    // "values seen anywhere for this attribute" as the universe so a
    // value present only in selection still gets a baseline share of 0
    // (vs the broader span total that would have null/empty values).
    let selTotal = 0;
    let baseTotal = 0;
    for (const b of buckets) {
      selTotal += b.selN;
      baseTotal += b.baseN;
    }
    if (selTotal === 0 && baseTotal === 0) continue;

    const rows: SpotlightValueRow[] = [];
    for (const b of buckets) {
      const total = b.selN + b.baseN;
      if (total < minTotal) continue;
      const selShare = selTotal > 0 ? b.selN / selTotal : 0;
      const baseShare = baseTotal > 0 ? b.baseN / baseTotal : 0;
      rows.push({
        value: b.attrValue,
        selN: b.selN,
        baseN: b.baseN,
        selShare,
        baseShare,
        diff: selShare - baseShare,
      });
    }
    if (rows.length === 0) continue;

    rows.sort((a, b) => b.diff - a.diff);

    // Quick prune: if even the top row's |diff| is below threshold,
    // the whole attribute is uninteresting.
    const topAbsDiff = Math.max(
      Math.abs(rows[0].diff),
      Math.abs(rows[rows.length - 1].diff),
    );
    if (topAbsDiff < minTopDiff) continue;

    const capped = rows.slice(0, maxRowsPerAttr);
    out.push({
      name,
      rows: capped,
      score: scoreAttribute(capped),
      selTotal,
      baseTotal,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
