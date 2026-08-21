/**
 * The service-level p95-regression arm (the P2 detection gap): pin its
 * gates so threshold drift is deliberate, and pin the baseline-parity
 * requirement — the current-side p95 subquery must apply the same
 * streaming-span filter as prevWindowSummary or services with idle-wait
 * roots read a fake 10x regression.
 */
import { describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import * as Q from '../queries';

setCurrentDataset('otel');

describe('alertEvaluator latency arm', () => {
  const q = Q.alertEvaluator();

  it('fires signal_type="latency" on a 3x + 100ms service p95 regression', () => {
    expect(q).toContain(
      'curr_p95 >= prev_p95 * 3 and curr_p95 >= 100000',
    );
    expect(q).toContain('"latency"');
  });

  it('gates on baseline existence and volume (noise guard)', () => {
    const arm = q.slice(q.indexOf('curr_p95 >= prev_p95 * 3'));
    expect(arm).toContain('prev_p95 > 0');
    expect(arm).toContain('curr_requests >= 20');
    expect(arm).toContain('prev_requests >= 100');
  });

  it('latency condition also gates is_bad (drives the state machine)', () => {
    const isBad = q.slice(q.indexOf('is_bad=('), q.indexOf('alert_id=strcat'));
    expect(isBad).toContain('curr_p95 >= prev_p95 * 3');
  });

  it('current p95 subquery applies the same streaming-span filter as the baseline', () => {
    // prevWindowSummary filters dur_us < 30s; the evaluator's curr-side
    // p95 join must match (dur_us computed then filtered).
    const joinStart = q.indexOf('curr_p95_us=percentile(dur_us, 95)');
    expect(joinStart).toBeGreaterThan(-1);
    const beforeJoin = q.slice(q.indexOf('| lookup criblapm_alert_prev'), joinStart);
    expect(beforeJoin).toContain('dur_us < 30000000');
  });

  it('synthesizes driver rows for silent services (the silent arm is reachable)', () => {
    // A fully-down service emits no spans → no summarize row → without
    // the driver union the `curr_requests == 0` silent case can never
    // match a row (proven live 2026-08-20; synthetic blind test showed
    // signal_type="silent" flows once driver rows exist).
    expect(q).toContain('jobName == "criblapm__home_service_summary"');
    expect(q).toContain('join kind=leftanti');
    expect(q).toContain('curr_requests=toreal(0)');
  });

  it('latency ranks below error_rate and above traffic_drop', () => {
    const caseBlock = q.slice(q.indexOf('signal_type=case('), q.indexOf('is_bad=('));
    const errIdx = caseBlock.indexOf('"error_rate"');
    const latIdx = caseBlock.indexOf('"latency"');
    const dropIdx = caseBlock.indexOf('"traffic_drop"');
    expect(errIdx).toBeGreaterThan(-1);
    expect(latIdx).toBeGreaterThan(errIdx);
    expect(dropIdx).toBeGreaterThan(latIdx);
  });
});
