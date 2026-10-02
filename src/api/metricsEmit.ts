/**
 * Metrics-emit gate (provision-time). When ON, `getProvisioningPlan()`
 * includes the span-derived metric emitter scheduled searches
 * (`criblapm__metric_*`) that `export to metrics` into the fast PromQL
 * store. ON by default: the RED panels read from that store first (see
 * `metricsRead.ts` and `docs/metrics-migration-plan.md`). Set
 * `metricsEmit: false` in the app's KV settings and re-provision to stop.
 *
 * A framework `createStore`, like lowVolumeMode.ts:
 * read at provision time by scripts/provision.ts and at page boot by
 * DatasetProvider from the app's KV settings. Because the emitter
 * KQL is baked into the scheduled search at creation, toggling requires a
 * re-provision to take effect — same contract as lowVolumeMode.
 */

import { createStore } from '@criblio/app-utils/store';

/** ON by default (owner decision): the RED panels read from the emitted store first. */
export const metricsEmitStore = createStore(true);

export const getMetricsEmit = metricsEmitStore.get;
export const setMetricsEmit = metricsEmitStore.set;
export const subscribeMetricsEmit = metricsEmitStore.subscribe;
