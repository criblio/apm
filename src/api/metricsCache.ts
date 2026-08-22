/**
 * Dedup + short-TTL cache for the fast metrics store.
 *
 * The implementation now lives in the shared framework
 * (`@criblio/app-utils/metrics`) alongside the metrics client it wraps.
 * This module re-exports it so existing imports (`./metricsCache`) keep
 * working, and to centralize the browser-safe subpath (the framework
 * root barrel pulls the provisioner → `node:fs`; the `./metrics` subpath
 * is browser-safe — same pattern as `src/api/metrics.ts`).
 *
 * Why the cache exists: idempotent metrics reads shouldn't be cancelled
 * on rapid re-navigation — the PromQL engine keeps computing an aborted
 * query, so cancel-and-refire piles abandoned computations on and page
 * latency escalates. Instead we dedupe + briefly cache; the page-level
 * `captureQueryGeneration()` guard drops any late fill. See the
 * framework module for the full rationale.
 */
export {
  cachedQueryInstant,
  cachedQueryRange,
  clearMetricsCache,
} from '@criblio/app-utils/metrics';
