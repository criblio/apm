/**
 * ROADMAP P0.4 — pin every transition of the alert state machine.
 *
 * The KQL `case()` in queries.ts: alertEvaluator() must stay in lock-
 * step with the TS in alertStateMachine.ts. These tests are the
 * fence: any divergence shows up here before it hits staging.
 *
 * One test per labeled arm of the state diagram, plus a few
 * traversal-length tests (e.g. full ok→pending→firing→resolving→ok)
 * to make sure the machine composes correctly across cycles.
 */
import { describe, it, expect } from 'vitest';
import {
  FIRE_AFTER,
  CLEAR_AFTER,
  nextAlertState,
  type AlertStateInput,
  type AlertStatus,
} from '../alertStateMachine';

function step(
  prev_status: AlertStatus,
  is_bad: boolean,
  new_bad: number,
  new_good: number,
): AlertStateInput {
  return { prev_status, is_bad, new_bad, new_good };
}

describe('alertStateMachine constants', () => {
  it('mirrors the KQL FIRE_AFTER / CLEAR_AFTER constants', () => {
    // If you change these, also change queries.ts: alertEvaluator().
    expect(FIRE_AFTER).toBe(2);
    expect(CLEAR_AFTER).toBe(3);
  });
});

describe('nextAlertState — bad branch', () => {
  it('ok + bad → pending (first bad eval)', () => {
    expect(nextAlertState(step('ok', true, 1, 0))).toEqual({
      alert_status: 'pending',
      transitioned_to: '',
      fire_count_delta: 0,
    });
  });

  it('pending + bad below FIRE_AFTER → still pending', () => {
    // FIRE_AFTER=2 means new_bad=1 is still in the pending hold.
    expect(nextAlertState(step('pending', true, 1, 0)).alert_status).toBe(
      'pending',
    );
  });

  it('pending + bad at FIRE_AFTER → firing (transitions, increments)', () => {
    expect(nextAlertState(step('pending', true, FIRE_AFTER, 0))).toEqual({
      alert_status: 'firing',
      transitioned_to: 'firing',
      fire_count_delta: 1,
    });
  });

  it('firing + bad → still firing (no transition event)', () => {
    expect(nextAlertState(step('firing', true, 5, 0))).toEqual({
      alert_status: 'firing',
      transitioned_to: '',
      fire_count_delta: 0,
    });
  });

  it('resolving + bad → firing (relapse, no fire_count bump)', () => {
    // Relapse: re-enter firing without re-incrementing fire_count.
    // KQL doesn't fire_count++ on resolving→firing either.
    expect(nextAlertState(step('resolving', true, 1, 0))).toEqual({
      alert_status: 'firing',
      transitioned_to: '',
      fire_count_delta: 0,
    });
  });
});

describe('nextAlertState — good branch', () => {
  it('ok + good → ok', () => {
    expect(nextAlertState(step('ok', false, 0, 1)).alert_status).toBe('ok');
  });

  it('pending + good → ok (false-positive flap, NO resolved event)', () => {
    // A pending alert that goes good again never fired, so callers
    // must not be paged. transitioned_to stays empty.
    expect(nextAlertState(step('pending', false, 0, 1))).toEqual({
      alert_status: 'ok',
      transitioned_to: '',
      fire_count_delta: 0,
    });
  });

  it('firing + good → resolving (no transition event yet)', () => {
    expect(nextAlertState(step('firing', false, 0, 1))).toEqual({
      alert_status: 'resolving',
      transitioned_to: '',
      fire_count_delta: 0,
    });
  });

  it('resolving + good below CLEAR_AFTER → still resolving', () => {
    expect(
      nextAlertState(step('resolving', false, 0, CLEAR_AFTER - 1)).alert_status,
    ).toBe('resolving');
  });

  it('resolving + good at CLEAR_AFTER → ok with resolved event', () => {
    expect(nextAlertState(step('resolving', false, 0, CLEAR_AFTER))).toEqual({
      alert_status: 'ok',
      transitioned_to: 'resolved',
      fire_count_delta: 0,
    });
  });
});

describe('nextAlertState — full traversals', () => {
  it('ok → pending → firing → resolving → ok with default tunables', () => {
    // Cycle 1: first bad
    const s1 = nextAlertState(step('ok', true, 1, 0));
    expect(s1.alert_status).toBe('pending');

    // Cycle 2: second bad — commits to firing
    const s2 = nextAlertState(step(s1.alert_status, true, 2, 0));
    expect(s2.alert_status).toBe('firing');
    expect(s2.transitioned_to).toBe('firing');
    expect(s2.fire_count_delta).toBe(1);

    // Cycle 3-5: good evals walk firing → resolving → … → ok
    const s3 = nextAlertState(step(s2.alert_status, false, 0, 1));
    expect(s3.alert_status).toBe('resolving');
    expect(s3.transitioned_to).toBe('');

    const s4 = nextAlertState(step(s3.alert_status, false, 0, 2));
    expect(s4.alert_status).toBe('resolving');

    const s5 = nextAlertState(step(s4.alert_status, false, 0, 3));
    expect(s5.alert_status).toBe('ok');
    expect(s5.transitioned_to).toBe('resolved');
  });

  it('pending → ok (false-positive flap fires no events)', () => {
    const s1 = nextAlertState(step('ok', true, 1, 0));
    expect(s1.alert_status).toBe('pending');

    const s2 = nextAlertState(step(s1.alert_status, false, 0, 1));
    expect(s2.alert_status).toBe('ok');
    expect(s2.transitioned_to).toBe('');
    // fire_count never incremented — the alert never fired.
    expect(s2.fire_count_delta).toBe(0);
  });

  it('firing → resolving → firing (relapse) preserves fire_count', () => {
    // Start at firing, take one good (resolving), one bad (firing).
    // The second firing should NOT increment fire_count — we never
    // left the original alert window.
    const s1 = nextAlertState(step('firing', false, 0, 1));
    expect(s1.alert_status).toBe('resolving');

    const s2 = nextAlertState(step(s1.alert_status, true, 1, 0));
    expect(s2.alert_status).toBe('firing');
    expect(s2.transitioned_to).toBe(''); // relapse, not a new fire
    expect(s2.fire_count_delta).toBe(0);
  });
});
