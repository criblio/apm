import { describe, expect, it } from 'vitest';
import { buildEpisodes, mapHistoryRow } from '../alertEpisodes';

/** A row shaped like Q.alertHistory() / criblapm__alert_history output. */
function row(
  t: number,
  event_type: 'firing' | 'resolved',
  alert_id: string,
  svc: string,
  signal_type: string,
  curr_error_rate = 0,
): Record<string, unknown> {
  return { _time: t, event_type, alert_id, svc, signal_type, curr_error_rate, prev_error_rate: 0 };
}

const episodesOf = (rows: Record<string, unknown>[]) => buildEpisodes(rows.map(mapHistoryRow));

describe('buildEpisodes', () => {
  it('closes a health episode whose resolved event carries signal_type="none"', () => {
    // Exactly what the evaluator's health arm commits: signal_type on the
    // resolved row comes from the current (good) evaluation, so it is
    // "none" rather than the signal that fired. Seen on every stored
    // auto:health resolved row in staging's 7-day history.
    const eps = episodesOf([
      row(1_000, 'firing', 'auto:health:payment', 'payment', 'error_rate', 0.4),
      row(1_900, 'resolved', 'auto:health:payment', 'payment', 'none'),
    ]);
    expect(eps).toEqual([
      {
        service: 'payment',
        signalType: 'error_rate',
        startTime: 1_000_000,
        endTime: 1_900_000,
        duration: 900_000,
        errorRate: 0.4,
      },
    ]);
  });

  it('keeps the firing signal when a health alert changes signal mid-episode', () => {
    // resolving -> firing is a relapse with no new firing event, so the
    // episode is one firing ... one resolved regardless of signal drift.
    const eps = episodesOf([
      row(100, 'firing', 'auto:health:cart', 'cart', 'latency'),
      row(400, 'resolved', 'auto:health:cart', 'cart', 'none'),
      row(500, 'firing', 'auto:health:cart', 'cart', 'traffic_drop'),
    ]);
    expect(eps.map((e) => [e.signalType, e.startTime, e.endTime])).toEqual([
      ['traffic_drop', 500_000, null],
      ['latency', 100_000, 400_000],
    ]);
  });

  it('pairs per-operation latency alerts on alert_id, not svc + signal_type', () => {
    // Two ops of one service, plus the service-level health latency alert,
    // all carry svc=frontend and signal_type="latency". Keyed on
    // svc:signal_type they collapsed into one episode and the first
    // resolved closed the wrong alert.
    const eps = episodesOf([
      row(100, 'firing', 'auto:latency:frontend:GET /a', 'frontend', 'latency'),
      row(200, 'firing', 'auto:latency:frontend:GET /b', 'frontend', 'latency'),
      row(250, 'firing', 'auto:health:frontend', 'frontend', 'latency'),
      row(300, 'resolved', 'auto:latency:frontend:GET /b', 'frontend', 'latency'),
      row(350, 'resolved', 'auto:health:frontend', 'frontend', 'none'),
    ]);
    expect(eps.map((e) => [e.startTime, e.endTime])).toEqual([
      [250_000, 350_000],
      [200_000, 300_000],
      [100_000, null],
    ]);
  });

  it('falls back to svc + signal_type for legacy rows without alert_id', () => {
    const eps = episodesOf([
      { _time: 10, event_type: 'firing', svc: 'ad', signal_type: 'error_rate', curr_error_rate: 0.1 },
      { _time: 20, event_type: 'resolved', svc: 'ad', signal_type: 'error_rate' },
      { _time: 30, event_type: 'firing', svc: 'ad', signal_type: 'silent' },
    ]);
    expect(eps.map((e) => [e.service, e.signalType, e.startTime, e.endTime])).toEqual([
      ['ad', 'silent', 30_000, null],
      ['ad', 'error_rate', 10_000, 20_000],
    ]);
  });

  it('keeps service names containing a colon intact on still-open episodes', () => {
    const eps = episodesOf([
      row(10, 'firing', 'auto:health:ns:checkout', 'ns:checkout', 'error_rate'),
    ]);
    expect(eps[0]).toMatchObject({ service: 'ns:checkout', signalType: 'error_rate', endTime: null });
  });

  it('ignores a resolved event with no open episode', () => {
    expect(episodesOf([row(10, 'resolved', 'auto:health:x', 'x', 'none')])).toEqual([]);
  });
});
