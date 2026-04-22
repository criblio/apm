/**
 * Module-level scheduled-search cadence + pub/sub.
 *
 * Controls how often the panel-cache scheduled searches run (and
 * therefore how quickly the detected issues panel surfaces new
 * problems). Stored as a user-friendly key ('1m', '2m', '5m', '10m')
 * and converted to a cron expression when building the provisioning
 * plan.
 *
 * Same pattern as dataset.ts and streamFilter.ts.
 */

export type CadenceOption = '1m' | '2m' | '5m' | '10m';

export const CADENCE_OPTIONS: Array<{ value: CadenceOption; label: string; lagLabel: string }> = [
  { value: '1m', label: 'Every 1 minute', lagLabel: '~1 minute' },
  { value: '2m', label: 'Every 2 minutes', lagLabel: '~2 minutes' },
  { value: '5m', label: 'Every 5 minutes', lagLabel: '~5 minutes' },
  { value: '10m', label: 'Every 10 minutes', lagLabel: '~10 minutes' },
];

export const DEFAULT_CADENCE: CadenceOption = '5m';

const CADENCE_TO_CRON: Record<CadenceOption, string> = {
  '1m': '* * * * *',
  '2m': '*/2 * * * *',
  '5m': '*/5 * * * *',
  '10m': '*/10 * * * *',
};

let current: CadenceOption = DEFAULT_CADENCE;
const listeners = new Set<() => void>();

export function getSearchCadence(): CadenceOption {
  return current;
}

export function getSearchCadenceCron(): string {
  return CADENCE_TO_CRON[current];
}

export function setSearchCadence(value: string): void {
  const next = CADENCE_TO_CRON[value as CadenceOption] ? (value as CadenceOption) : DEFAULT_CADENCE;
  if (next === current) return;
  current = next;
  for (const l of listeners) {
    try { l(); } catch { /* listener errors shouldn't block others */ }
  }
}

export function subscribeSearchCadence(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
