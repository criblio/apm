import { describe, it, expect } from 'vitest';
import {
  evaluateTransition,
  newAlertState,
  alertIdFromIssue,
  alertLabel,
  DEFAULT_DEBOUNCE,
  type AlertState,
} from '../alertState';
import type { DetectedIssue } from '../../api/types';

function makeState(overrides: Partial<AlertState> = {}): AlertState {
  return { ...newAlertState('test:error_rate:payment'), ...overrides };
}

describe('alertIdFromIssue', () => {
  it('generates error_rate id', () => {
    const issue: DetectedIssue = { service: 'payment', signalType: 'error_rate_critical', severity: 'critical', detail: '' };
    expect(alertIdFromIssue(issue)).toBe('auto:error_rate:payment');
  });

  it('generates latency id with operation', () => {
    const issue: DetectedIssue = { service: 'fraud-detection', signalType: 'latency_anomaly', severity: 'warn', detail: '', operation: 'consume' };
    expect(alertIdFromIssue(issue)).toBe('auto:latency:fraud-detection:consume');
  });

  it('generates traffic_drop id', () => {
    const issue: DetectedIssue = { service: 'payment', signalType: 'traffic_drop', severity: 'critical', detail: '' };
    expect(alertIdFromIssue(issue)).toBe('auto:traffic_drop:payment');
  });

  it('generates silent id', () => {
    const issue: DetectedIssue = { service: 'email', signalType: 'silent', severity: 'critical', detail: '' };
    expect(alertIdFromIssue(issue)).toBe('auto:silent:email');
  });
});

describe('alertLabel', () => {
  it('formats auto error_rate', () => {
    expect(alertLabel('auto:error_rate:payment')).toBe('payment — Error Rate');
  });

  it('formats auto latency with operation', () => {
    expect(alertLabel('auto:latency:fraud-detection:consume')).toBe('fraud-detection — Latency Anomaly (consume)');
  });

  it('returns raw id for unknown format', () => {
    expect(alertLabel('custom:foo')).toBe('custom:foo');
  });
});

describe('evaluateTransition', () => {
  describe('ok → pending → firing', () => {
    it('ok + bad → pending', () => {
      const state = makeState({ status: 'ok' });
      const t = evaluateTransition(state, true);
      expect(t.next).toBe('pending');
      expect(t.shouldNotify).toBeNull();
      expect(state.consecutiveBad).toBe(1);
    });

    it('pending + bad (count < fireAfter) → pending', () => {
      const state = makeState({ status: 'pending', consecutiveBad: 1 });
      const t = evaluateTransition(state, true);
      expect(t.next).toBe('firing');
      expect(t.shouldNotify).toBe('firing');
      expect(state.fireCount).toBe(1);
    });

    it('pending + bad with fireAfter=3 stays pending', () => {
      const state = makeState({ status: 'pending', consecutiveBad: 1 });
      const t = evaluateTransition(state, true, { fireAfter: 3, clearAfter: 3 });
      expect(t.next).toBe('pending');
      expect(t.shouldNotify).toBeNull();
      expect(state.consecutiveBad).toBe(2);
    });
  });

  describe('firing → resolving → ok', () => {
    it('firing + good → resolving', () => {
      const state = makeState({ status: 'firing', firstFiredAt: '2026-01-01' });
      const t = evaluateTransition(state, false);
      expect(t.next).toBe('resolving');
      expect(t.shouldNotify).toBeNull();
    });

    it('resolving + good (count < clearAfter) → resolving', () => {
      const state = makeState({ status: 'resolving', consecutiveGood: 1 });
      const t = evaluateTransition(state, false);
      expect(t.next).toBe('resolving');
      expect(state.consecutiveGood).toBe(2);
    });

    it('resolving + good (count >= clearAfter) → ok + notify resolved', () => {
      const state = makeState({ status: 'resolving', consecutiveGood: 2, firstFiredAt: '2026-01-01' });
      const t = evaluateTransition(state, false);
      expect(t.next).toBe('ok');
      expect(t.shouldNotify).toBe('resolved');
      expect(state.firstFiredAt).toBeUndefined();
    });
  });

  describe('resolving + bad → back to firing', () => {
    it('resolving + bad → firing', () => {
      const state = makeState({ status: 'resolving', consecutiveGood: 2 });
      const t = evaluateTransition(state, true);
      expect(t.next).toBe('firing');
      expect(state.consecutiveGood).toBe(0);
    });
  });

  describe('pending + good → ok (reset)', () => {
    it('pending + good → ok', () => {
      const state = makeState({ status: 'pending', consecutiveBad: 1 });
      const t = evaluateTransition(state, false);
      expect(t.next).toBe('ok');
      expect(state.consecutiveBad).toBe(0);
      expect(state.consecutiveGood).toBe(0);
    });
  });

  describe('firing stays firing on continued bad', () => {
    it('firing + bad → firing (no re-notify)', () => {
      const state = makeState({ status: 'firing' });
      const t = evaluateTransition(state, true);
      expect(t.next).toBe('firing');
      expect(t.shouldNotify).toBeNull();
    });
  });

  describe('ok + good → ok (no-op)', () => {
    it('ok + good → ok', () => {
      const state = makeState({ status: 'ok' });
      const t = evaluateTransition(state, false);
      expect(t.next).toBe('ok');
      expect(t.shouldNotify).toBeNull();
    });
  });
});
