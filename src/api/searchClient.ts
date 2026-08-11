/**
 * Injection seam between APM's query layer and the environment that
 * executes searches.
 *
 * The query verbs in search.ts (and everything built on them — the
 * Investigator tool executors, the anomaly preflight) historically
 * bound directly to the browser runtime: the iframe-proxied
 * `runQuery`, the session-cached flat-fields probe, and the
 * metrics-read Settings flag. That binding is invisible in the
 * browser but blocks any non-browser host (a server-side
 * investigation runtime, a Node harness) from reusing the same
 * verbs. ROADMAP P4.1 calls for keeping this layer
 * transport-agnostic; this interface is that seam.
 *
 * `browserSearchClient` is the default everywhere, so existing call
 * sites keep their exact behavior without churn. A non-browser host
 * supplies its own implementation (its own authenticated query
 * runner, its own feature-detection policy) and passes it through
 * the optional trailing `client` parameters.
 */
import { runQuery } from './cribl';
import { flatFieldsAvailable } from './featureDetect';
import { listServiceSummariesViaMetrics } from './metricsPanels';
import { getMetricsRead } from './metricsRead';
import type { ServiceSummary } from './types';

export interface SearchClient {
  /** Run one KQL search job and return its result rows. */
  runQuery(
    kql: string,
    earliest: string,
    latest: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]>;

  /** Whether the dataset's flattened acceleration fields
   *  (`service_name`, `status_code` as top-level columns) are
   *  available, so query builders can choose the fast paths. */
  flatFields(): Promise<boolean>;

  /** Metrics-first service summaries off the fast metrics store.
   *  Return null to fall through to the live KQL path — a
   *  non-browser host without a metrics reader just returns null. */
  serviceSummariesViaMetrics(
    earliest: string,
    latest: string,
    service?: string,
  ): Promise<ServiceSummary[] | null>;

  /** Whether metrics-read mode is on. When true, an empty/aborted
   *  metrics read must NOT cascade into a live span scan (see
   *  listServiceSummaries for why). */
  metricsReadEnabled(): boolean;
}

/** The browser implementation: the iframe-proxied query runner and
 *  the existing session-scoped probes/flags, unchanged. */
export const browserSearchClient: SearchClient = {
  runQuery,
  flatFields: () => flatFieldsAvailable(),
  serviceSummariesViaMetrics: (earliest, latest, service) =>
    listServiceSummariesViaMetrics(earliest, latest, undefined, service),
  metricsReadEnabled: () => getMetricsRead(),
};
