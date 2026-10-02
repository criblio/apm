/**
 * Browser deps for the metrics backfill (src/api/metricsBackfill.ts) — the
 * Settings UI path. Runs the identical framework algorithm as `npm run
 * deploy` (scripts/metricsBackfillDeps.ts); only the transport differs:
 *   - runExport / span counts → search jobs through the app's fetch proxy
 *     (`createBrowserHttpClient`, which carries no navigation signal)
 *   - earliestCoveredSec      → the fast metrics store (`queryRange`)
 *
 * Backfill exports MUST run to completion: a navigation away must not
 * cancel an in-flight export (a half-written window is a hole the coverage
 * probe cannot see). The framework's `runMetricsExport` takes no signal, and
 * the browser provisioner client never aborts.
 */
import {
  createMetricsCoverageProbe,
  runMetricsExport,
} from '@criblio/app-utils/metrics-backfill';
import { createBrowserHttpClient } from '@criblio/app-utils/provisioner';
import {
  makeApmPlanWindows,
  type ApmBackfillDeps,
  type BackfillEmitter,
} from './metricsBackfill';

export function makeBrowserBackfillDeps(log?: (msg: string) => void): ApmBackfillDeps {
  const http = createBrowserHttpClient();
  return {
    log,
    runExport: (query, earliestMs, latestMs) => runMetricsExport(http, query, earliestMs, latestMs),
    earliestCoveredSec: createMetricsCoverageProbe<BackfillEmitter>(),
    planWindows: makeApmPlanWindows(http),
  };
}
