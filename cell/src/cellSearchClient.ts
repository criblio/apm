/**
 * The cell's implementation of the app's SearchClient seam
 * (src/api/searchClient.ts) — what makes the browser Investigator's
 * tool executors run server-side unchanged.
 *
 * No metrics-first path (that's a browser-session optimization; the
 * cell always uses live KQL), and flat-fields support is probed once
 * per client with the same field check featureDetect.ts uses.
 */
import type { SearchClient } from '../../src/api/searchClient';
import { kqlDatasetId } from '@cribl/app-utils/kql';
import type { CriblClient } from './criblClient';

export function createCellSearchClient(cribl: CriblClient): SearchClient {
  let flatFieldsProbe: Promise<boolean> | null = null;

  return {
    runQuery: (kql, earliest, latest, limit) =>
      cribl.runQuery(kql, earliest, latest, limit ?? 200),

    flatFields() {
      if (!flatFieldsProbe) {
        flatFieldsProbe = (async () => {
          try {
            const ds = kqlDatasetId(cribl.dataset);
            const rows = await cribl.runQuery(
              `dataset=${JSON.stringify(ds)} | limit 1 | project service_name, status_code`,
              '-15m',
              'now',
              1,
            );
            const row = rows[0];
            return Boolean(row && row.service_name != null && row.status_code != null);
          } catch {
            // Dotted paths always work; flat fields are only a speedup.
            return false;
          }
        })();
      }
      return flatFieldsProbe;
    },

    serviceSummariesViaMetrics: async () => null,
    metricsReadEnabled: () => false,
  };
}
