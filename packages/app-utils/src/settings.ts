/**
 * App settings pattern — load/save from KV with merge semantics.
 * Each app defines its own AppSettings interface; this module
 * provides the generic load/save/pub-sub pattern.
 */
import { kvGet, kvPut } from './kvstore.js';

const SETTINGS_KEY = 'settings/app';

export async function loadSettings<T extends Record<string, unknown>>(): Promise<T | null> {
  return await kvGet<T>(SETTINGS_KEY);
}

export async function saveSettings<T extends Record<string, unknown>>(partial: Partial<T>): Promise<void> {
  const existing = (await loadSettings<T>()) ?? ({} as T);
  const next = { ...existing, ...partial };
  await kvPut(SETTINGS_KEY, next);
}

export function createPubSub<T>(initial: T) {
  let current = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => current,
    set: (next: T) => {
      if (next === current) return;
      current = next;
      for (const l of listeners) {
        try { l(); } catch { /* listener errors shouldn't block others */ }
      }
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
