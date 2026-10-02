/**
 * Loads APM's saved preferences (dataset, stream filter, cadence and the
 * feature flags) from the KV store on mount and pushes them into the
 * module-level stores (`syncAppSettings` in api/appSettings.ts).
 * Children render immediately with defaults — no loading gate on first paint — and the
 * stores' subscribers re-fetch when the saved values land.
 *
 * Why this is not the framework's `/dataset-provider` `DatasetProvider`:
 * that component loads the dataset from the framework's fixed `settings`
 * key, and APM's settings live under `settings/app`. Mounting it would
 * race a read of the wrong key against this one and could reset a saved
 * dataset to the default. What it adds is adopted here instead:
 *
 *   - the default is in the store before any child renders (APM sets it
 *     at module scope, which is earlier still);
 *   - a failed load is no longer silent: it is recorded in the
 *     framework's dataset load-error store, so `useDatasetLoadError()`
 *     (Settings page) can show it, passed to `onError` when given, and
 *     logged otherwise. The next successful load clears it.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { SETTINGS_LOAD_WARNING, syncAppSettings } from '../api/appSettings';
import { setCurrentDataset } from '@criblio/app-utils/dataset';

// Synchronous module-scope default. The framework's dataset store
// initializes to '' — any query builder that runs before the async
// KV load below completes (ProvisioningBanners' planOnly check,
// first page queries) would otherwise emit `dataset=""` and either
// return zero rows or report every saved search as needing update.
setCurrentDataset('otel');

interface Props {
  /** Called when the saved settings cannot be loaded. Defaults stay in place. */
  onError?: (err: Error) => void;
  children: ReactNode;
}

export default function DatasetProvider({ onError, children }: Props) {
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    void syncAppSettings({
      isCancelled: () => cancelled,
      // Read through the ref at failure time, so the latest prop is used.
      onError: (err) => {
        const report = onErrorRef.current;
        if (report) report(err);
        else console.warn(SETTINGS_LOAD_WARNING, err);
      },
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <>{children}</>;
}
