import { test, expect } from '@playwright/test';
import { runQuery } from './helpers/criblSearch';
import {
  alertTransitionCanaryRead,
  alertTransitionCanaryStep,
} from '../src/api/alertTransitionCanary';

const DATASET = 'otel';

test('live alert fault traversal emits exactly one firing and one resolved event across retries', async () => {
  test.setTimeout(5 * 60_000);
  const canaryId = `stopship_${Date.now()}`;

  async function readSummary(): Promise<Record<string, unknown>> {
    const rows = await runQuery(alertTransitionCanaryRead(canaryId, DATASET), '-15m', 'now', 10);
    return rows[0] ?? {};
  }

  async function waitForEvaluations(expected: number): Promise<Record<string, unknown>> {
    let summary: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 12; attempt += 1) {
      summary = await readSummary();
      if (Number(summary.evaluations ?? 0) >= expected) return summary;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return summary;
  }

  const steps: Array<{ id: string; bad: boolean }> = [
    { id: `${canaryId}_01`, bad: true },
    { id: `${canaryId}_02`, bad: true },
    { id: `${canaryId}_03`, bad: false },
    { id: `${canaryId}_04`, bad: false },
    { id: `${canaryId}_05`, bad: false },
  ];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    await runQuery(alertTransitionCanaryStep(canaryId, step.id, step.bad, DATASET), '-1m', 'now', 10);
    await waitForEvaluations(index + 1);

    // Replay the exact evaluation. A reader-side dedup would still leave two
    // durable rows; the producer must suppress this send altogether.
    await runQuery(alertTransitionCanaryStep(canaryId, step.id, step.bad, DATASET), '-1m', 'now', 10);
    const afterRetry = await waitForEvaluations(index + 1);
    expect(Number(afterRetry.rows ?? 0)).toBe(index + 1);
    expect(Number(afterRetry.event_ids ?? 0)).toBe(index + 1);
  }

  const summary = await readSummary();
  expect(Number(summary.rows)).toBe(5);
  expect(Number(summary.evaluations)).toBe(5);
  expect(Number(summary.event_ids)).toBe(5);
  expect(Number(summary.firing)).toBe(1);
  expect(Number(summary.resolved)).toBe(1);
  expect(Number(summary.fire_count)).toBe(1);
});
