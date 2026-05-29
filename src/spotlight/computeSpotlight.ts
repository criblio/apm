/**
 * Spotlight engine — turns raw per-attribute (sel_n, base_n) buckets
 * into a ranked list of attributes whose values have meaningfully
 * different SELECTION RATES.
 *
 * The metric the UI cares about is per-value selection rate —
 * "of all spans with this value, what fraction are in the selection?"
 * On Service Detail with selection = error spans, that's the per-
 * value error rate. On Traces with selection = the user's filter,
 * it's "what fraction of spans with this value match the filter?"
 *
 * Same shape, intuitive interpretation: a bar whose width IS the
 * rate. The Operations table on Service Detail uses the same metric
 * for `name` — Spotlight just generalizes it to every attribute the
 * cluster has data for.
 *
 * Attributes are ranked by VARIANCE in selection rate across their
 * values, weighted by volume. Uniform attributes (every value has
 * roughly the same rate) tell the user nothing and get filtered out.
 * High-variance attributes — where some values are mostly in the
 * selection and others mostly aren't — are the diagnostic signal.
 *
 * Inputs are pure — a Map from `getSpotlightDiff()` — so the engine
 * is unit-testable against fixtures without touching the network.
 */

import type { SpotlightBucket } from '../api/types';

/** One value's contribution: how often does the selection include it? */
export interface SpotlightValueRow {
  /** The attribute value (e.g. "200", "checkoutservice"). */
  value: string;
  /** Spans with this value that ARE in the selection. */
  selN: number;
  /** Spans with this value that are NOT in the selection. */
  baseN: number;
  /** selN + baseN. */
  total: number;
  /** selN / total, 0..1. The headline metric. */
  selectionRate: number;
}

/** A scored attribute group with its rows sorted by selection rate. */
export interface SpotlightAttribute {
  /** Attribute name (e.g. "http.status_code"). */
  name: string;
  /** Rows sorted by selectionRate desc (highest rate first). */
  rows: SpotlightValueRow[];
  /**
   * Score for cross-attribute ranking. Higher = more diagnostic
   * signal. Uses the weighted standard deviation of selection rate
   * across rows, with row weights = total volume. An attribute where
   * every value has a similar selection rate gets a low score (the
   * failure isn't correlated with this attribute); an attribute where
   * some values are mostly errors and others mostly aren't gets a
   * high score (this attribute partitions the failure).
   */
  score: number;
  /** Total spans in the selection across all rows. */
  selTotal: number;
  /** Total spans in the baseline across all rows. */
  baseTotal: number;
  /** Average selection rate across rows (volume-weighted). Useful
   *  for headline copy: "average X% of spans with this attribute
   *  are in the selection." */
  overallRate: number;
}

export interface ComputeOptions {
  /**
   * Minimum total observations (sel + base) for a value to count.
   * Values seen only once or twice give noisy rates; we drop them
   * to avoid promoting one-shot outliers. Default 5.
   */
  minTotal?: number;
  /**
   * Drop attributes whose score is below this threshold — they're
   * uniform enough to be noise. Default 0.03 — roughly "at least
   * one value's rate is 3+ percentage points away from the average
   * with meaningful volume behind it."
   */
  minScore?: number;
  /** Cap rows per attribute in the output. Default 10. */
  maxRowsPerAttr?: number;
}

const DEFAULTS: Required<ComputeOptions> = {
  minTotal: 5,
  // With score = stddev * log1p(volume): a 5%-spread at 100 spans
  // gives ~0.05 * log1p(100) ≈ 0.05 * 4.6 ≈ 0.23. A 30%-spread at
  // 1000 spans gives ~0.30 * 6.9 ≈ 2.07. Setting the floor at 0.5
  // requires either a meaningful spread or a meaningful volume —
  // pure noise stays below.
  minScore: 0.5,
  maxRowsPerAttr: 10,
};

/**
 * Score = max over rows of |row.rate - overall.rate| * log1p(row.total).
 *
 * The L∞ norm of the per-value rate deviation captures "the value
 * whose rate is furthest from the average," which matches the
 * question Spotlight is trying to answer: WHICH value is dominating
 * (or absent from) the selection. The log(volume) factor weights
 * each row's contribution by its evidence — a 100% rate on 5 spans
 * is weaker than a 100% rate on 5,000.
 *
 * Volume-weighted stddev is mathematically nicer but here it
 * under-counts the case where one tiny-but-extreme value is the
 * actual signal among many uniform ones — which is the typical
 * "one pod is broken" / "rpc.grpc.status_code == 13" scenario.
 */
function scoreAttribute(
  rows: readonly SpotlightValueRow[],
  overallRate: number,
): number {
  let best = 0;
  for (const r of rows) {
    if (r.total <= 0) continue;
    const deviation = Math.abs(r.selectionRate - overallRate);
    const candidate = deviation * Math.log1p(r.total);
    if (candidate > best) best = candidate;
  }
  return best;
}

/**
 * Compute Spotlight rankings from the raw differential buckets.
 *
 * Result is sorted attributes-first by score desc, then within each
 * attribute by selectionRate desc (most-in-selection values first,
 * so the "100% errors" rows bubble to the top of their card). Empty
 * or uniform attributes are dropped.
 */
export function computeSpotlight(
  diff: Map<string, SpotlightBucket[]>,
  opts: ComputeOptions = {},
): SpotlightAttribute[] {
  const { minTotal, minScore, maxRowsPerAttr } = { ...DEFAULTS, ...opts };

  const out: SpotlightAttribute[] = [];

  for (const [name, buckets] of diff.entries()) {
    let selTotal = 0;
    let baseTotal = 0;
    const rows: SpotlightValueRow[] = [];

    for (const b of buckets) {
      const total = b.selN + b.baseN;
      if (total < minTotal) continue;
      selTotal += b.selN;
      baseTotal += b.baseN;
      rows.push({
        value: b.attrValue,
        selN: b.selN,
        baseN: b.baseN,
        total,
        selectionRate: total > 0 ? b.selN / total : 0,
      });
    }
    if (rows.length === 0) continue;

    const grandTotal = selTotal + baseTotal;
    if (grandTotal === 0) continue;
    const overallRate = selTotal / grandTotal;

    const score = scoreAttribute(rows, overallRate);
    if (score < minScore) continue;

    rows.sort((a, b) => b.selectionRate - a.selectionRate);

    out.push({
      name,
      rows: rows.slice(0, maxRowsPerAttr),
      score,
      selTotal,
      baseTotal,
      overallRate,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
