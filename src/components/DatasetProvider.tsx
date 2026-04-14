/**
 * Loads saved app-level preferences (dataset, stream-filter toggle)
 * from the pack-scoped KV store on mount and pushes them into the
 * relevant modules. Children are rendered immediately (with defaults)
 * so there's no loading gate on first paint — if the KV read succeeds
 * later, the subscribe-notify patterns on each setting trigger
 * re-fetches in any mounted pages.
 *
 * Name retained for backwards compat; it now loads more than just the
 * dataset.
 */
import { useEffect, type ReactNode } from 'react';
import { loadAppSettings } from '../api/appSettings';
import { setCurrentDataset } from '../api/dataset';
import { setStreamFilterEnabled } from '../api/streamFilter';

interface Props {
  children: ReactNode;
}

export default function DatasetProvider({ children }: Props) {
  useEffect(() => {
    let cancelled = false;
    loadAppSettings()
      .then((settings) => {
        if (cancelled) return;
        if (settings && typeof settings === 'object') {
          const ds = settings.dataset;
          if (ds && typeof ds === 'string' && ds.trim()) {
            setCurrentDataset(ds.trim());
          }
          // Explicit check for `=== false` — any undefined / missing
          // value means "keep the default of true".
          if (settings.filterLongPollTraces === false) {
            setStreamFilterEnabled(false);
          }
        }
      })
      .catch(() => {
        // KV unreachable or empty — leave the defaults in place.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <>{children}</>;
}
