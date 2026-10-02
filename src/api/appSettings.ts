/**
 * App settings stored in the pack-scoped KV store. Keeps the save/load
 * helpers out of DatasetProvider so the provider file satisfies the
 * react-refresh/only-export-components rule.
 *
 * Built on the framework's strict `/kv` client, but deliberately NOT on
 * the framework's `/settings` module: that one reads and writes the fixed
 * key `settings`, while every deployed APM keeps its settings under
 * `settings/app` (and `scripts/provision.ts` reads them from there). Moving
 * keys would orphan every stored preference, so APM keeps its key.
 *
 * Absence (the store's own `{"message":"Key not found"}` 404) is "nothing
 * saved yet" and yields null. Anything else — notably an HTML 404 from an
 * unmatched route or rejected session — throws `KvError`, and the merge in
 * `saveAppSettings` must abort on it: substituting `{}` there would replace
 * every persisted setting with whatever partial was being saved.
 */
import { kvGetJson, kvPutJson } from '@criblio/app-utils/kv';
import { setCurrentDataset, setDatasetLoadError } from '@criblio/app-utils/dataset';
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

/** The saved settings, or null when nothing has been saved. Throws
 *  `KvError` when the read did not reach the store. */
export async function loadAppSettings(): Promise<AppSettings | null> {
  const result = await kvGetJson<AppSettings>(SETTINGS_KEY);
  return result.found ? result.value : null;
}

/**
 * Persist app settings to the KV store. Merges with whatever else is
 * stored so we don't clobber future fields.
 */
export async function saveAppSettings(partial: AppSettings): Promise<void> {
  const existing = (await loadAppSettings()) ?? {};
  const next = { ...existing, ...partial };
  // Remove pre-v0.12 settings that were exposed without a runtime consumer.
  delete next.alertNotificationTargets;
  delete next.forceUserOriginators;
  delete next.forceServiceOriginators;
  await kvPutJson(SETTINGS_KEY, next);
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

/** The `console.warn` text for a settings-load failure nobody else reports. */
export const SETTINGS_LOAD_WARNING = 'DatasetProvider: could not load saved settings; using defaults.';

/**
 * DatasetProvider's mount effect: load the saved settings and apply them.
 * A failed read leaves every default in place (as before) but is no
 * longer silent — it is recorded in the framework's dataset load-error
 * store, so `useDatasetLoadError()` can show it, and reported through
 * `onError`; a later successful load clears it. Never rejects.
 */
export async function syncAppSettings(opts: {
  isCancelled?: () => boolean;
  onError?: (err: Error) => void;
} = {}): Promise<void> {
  let settings: AppSettings | null;
  try {
    settings = await loadAppSettings();
  } catch (raw) {
    if (opts.isCancelled?.()) return;
    const err = raw instanceof Error ? raw : new Error(String(raw));
    setDatasetLoadError(err);
    if (opts.onError) {
      try {
        opts.onError(err);
      } catch {
        /* a throwing reporter must not become an unhandled rejection */
      }
    } else {
      console.warn(SETTINGS_LOAD_WARNING, err);
    }
    return;
  }
  if (opts.isCancelled?.()) return;
  setDatasetLoadError(null);
  applyAppSettings(settings);
}
