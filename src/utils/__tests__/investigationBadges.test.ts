import { describe, expect, it } from 'vitest';
import {
  badgeForIncident,
  indexInvestigations,
  type InvestigationEventRow,
} from '../investigationBadges';

const T0 = 1_786_000_000_000;

function ev(p: Partial<InvestigationEventRow>): InvestigationEventRow {
  return {
    timeMs: T0,
    eventType: 'started',
    alertId: 'auto:health:payment',
    investigationId: 'inv-1',
    svc: 'payment',
    conclusion: '',
    ...p,
  };
}

describe('indexInvestigations', () => {
  it('collapses each run to its terminal event', () => {
    const idx = indexInvestigations([
      ev({ investigationId: 'inv-1', eventType: 'started', timeMs: T0 }),
      ev({ investigationId: 'inv-1', eventType: 'investigated', timeMs: T0 + 5000, conclusion: 'done' }),
    ]);
    const rows = idx.get('auto:health:payment')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('investigated');
    expect(rows[0].conclusion).toBe('done');
  });

  it('keeps a terminal event even when a stray started arrives later', () => {
    const idx = indexInvestigations([
      ev({ investigationId: 'inv-1', eventType: 'investigated', timeMs: T0 + 5000 }),
      ev({ investigationId: 'inv-1', eventType: 'started', timeMs: T0 + 9000 }),
    ]);
    expect(idx.get('auto:health:payment')![0].eventType).toBe('investigated');
  });
});

describe('badgeForIncident', () => {
  const idx = indexInvestigations([
    ev({ investigationId: 'inv-1', eventType: 'investigated', timeMs: T0 + 60_000, conclusion: 'root cause X' }),
  ]);

  it('matches an incident by reconstructed health alert_id within the window', () => {
    const badge = badgeForIncident(
      { service: 'payment', signalType: 'error_rate', startTime: T0, endTime: T0 + 120_000 },
      idx,
    );
    expect(badge).toEqual({
      state: 'investigated',
      investigationId: 'inv-1',
      conclusion: 'root cause X',
    });
  });

  it('applies the grace window for firing/commit skew', () => {
    // Investigation event 6 min before the incident start — inside the
    // 10-min grace.
    const badge = badgeForIncident(
      { service: 'payment', signalType: 'error_rate', startTime: T0 + 60_000 + 6 * 60_000, endTime: null },
      idx,
    );
    expect(badge?.state).toBe('investigated');
  });

  it('does not match an unrelated service', () => {
    expect(
      badgeForIncident(
        { service: 'checkout', signalType: 'error_rate', startTime: T0, endTime: T0 + 120_000 },
        idx,
      ),
    ).toBeNull();
  });

  it('does not match outside the window + grace', () => {
    expect(
      badgeForIncident(
        { service: 'payment', signalType: 'error_rate', startTime: T0 + 60 * 60_000, endTime: T0 + 61 * 60_000 },
        idx,
      ),
    ).toBeNull();
  });

  it('surfaces the investigating state from a started-only run', () => {
    const running = indexInvestigations([
      ev({ investigationId: 'inv-2', eventType: 'started', timeMs: T0 }),
    ]);
    const badge = badgeForIncident(
      { service: 'payment', signalType: 'error_rate', startTime: T0, endTime: null },
      running,
    );
    expect(badge?.state).toBe('investigating');
  });

  it('prefers an explicit alertId match over the reconstructed health id', () => {
    const idxOp = indexInvestigations([
      ev({ investigationId: 'inv-3', alertId: 'auto:latency:payment:charge', eventType: 'investigated', timeMs: T0, conclusion: 'slow charge' }),
    ]);
    const badge = badgeForIncident(
      { service: 'payment', signalType: 'latency', startTime: T0 - 1000, endTime: T0 + 1000, alertId: 'auto:latency:payment:charge' },
      idxOp,
    );
    expect(badge?.conclusion).toBe('slow charge');
  });
});
