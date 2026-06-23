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
  /** Cribl notification target IDs for auto-alert notifications.
   *  Multi-select — alerts fire to all listed targets. Empty = silent. */
  alertNotificationTargets?: string[];
  /** Services to treat as user-origin regardless of auto-detection.
   *  Lets the user pull a newly-deployed synthetic-user service into
   *  filtering immediately, before the trace-originator scheduled
   *  search has accumulated enough signal. See HEURISTICS.md §1. */
  forceUserOriginators?: string[];
  /** Services to treat as service-origin regardless of auto-detection.
   *  Inverse of forceUserOriginators — flips false-positive user
   *  classifications back into the service bucket. */
  forceServiceOriginators?: string[];
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
  await kvPut(SETTINGS_KEY, next);
}
