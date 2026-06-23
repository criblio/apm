/**
 * Low-volume mode toggle. When ON, the alert evaluator adds a
 * fourth detection arm with the older chaos-eval thresholds —
 * `curr_errors >= 2 AND curr_err_pct >= 1` — which catches the
 * llmRateLimit / recommendationCache scenarios on services whose
 * total traffic is too thin for the production-tuned arms to
 * fire. Off by default; users in low-traffic environments
 * (homelabs, low-RPS demos) opt in via Settings.
 *
 * Background: PRs #67/#69 raised the production thresholds after
 * the chaos-eval-tuned floors fired on 1% background noise from
 * real services. The reversal correctly silenced false positives
 * but cost detection on rare-event-rate scenarios. This setting
 * lets the operator pick which trade-off they want without us
 * choosing one default for everyone. See ROADMAP §P1.2.
 *
 * Mirrors the streamFilter.ts module-level-state-plus-subscribe
 * pattern: read at provision time by scripts/provision.ts and at
 * page boot by DatasetProvider, set via the SettingsPage toggle,
 * subscribed by any UI surface that should re-render when the
 * value changes (currently none — alert thresholds are baked into
 * scheduled searches at provision time, so toggling requires a
 * re-provision to take effect).
 */

let enabled = false;
const listeners = new Set<() => void>();

export function getLowVolumeMode(): boolean {
  return enabled;
}

/**
 * Set the low-volume mode state and notify subscribers. No-op if
 * unchanged. Callers: DatasetProvider on KV load, SettingsPage on
 * toggle, scripts/provision.ts on settings read.
 */
export function setLowVolumeMode(v: boolean): void {
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

export function subscribeLowVolumeMode(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
