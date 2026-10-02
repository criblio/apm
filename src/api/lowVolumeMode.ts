/**
 * Low-volume mode toggle. When ON, the alert evaluator adds a
 * fourth detection arm with sensitive chaos-eval thresholds —
 * at least two errors and a 1% rate, plus a clean baseline or 3x
 * increase — which catches the
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
 * A framework `createStore` (module-level value plus subscribe):
 * read at provision time by scripts/provision.ts and at page boot
 * by DatasetProvider, set via the SettingsPage toggle,
 * subscribed by any UI surface that should re-render when the
 * value changes (currently none — alert thresholds are baked into
 * scheduled searches at provision time, so toggling requires a
 * re-provision to take effect).
 */

import { createStore } from '@criblio/app-utils/store';

/** OFF by default; users in low-traffic environments opt in via Settings. */
export const lowVolumeModeStore = createStore(false);

export const getLowVolumeMode = lowVolumeModeStore.get;
export const setLowVolumeMode = lowVolumeModeStore.set;
export const subscribeLowVolumeMode = lowVolumeModeStore.subscribe;
