/**
 * The alert evaluator's debounce state machine is the framework's
 * `alertStateKql()` (`@criblio/app-utils/alert-state`). Every transition of
 * that machine — and its parity with the pure-TS `nextAlertState()` — is
 * tested in the framework, where the KQL is generated from the same arm
 * table. What stays APM's, and is pinned here:
 *
 *   - both evaluator arms embed the framework state step verbatim, with
 *     APM's tunables (fire on the 2nd bad evaluation, clear after 3 good);
 *   - the retry key and null-defaulting of the persisted columns run in
 *     front of it;
 *   - a platform retry inside one cadence bucket is suppressed.
 */
import { describe, it, expect } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import { alertStateKql } from '@criblio/app-utils/alert-state';
import * as Q from '../queries';

setCurrentDataset('otel');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Collapse indentation so the embedded (re-indented) block compares. */
function squash(text: string): string {
  return text.split('\n').map((l) => l.trim()).join('\n');
}

describe('alert evaluator state machine', () => {
  it('keeps APM tunables: fire after 2 bad evaluations, clear after 3 good', () => {
    expect(Q.ALERT_DEBOUNCE).toEqual({ fireAfter: 2, clearAfter: 3 });
  });

  it('embeds the framework alertStateKql() in both arms', () => {
    const query = squash(Q.alertEvaluator());
    const step = squash(alertStateKql(Q.ALERT_DEBOUNCE));
    expect(count(query, step)).toBe(2);
    expect(count(query, '| extend alert_status=case(')).toBe(2);
  });

  it('defaults the persisted columns before the state step', () => {
    const query = Q.alertEvaluator();
    for (const line of [
      'prev_status=iff(isnotnull(persisted_status), persisted_status, "ok")',
      'prev_bad=iff(isnotnull(persisted_bad), persisted_bad, 0)',
      'prev_good=iff(isnotnull(persisted_good), persisted_good, 0)',
      'prev_fire_count=iff(isnotnull(persisted_fire_count), persisted_fire_count, 0)',
    ]) {
      expect(count(query, line)).toBe(2);
      expect(query.indexOf(line)).toBeLessThan(query.indexOf('| extend alert_status=case('));
    }
  });
});

describe('alert evaluator retry idempotency', () => {
  it('keys evaluations to the cadence bucket and suppresses a durable retry', () => {
    const query = Q.alertEvaluator();
    expect(query).toContain('persisted_evaluation_id=max(tostring(evaluation_id))');
    expect(query).toContain('evaluation_id=strcat("criblapm-eval:", tostring(bin(now(), 5m)))');
    expect(query).toContain('persisted_evaluation_id == evaluation_id');
    expect(query).toContain('| where not(is_retry)');
    expect(query).not.toContain('| dedup ');
  });
});
