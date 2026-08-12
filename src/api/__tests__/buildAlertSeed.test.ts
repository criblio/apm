/**
 * buildAlertSeed is the single source of truth for the
 * alert→investigation handoff (AlertsPage's Investigate button
 * today; server-side alert triggers later). This pin protects the
 * exact seed shape both producers rely on — if the wording or
 * defaults change on purpose, update this test in the same PR.
 */
import { describe, expect, it } from 'vitest';
import { buildAlertSeed } from '../agentContext';

describe('buildAlertSeed', () => {
  it('builds the alert-incident seed shape', () => {
    expect(
      buildAlertSeed({ service: 'payment', signalType: 'error_rate', errorRate: 0.123 }),
    ).toEqual({
      question: 'The payment service had a error_rate alert. Investigate what happened.',
      service: 'payment',
      knownSignals: ['Signal: error_rate', 'Error rate: 12.3%'],
      earliest: '-1h',
      latest: 'now',
    });
  });

  it('honors an explicit window override', () => {
    const seed = buildAlertSeed({
      service: 'checkout',
      signalType: 'latency',
      errorRate: 0,
      earliest: '-15m',
      latest: '-5m',
    });
    expect(seed.earliest).toBe('-15m');
    expect(seed.latest).toBe('-5m');
  });
});
