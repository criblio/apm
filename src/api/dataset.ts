/**
 * Module-level current dataset + simple pub/sub.
 *
 * The dataset name is threaded into every KQL query (see queries.ts). It's
 * kept in a module-level variable rather than prop-drilled because:
 *   - It's read by the query builders, which run inside non-React code
 *     (api/search.ts verbs invoked from useEffect callbacks).
 *   - It changes rarely (via the Settings page) and triggers a coordinated
 *     re-fetch across many open components.
 *
 * Components that should re-fetch when the dataset changes can subscribe
 * via the useDataset() hook (exposed in src/hooks/useDataset.ts) which
 * plugs this into React's useSyncExternalStore.
 */

let currentDataset = 'otel';
const listeners = new Set<() => void>();

/** Current active dataset name (never empty). */
export function getCurrentDataset(): string {
  return currentDataset || 'otel';
}

/**
 * Set the current dataset and notify all subscribers. Typically called
 * from DatasetProvider after it loads the saved value from the KV store
 * or after the user picks a new value on the Settings page.
 */
export function setCurrentDataset(name: string): void {
  const next = (name || 'otel').trim();
  if (next === currentDataset) return;
  currentDataset = next;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors shouldn't block others */
    }
  }
}

/** Subscribe to dataset changes. Returns an unsubscribe function. */
export function subscribeDataset(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
