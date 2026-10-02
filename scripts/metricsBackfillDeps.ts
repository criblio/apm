/**
 * Node deps for the metrics backfill (src/api/metricsBackfill.ts), used by
 * scripts/provision.ts on `npm run deploy`. Runs the identical framework
 * algorithm as the Settings UI; only the transport differs:
 *   - runExport / span counts → search jobs through the provisioner's
 *     Node HttpClient (it hands NDJSON bodies back as text, which the
 *     framework search-job runner parses)
 *   - earliestCoveredSec      → the metrics store, through a Node
 *     MetricsTransport authenticated with the same cached Bearer token
 *
 * A failing coverage probe throws (and stops the backfill) rather than
 * reading as "uncovered": re-emitting a covered family doubles it.
 */
import { getCachedBearerToken, type OAuthConfig } from '@criblio/app-utils/auth';
import { metricsQueryPath, type MetricsTransport } from '@criblio/app-utils/metrics';
import {
  createMetricsCoverageProbe,
  runMetricsExport,
} from '@criblio/app-utils/metrics-backfill';
import type { HttpClient } from '@criblio/app-utils/provisioner';
import {
  makeApmPlanWindows,
  type ApmBackfillDeps,
  type BackfillEmitter,
} from '../src/api/metricsBackfill.js';

/** GET the metrics query endpoint with a Bearer token; returns raw NDJSON. */
function nodeMetricsTransport(oauth: OAuthConfig): MetricsTransport {
  const apiBase = `${oauth.baseUrl.replace(/\/$/, '')}/api/v1`;
  return async (query, opts) => {
    const token = await getCachedBearerToken(oauth);
    const resp = await fetch(`${apiBase}${metricsQueryPath(query, opts)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`metrics query failed (${resp.status}): ${text.slice(0, 300)}`);
    return text;
  };
}

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
      transport: nodeMetricsTransport(oauth),
    }),
    planWindows: makeApmPlanWindows(http),
  };
}
