/**
 * Metrics-read gate (runtime). When ON, RED panels try the fast metrics
 * store first (via `metricsPanels.ts`) and fall back to `$vt_results` /
 * live on empty or error. OFF by default: the dual-read seam ships
 * "dark" (M2 in `docs/metrics-migration-plan.md`) so it can be flipped on
 * per-deployment once the emitters have accumulated enough history and a
 * week of side-by-side agreement holds — and flipped back off instantly
 * (KV, no re-provision) if a panel misbehaves.
 *
 * Unlike `metricsEmit` (baked into scheduled-search KQL at provision
 * time), this is read per-render, so a Settings toggle takes effect
 * without re-provisioning.
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
