/**
 * App settings stored in the app-scoped KV store, read and written
 * through the framework's `/settings` module at APM's own key. Keeps the
 * helpers out of a component file so the react-refresh rule holds.
 *
 * Every deployed APM keeps its settings under `settings/app` (not the
 * framework default `settings`), and `scripts/provision.ts` reads them from
 * there, so the key is passed explicitly on every call.
 *
 * Absence (the store's own `{"message":"Key not found"}` 404) is "nothing
 * saved yet" and reads as `{}`. Anything else — notably an HTML 404 from an
 * unmatched route or rejected session — throws `KvError`, and the merge in
 * `saveAppSettings` aborts on it without writing: substituting `{}` there
 * would replace every persisted setting with whatever partial was being
 * saved. Both rules are the framework's (`loadSettings` /
 * `saveSettings(..., { merge: true })`).
 */
import {
  loadSettings,
  saveSettings,
  type AppSettings as FrameworkSettings,
} from '@criblio/app-utils/settings';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import { setSearchCadence } from '@criblio/app-utils/cadence';
import type { SourceRepo } from './investigationTransport';
import { setStreamFilterEnabled } from './streamFilter';
import { setLowVolumeMode } from './lowVolumeMode';
import { setMetricsRead } from './metricsRead';
import { setMetricsEmit } from './metricsEmit';
import { setServerInvestigations } from './serverInvestigations';

export const SETTINGS_KEY = 'settings/app';

export interface AppSettings {
  dataset?: string;
  /**
   * When true, Home "Slowest trace classes" and Search results hide
   * long-poll / idle-wait traces (see api/streamFilter.ts). Default
   * true; stored here so the user's choice persists across sessions.
   */
  filterLongPollTraces?: boolean;
  /** How often panel-cache scheduled searches run. Controls detection
   *  lag for the alerts panel. Default '5m'. */
  searchCadence?: string;
  /** Per-rule disable map. Keys are rule IDs from DEFAULT_FILTER_RULES;
   *  value `true` means "disable this rule on Home". Missing/false
   *  means "rule is enabled" (the default). */
  disabledFilterRules?: Record<string, boolean>;
  /** Low-volume mode: when true, the alert evaluator includes an
   *  additional `>=2 errors AND >=1% rate` arm for services whose
   *  traffic is too thin to clear the production thresholds. Off by
   *  default; re-provision after toggling so the alert search picks
   *  up the new KQL. See ROADMAP §P1.2. */
  lowVolumeMode?: boolean;
  /** Metrics emit (M3): when true, the provisioner includes the
   *  span-derived metric emitter scheduled searches (`criblapm__metric_*`)
   *  that `export to metrics` into the fast PromQL store. On by default;
   *  re-provision after toggling (the emit KQL is baked in at creation).
   *  See docs/metrics-migration-plan.md. */
  metricsEmit?: boolean;
  /** Metrics read (M2): when true, RED panels try the fast metrics
   *  store first and fall back to $vt_results / live. On by default;
   *  read per-render, so no re-provision needed to toggle. */
  metricsRead?: boolean;
  /** Server-side investigations: when true, firing alerts trigger an
   *  autonomous investigation on the server-side investigator cell, and
   *  the Alerts page shows investigation badges/drill-ins. Off by
   *  default (dark). Provision-time for the trigger search (re-provision
   *  after toggling). Design: docs/research/server-investigations/design.md. */
  serverInvestigations?: boolean;
  /** Source repos the server-side agent may check out to inspect code
   *  when telemetry narrows to a service. Threaded into interactive
   *  investigations; `service: '*'`/omitted = monorepo catch-all. */
  sourceRepos?: SourceRepo[];
  [k: string]: unknown;
}

/** Pre-v0.12 settings that were exposed without a runtime consumer.
 *  Every save removes them from the stored object. */
const RETIRED_KEYS = ['alertNotificationTargets', 'forceUserOriginators', 'forceServiceOriginators'] as const;

/** The saved settings; `{}` when nothing has been saved. Throws `KvError`
 *  when the read did not reach the store. */
export async function loadAppSettings(): Promise<AppSettings> {
  // No defaults: the framework's own `{ dataset: 'otel' }` default would
  // read as a saved dataset. APM's defaults live in each flag's store.
  const settings = await loadSettings({} as FrameworkSettings, { key: SETTINGS_KEY });
  return settings as AppSettings;
}

/**
 * Persist app settings to the KV store, shallow-merged over whatever is
 * stored so fields this caller does not know about survive. A failed or
 * misrouted read aborts with `KvError` and writes nothing.
 */
export async function saveAppSettings(partial: AppSettings): Promise<void> {
  const next: Record<string, unknown> = { ...partial };
  // An `undefined` field is dropped by the JSON write, so naming the
  // retired keys here deletes them from the merged object.
  for (const key of RETIRED_KEYS) next[key] = undefined;
  await saveSettings(next as FrameworkSettings, { key: SETTINGS_KEY, merge: true });
}

/**
 * Push loaded settings into the module-level stores the app reads.
 * Called by DatasetProvider once the KV read resolves.
 *
 * Each flag is applied only when the stored value says so, so a missing
 * field keeps that flag's own default: the stream filter turns off only
 * on an explicit `false`, low-volume mode turns on only on an explicit
 * `true`, and the metrics and server-investigation flags take any stored
 * boolean.
 */
export function applyAppSettings(settings: AppSettings | null): void {
  if (!settings || typeof settings !== 'object') return;
  const ds = settings.dataset;
  if (ds && typeof ds === 'string' && ds.trim()) {
    setCurrentDataset(ds.trim());
  }
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

/**
 * `<DatasetProvider loadDataset>`: ONE read of `settings/app` that applies
 * every saved flag and hands the dataset back to the framework provider,
 * which sets it and records a failure for `useDatasetLoadError()` (a
 * rejection here leaves every default in place and is reported through
 * the provider's `onError`, or logged). Reading the key a second time for
 * the flags would race two loads of the same object.
 */
export async function loadDatasetAndApplySettings(): Promise<string | undefined> {
  const settings = await loadAppSettings();
  applyAppSettings(settings);
  return typeof settings.dataset === 'string' ? settings.dataset : undefined;
}
