/**
 * App settings stored in the pack-scoped KV store. Keeps the save/load
 * helpers out of DatasetProvider so the provider file satisfies the
 * react-refresh/only-export-components rule.
 */
import { kvGet, kvPut } from './kvstore';

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
  [k: string]: unknown;
}

export async function loadAppSettings(): Promise<AppSettings | null> {
  return await kvGet<AppSettings>(SETTINGS_KEY);
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
  await kvPut(SETTINGS_KEY, next);
}
