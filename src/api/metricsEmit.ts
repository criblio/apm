/**
 * Metrics-emit gate (provision-time). When ON, `getProvisioningPlan()`
 * includes the span-derived metric emitter scheduled searches
 * (`criblapm__metric_*`) that `export to metrics` into the fast PromQL
 * store. OFF by default so a deploy doesn't start emitting until an
 * operator opts in — the write path is validated but the read side is
 * still dark (see `metricsRead.ts` and `docs/metrics-migration-plan.md`).
 *
 * Mirrors the lowVolumeMode.ts module-level-state-plus-subscribe pattern:
 * read at provision time by scripts/provision.ts and at page boot by
 * DatasetProvider, set via the SettingsPage toggle. Because the emitter
 * KQL is baked into the scheduled search at creation, toggling requires a
 * re-provision to take effect — same contract as lowVolumeMode.
 */

let enabled = true;
const listeners = new Set<() => void>();

export function getMetricsEmit(): boolean {
  return enabled;
}

export function setMetricsEmit(v: boolean): void {
  if (v === enabled) return;
  enabled = v;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors shouldn't block others */
    }
  }
}

export function subscribeMetricsEmit(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
