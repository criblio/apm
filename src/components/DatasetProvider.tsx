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
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { setStreamFilterEnabled } from '../api/streamFilter';
import { setLowVolumeMode } from '../api/lowVolumeMode';
import { setMetricsRead } from '../api/metricsRead';
import { setMetricsEmit } from '../api/metricsEmit';
import { setServerInvestigations } from '../api/serverInvestigations';
import { setSearchCadence } from '@cribl/app-utils/cadence';

// Synchronous module-scope default. The framework's dataset store
// initializes to '' — any query builder that runs before the async
// KV load below completes (ProvisioningBanners' planOnly check,
// first page queries) would otherwise emit `dataset=""` and either
// return zero rows or report every saved search as needing update.
// React effect ordering can't fix this (child effects run before
// this provider's effect), so the default is applied at import time.
setCurrentDataset('otel');

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
          if (settings.searchCadence && typeof settings.searchCadence === 'string') {
            setSearchCadence(settings.searchCadence);
          }
          if (settings.lowVolumeMode === true) {
            setLowVolumeMode(true);
          }
          if (typeof settings.metricsRead === 'boolean') {
            setMetricsRead(settings.metricsRead);
          }
          if (typeof settings.metricsEmit === 'boolean') {
            setMetricsEmit(settings.metricsEmit);
          }
          if (typeof settings.serverInvestigations === 'boolean') {
            setServerInvestigations(settings.serverInvestigations);
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
