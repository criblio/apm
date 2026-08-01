/**
 * Boot-time feature detection — does the otel dataset have the
 * flattened acceleration fields populated?
 *
 * If the dataset-ruleset is configured + acceleratedFields are set
 * (see src/api/datasetProvisioner.ts), each span lands with
 * `service_name` and `status_code` as top-level columns. Queries
 * that read them get filter/group-by pushdown — measured at
 * 1.2-2.3× faster than dotted-path equivalents.
 *
 * If the user hasn't provisioned yet, the flat fields are null
 * and we fall back to the original dotted-path queries. The app
 * works correctly in both states; only speed differs.
 *
 * The probe runs once per session (cached) and gates the query
 * builders' choice between flat and dotted paths. Boot-time
 * detection avoids forcing every query call site to probe — they
 * just read a sync value.
 */
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import { runQuery } from './cribl';
import { kqlDatasetId } from './kqlSafety';

/** Guard against injection when embedding the runtime dataset name
 *  in a query literal. Same character-class the query builders use.
 *  Empty string is not valid here — callers must check upstream. */
function safeDataset(): string {
  return kqlDatasetId(getCurrentDataset());
}

const cachedByDataset = new Map<string, Promise<boolean>>();

/**
 * Feature detection is session-scoped and idempotent, not tied to any
 * one page. Give the probe a signal that never aborts so a navigation
 * can't cancel it mid-flight — an aborted probe would otherwise cache
 * `false` and force every live-KQL fallback onto the slow dotted path
 * for the rest of the session.
 */
const NEVER_ABORT = new AbortController().signal;

/**
 * Probe the otel dataset for a single span and check whether
 * `service_name` and `status_code` are populated at the top level.
 * Returns true if both are present (acceleration in effect),
 * false otherwise (the user hasn't run the dataset provisioner
 * yet, or the data is older than the ruleset change).
 *
 * Cached per session. Never throws — fetch / parse failures
 * return false so callers safely default to the dotted path.
 */
export function flatFieldsAvailable(): Promise<boolean> {
  const dataset = safeDataset();
  let cached = cachedByDataset.get(dataset);
  if (!cached) {
    cached = (async () => {
      try {
        const rows = await runQuery(
          `dataset="${dataset}" | where isnotnull(end_time_unix_nano) | take 1 | project sn=service_name, sc=status_code`,
          '-10m',
          'now',
          1,
          NEVER_ABORT,
        );
        const r = rows[0] as { sn?: unknown; sc?: unknown } | undefined;
        return !!(r && r.sn != null && r.sc != null);
      } catch {
        return false;
      }
    })();
    cachedByDataset.set(dataset, cached);
  }
  return cached;
}

/** Force a re-detect on the next call. Used after the user runs
 * the provisioner from Settings — they want the app to pick up
 * the new acceleration state without a page reload. */
export function resetFlatFieldsCache(): void {
  cachedByDataset.clear();
}
