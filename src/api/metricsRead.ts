/**
 * Metrics-read gate (runtime). When ON, RED panels try the fast metrics
 * store first (via `metricsPanels.ts`) and fall back to `$vt_results` /
 * live on empty or error. ON by default since the metrics migration's
 * read stage landed (`docs/metrics-migration-plan.md`, "Implemented so
 * far"). Set `metricsRead: false` in the app's KV settings to turn it off
 * instantly (no re-provision) if a panel misbehaves.
 *
 * Unlike `metricsEmit` (baked into scheduled-search KQL at provision
 * time), this is read per-render, so a KV change takes effect without
 * re-provisioning.
 */

import { createStore } from '@criblio/app-utils/store';

/** ON by default (owner decision, metrics migration read stage). */
export const metricsReadStore = createStore(true);

export const getMetricsRead = metricsReadStore.get;
export const setMetricsRead = metricsReadStore.set;
export const subscribeMetricsRead = metricsReadStore.subscribe;
