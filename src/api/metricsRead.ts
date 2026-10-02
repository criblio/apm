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

let enabled = true;
const listeners = new Set<() => void>();

export function getMetricsRead(): boolean {
  return enabled;
}

export function setMetricsRead(v: boolean): void {
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

export function subscribeMetricsRead(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
