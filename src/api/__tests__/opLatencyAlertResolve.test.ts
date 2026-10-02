/**
 * Per-operation latency alerts (auto:latency:<svc>:<op>) must be able to
 * resolve. The arm used to filter rows on the bad condition and hard-code
 * is_bad=true, so a recovered op produced no row: the alert never saw a
 * good evaluation, never walked firing → resolving → ok, and never wrote
 * a "resolved" event (its state just aged out of the -15m prior-state
 * window).
 *
 * Two layers of fence:
 *   1. Structural pins on the KQL (shared state machine, computed is_bad,
 *      emission gate, latest-run read, no-traffic driver rows).
 *   2. A cycle-by-cycle walk through the evaluator's semantics, using the
 *      pure-TS `nextAlertState()` that mirrors the KQL case() plus a TS
 *      mirror of the arm's is_bad predicate, emission gate and prior-state
 *      read. The predicate strings the mirror encodes are pinned against
 *      the generated KQL so the two cannot drift silently.
 */
import { describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import * as Q from '../queries';
import {
  CLEAR_AFTER,
  FIRE_AFTER,
  nextAlertState,
  type AlertStatus,
} from '../alertStateMachine';

setCurrentDataset('otel');

const q = Q.alertEvaluator();
const opArm = q.slice(
  q.indexOf('jobName == "criblapm__svc_operations"'),
  q.indexOf('| where not(is_retry)'),
);
const healthArm = q.slice(0, q.indexOf('jobName == "criblapm__svc_operations"'));

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('alertEvaluator per-operation latency arm — KQL shape', () => {
  it('computes is_bad instead of hard-coding it and filtering on the bad condition', () => {
    expect(opArm).not.toContain('is_bad=true');
    expect(opArm).not.toMatch(/\| where isnotnull\(prev_p95_us\)/);
    expect(opArm).toContain('is_bad=(prev_p95_us > 0');
    expect(opArm).toContain('and curr_p95_us >= prev_p95_us * 3');
    expect(opArm).toContain('and curr_p95_us >= 250000');
    expect(opArm).toContain('and prev_op_requests >= 20)');
  });

  it('runs the same state machine text as the health arm (good branch included)', () => {
    const goodArms = [
      'not(is_bad) and prev_status == "pending", "ok"',
      'not(is_bad) and prev_status == "firing", "resolving"',
      `not(is_bad) and prev_status == "resolving" and new_good >= ${CLEAR_AFTER}, "ok"`,
      `not(is_bad) and prev_status == "resolving" and new_good >= ${CLEAR_AFTER}, "resolved"`,
      'new_good=iff(is_bad, 0, prev_good + 1)',
    ];
    for (const arm of goodArms) {
      expect(healthArm).toContain(arm);
      expect(opArm).toContain(arm);
    }
    // Exactly two state machines in the whole evaluator — one per arm.
    expect(count(q, '| extend alert_status=case(')).toBe(2);
  });

  it('commits a row only while the op is bad or its alert is not ok', () => {
    const gate = opArm.indexOf('| where is_bad or prev_status != "ok"');
    expect(gate).toBeGreaterThan(opArm.indexOf('transitioned_to=case('));
  });

  it('reads only the latest svc_operations run (keepLastN=2 would double rows)', () => {
    expect(opArm).toContain('| summarize jobId=max(tostring(jobId))');
    expect(opArm.indexOf('on jobId')).toBeLessThan(opArm.indexOf('| lookup criblapm_op_baselines'));
  });

  it('synthesizes a good driver row for an open alert whose op has no traffic', () => {
    const driver = opArm.slice(
      opArm.indexOf('startswith "auto:latency:"'),
      opArm.indexOf('| lookup criblapm_op_baselines'),
    );
    expect(driver).toContain('| where driver_status != "ok"');
    expect(driver).toContain('join kind=leftanti');
    expect(driver).toContain('curr_p95_us=toreal(0), curr_requests=toreal(0)');
  });
});

// ── Cycle-by-cycle walk through the evaluator's semantics ─────────────

interface OpSample {
  /** Current p95 (µs) from the latest svc_operations run, or null when
   *  the op has no spans in the window (no svc_operations row). */
  curr_p95_us: number | null;
  /** 24h baseline from criblapm_op_baselines. */
  prev_p95_us: number;
  prev_op_requests: number;
}

interface CommittedRow {
  alert_status: AlertStatus;
  consecutive_bad: number;
  consecutive_good: number;
  fire_count: number;
  is_bad: boolean;
  transitioned_to: '' | 'firing' | 'resolved';
}

/** TS mirror of the KQL is_bad expression (pinned above). A driver row has
 *  curr_p95_us=0 and no baseline match, so it is always good. */
function opIsBad(s: OpSample): boolean {
  const curr = s.curr_p95_us ?? 0;
  const prev = s.curr_p95_us === null ? 0 : s.prev_p95_us;
  const prevReq = s.curr_p95_us === null ? 0 : s.prev_op_requests;
  return prev > 0 && curr >= prev * 3 && curr >= 250000 && prevReq >= 20;
}

/** One evaluator cycle for one op alert. `prior` is the newest committed
 *  row still inside the -15m window (undefined = none). Returns the row the
 *  arm commits, or null when it commits nothing. */
function opCycle(sample: OpSample, prior: CommittedRow | undefined): CommittedRow | null {
  const prevStatus: AlertStatus = prior?.alert_status ?? 'ok';
  // No svc_operations row and no open alert → no driver row either.
  if (sample.curr_p95_us === null && prevStatus === 'ok') return null;
  const is_bad = opIsBad(sample);
  const new_bad = is_bad ? (prior?.consecutive_bad ?? 0) + 1 : 0;
  const new_good = is_bad ? 0 : (prior?.consecutive_good ?? 0) + 1;
  const out = nextAlertState({ prev_status: prevStatus, is_bad, new_bad, new_good });
  // Emission gate: `where is_bad or prev_status != "ok"`.
  if (!(is_bad || prevStatus !== 'ok')) return null;
  return {
    alert_status: out.alert_status,
    consecutive_bad: new_bad,
    consecutive_good: new_good,
    fire_count: (prior?.fire_count ?? 0) + out.fire_count_delta,
    is_bad,
    transitioned_to: out.transitioned_to,
  };
}

/** Run cycles 5 minutes apart; the prior-state join only sees rows from
 *  the last 15 minutes (3 cycles), exactly like the -15m search window. */
function walk(samples: OpSample[], cycle = opCycle) {
  const committed: (CommittedRow | null)[] = [];
  for (const s of samples) {
    const window = committed.slice(-3).filter((r): r is CommittedRow => r !== null);
    committed.push(cycle(s, window[window.length - 1]));
  }
  return committed;
}

const BASE = { prev_p95_us: 100_000, prev_op_requests: 500 };
const slow: OpSample = { ...BASE, curr_p95_us: 900_000 }; // 9x, above the 250ms floor
const fast: OpSample = { ...BASE, curr_p95_us: 110_000 };
const quiet: OpSample = { ...BASE, curr_p95_us: null };

describe('per-operation latency alert walk (evaluator semantics)', () => {
  it('bad×FIRE_AFTER → firing, good×CLEAR_AFTER → resolved, then commits nothing', () => {
    const samples = [
      ...Array<OpSample>(FIRE_AFTER).fill(slow),
      ...Array<OpSample>(CLEAR_AFTER).fill(fast),
      fast,
      fast,
    ];
    const rows = walk(samples);
    expect(rows.map((r) => r?.alert_status ?? null)).toEqual([
      'pending', 'firing', 'resolving', 'resolving', 'ok', null, null,
    ]);
    expect(rows.map((r) => r?.transitioned_to ?? null)).toEqual([
      '', 'firing', '', '', 'resolved', null, null,
    ]);
    expect(rows[2]?.is_bad).toBe(false);
    expect(rows[4]?.consecutive_good).toBe(CLEAR_AFTER);
    expect(rows[4]?.fire_count).toBe(1);
  });

  it('a healthy op with no open alert commits nothing (bounded writes)', () => {
    expect(walk([fast, fast, fast]).every((r) => r === null)).toBe(true);
  });

  it('pending + good flaps back to ok without a resolved event', () => {
    const rows = walk([slow, fast, fast]);
    expect(rows.map((r) => r?.alert_status ?? null)).toEqual(['pending', 'ok', null]);
    expect(rows.every((r) => r?.transitioned_to !== 'resolved')).toBe(true);
  });

  it('relapse during resolving returns to firing without re-counting', () => {
    const rows = walk([slow, slow, fast, slow, fast, fast, fast]);
    expect(rows.map((r) => r?.alert_status)).toEqual([
      'pending', 'firing', 'resolving', 'firing', 'resolving', 'resolving', 'ok',
    ]);
    expect(rows[6]?.fire_count).toBe(1);
    expect(rows[6]?.transitioned_to).toBe('resolved');
  });

  it('an open alert whose op goes quiet resolves via no-traffic driver rows', () => {
    const rows = walk([slow, slow, quiet, quiet, quiet, quiet]);
    expect(rows.map((r) => r?.alert_status ?? null)).toEqual([
      'pending', 'firing', 'resolving', 'resolving', 'ok', null,
    ]);
    expect(rows[4]?.transitioned_to).toBe('resolved');
  });

  it('regression guard: the pre-fix bad-only arm never resolves', () => {
    // Old arm: rows only when bad; the state machine had no good branch.
    const oldCycle = (s: OpSample, prior: CommittedRow | undefined): CommittedRow | null => {
      if (!opIsBad(s)) return null;
      return opCycle(s, prior);
    };
    const rows = walk([slow, slow, fast, fast, fast, fast], oldCycle);
    expect(rows.some((r) => r?.transitioned_to === 'resolved')).toBe(false);
    expect(rows.slice(2).every((r) => r === null)).toBe(true);
  });
});
