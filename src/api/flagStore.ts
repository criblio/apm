/**
 * The shared boolean-flag store behind APM's Settings toggles.
 *
 * Every flag in this app is the same object: a module-level boolean,
 * a listener set, a getter, a setter that no-ops on an unchanged
 * value and notifies subscribers, and an unsubscribe. That shape was
 * hand-copied per flag (streamFilter, lowVolumeMode, metricsRead,
 * metricsEmit), and the copies drifted — the metrics flags shipped
 * default-true where the others were default-false. A flag's default
 * is the one thing that must never be inherited by accident, because
 * "KV unreachable ⇒ feature dark" depends on it.
 *
 * So the mechanics live here once and each flag module states only
 * its own default and its own name.
 *
 * The listener loop swallows subscriber errors on purpose: one bad
 * listener must not stop the others from seeing the change.
 *
 * The four older flag modules still carry their own copies. They
 * behave identically and can migrate onto this factory whenever
 * someone is in them anyway — deliberately not done here, to keep
 * this change scoped to the flag it ships with.
 */
export interface FlagStore {
  /** Current value. */
  get(): boolean;
  /** Set the value and notify subscribers. No-op if unchanged. */
  set(value: boolean): void;
  /** Subscribe to changes. Returns the unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

export function createFlagStore(initial: boolean): FlagStore {
  let enabled = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => enabled,

    set(value: boolean): void {
      if (value === enabled) return;
      enabled = value;
      for (const l of listeners) {
        try {
          l();
        } catch {
          /* listener errors shouldn't block others */
        }
      }
    },

    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
