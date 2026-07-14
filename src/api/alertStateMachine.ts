/**
 * Pure-TS encoding of the alert state machine that the KQL
 * `case()` in `Q.alertEvaluator()` runs server-side every
 * evaluation cycle. ROADMAP P0.4.
 *
 * The state machine has four states:
 *
 *   ok → pending → firing → resolving → ok
 *
 * Plus the back-edges: pending → ok (false-positive flap),
 * resolving → firing (relapse during clear-out).
 *
 * Two tunables, mirrored from the KQL constants of the same name:
 *   - FIRE_AFTER:  how many consecutive bad evaluations to commit
 *                  to firing from pending. Defaults to 2 — the
 *                  first bad eval enters pending, the second
 *                  promotes to firing.
 *   - CLEAR_AFTER: how many consecutive good evaluations to leave
 *                  resolving and walk back to ok. Defaults to 3
 *                  so a single noisy bucket doesn't bounce the
 *                  alert out of resolution.
 *
 * Behavior parity matters: the UI displays the same values the KQL
 * writes, and downstream tools (Alert Timeline, the
 * Investigator's "active alerts" context) read both paths
 * identically. If the TS and KQL diverge, the behavior is
 * indistinguishable from a bug until someone notices the badge
 * count differs from the lookup contents. The test file in this
 * directory pins every transition and serves as the regression
 * surface.
 */

export const FIRE_AFTER = 2;
export const CLEAR_AFTER = 3;

export type AlertStatus = 'ok' | 'pending' | 'firing' | 'resolving';
export type TransitionEvent = '' | 'firing' | 'resolved';

export interface AlertStateInput {
  /** Status from the prior evaluation cycle (read from the
   *  latest immutable evaluation event; `ok` if no prior row). */
  prev_status: AlertStatus;
  /** Did the current evaluation cycle classify this row as bad? */
  is_bad: boolean;
  /** Running count of consecutive bad evaluations *including this
   *  one*. KQL computes this as `iff(is_bad, prev_bad+1, 0)`. */
  new_bad: number;
  /** Running count of consecutive good evaluations *including this
   *  one*. KQL computes this as `iff(is_bad, 0, prev_good+1)`. */
  new_good: number;
}

export interface AlertStateOutput {
  alert_status: AlertStatus;
  /** Either "firing" on the ok→firing transition, "resolved" on
   *  the resolving→ok transition, or "" when no transition fired
   *  this evaluation. The notification dispatcher keys on this. */
  transitioned_to: TransitionEvent;
  /** Increments by 1 on each ok→firing transition. Lets the UI
   *  show "fired N times" without re-deriving from history. */
  fire_count_delta: 0 | 1;
}

/**
 * Compute the next state from the prior state and the current
 * evaluation outcome. Mirrors the KQL `case()` chain in
 * `queries.ts: alertEvaluator()` for the health-alert path
 * exactly; the latency-alert path is a subset (it only ever
 * enters with `is_bad=true`).
 */
export function nextAlertState(input: AlertStateInput): AlertStateOutput {
  const { prev_status, is_bad, new_bad, new_good } = input;

  let alert_status: AlertStatus;
  let transitioned_to: TransitionEvent = '';
  let fire_count_delta: 0 | 1 = 0;

  if (is_bad) {
    // Bad branch — KQL `case(is_bad and ..., ..., ...)` arm-by-arm.
    if (prev_status === 'ok') {
      alert_status = 'pending';
    } else if (prev_status === 'pending' && new_bad >= FIRE_AFTER) {
      alert_status = 'firing';
      transitioned_to = 'firing';
      fire_count_delta = 1;
    } else if (prev_status === 'pending') {
      alert_status = 'pending';
    } else if (prev_status === 'firing') {
      alert_status = 'firing';
    } else if (prev_status === 'resolving') {
      // Relapse during clear-out — back to firing without
      // re-incrementing fire_count (KQL doesn't either).
      alert_status = 'firing';
    } else {
      alert_status = 'ok';
    }
  } else {
    // Good branch.
    if (prev_status === 'pending') {
      // False positive: flip straight back to ok without ever
      // having fired. No `resolved` event — the alert never
      // reached anyone.
      alert_status = 'ok';
    } else if (prev_status === 'firing') {
      alert_status = 'resolving';
    } else if (prev_status === 'resolving' && new_good >= CLEAR_AFTER) {
      alert_status = 'ok';
      transitioned_to = 'resolved';
    } else if (prev_status === 'resolving') {
      alert_status = 'resolving';
    } else {
      alert_status = 'ok';
    }
  }

  return { alert_status, transitioned_to, fire_count_delta };
}
