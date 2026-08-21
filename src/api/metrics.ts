/**
 * Metrics query client for the fast Cribl PromQL store.
 *
 * Re-exported from the shared framework (`@criblio/app-utils/metrics`, the
 * same client the Ubiquiti app is built on). These queries hit a
 * synchronous `searchJobSource=metrics` endpoint that returns NDJSON
 * immediately — they do NOT spawn a search job, so they stay off the
 * worker pool and return in ~ms. This is the read path the
 * `$vt_results` → metrics migration is built on; see
 * `docs/metrics-migration-plan.md`.
 *
 * Import from this module (not the framework root barrel) — the barrel
 * pulls the provisioner → `node:fs` and breaks in browser code. The
 * framework subpath `@criblio/app-utils/metrics` is browser-safe.
 *
 * NOTE: read-time aggregations verified live (2026-07-23): `rate`,
 * `sum by`, `topk`, `histogram_quantile`, scalar math. `label_replace`
 * and vector `or` are NOT supported (core PromQL only). The write path
 * (`export to metrics` from OTel spans) is a forthcoming-platform
 * dependency, so no `criblapm_*` series exist yet — readers must degrade
 * gracefully until they do.
 */
export {
  METRICS_DATASET,
  runMetricsQuery,
  queryRange,
  queryInstant,
  listMetricMetadata,
  listLabels,
  listSeries,
  listSearchDatasets,
  type MetricsQueryOptions,
  type MetricSample,
  type MetricSeries,
  type MetricMetadata,
  type SearchDatasetInfo,
} from '@criblio/app-utils/metrics';

/**
 * Pick a range-query `step` (seconds) that yields ~`targetBuckets`
 * points across a relative lookback like `-15m` / `-24h` / `-7d`, so
 * metric line charts get useful resolution without over-fetching.
 * Falls back to 60s when the range can't be parsed.
 */
export function stepForRange(range: string, targetBuckets = 60): number {
  const m = /^-(\d+)([smhd])$/.exec(range.trim());
  if (!m) return 60;
  const n = Number(m[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  const seconds = n * unit;
  const step = Math.round(seconds / targetBuckets);
  return Math.max(1, step);
}
