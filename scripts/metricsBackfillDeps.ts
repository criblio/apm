/**
 * Node deps for the metrics backfill (src/api/metricsBackfill.ts), used by
 * scripts/provision.ts on `npm run deploy`. Runs the identical framework
 * algorithm as the Settings UI; only the transport differs:
 *   - runExport / span counts → search jobs through the provisioner's
 *     Node HttpClient (it hands NDJSON bodies back as text, which the
 *     framework search-job runner parses)
 *   - earliestCoveredSec      → the metrics store, through the framework's
 *     Node metrics transport (`createNodeMetricsTransport`: same cached
 *     Bearer token, fetched per query; a non-2xx response throws)
 *
 * A failing coverage probe throws (and stops the backfill) rather than
 * reading as "uncovered": re-emitting a covered family doubles it.
 */
import type { OAuthConfig } from '@criblio/app-utils/auth';
import {
  createMetricsCoverageProbe,
  runMetricsExport,
} from '@criblio/app-utils/metrics-backfill';
import { createNodeMetricsTransport, type HttpClient } from '@criblio/app-utils/provisioner';
import {
  makeApmPlanWindows,
  type ApmBackfillDeps,
  type BackfillEmitter,
} from '../src/api/metricsBackfill.js';

/** Build the injected backfill deps backed by the Search job API. */
export function makeNodeBackfillDeps(
  http: HttpClient,
  oauth: OAuthConfig,
  log: (msg: string) => void,
): ApmBackfillDeps {
  return {
    log,
    runExport: (query, earliestMs, latestMs) => runMetricsExport(http, query, earliestMs, latestMs),
    earliestCoveredSec: createMetricsCoverageProbe<BackfillEmitter>({
      transport: createNodeMetricsTransport(oauth),
    }),
    planWindows: makeApmPlanWindows(http),
  };
}
