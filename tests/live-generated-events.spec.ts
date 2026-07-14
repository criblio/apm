import { test, expect } from '@playwright/test';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { runQuery } from './helpers/criblSearch';
import * as Q from '../src/api/queries';

test('live Cribl accepts the generated-event evaluator and all consumer queries', async () => {
  test.setTimeout(3 * 60_000);
  setCurrentDataset('otel');

  // Executing the real evaluator query is safe and idempotent within its
  // cadence bucket. This catches Cribl-dialect errors that snapshots cannot.
  await runQuery(Q.alertEvaluator(), '-15m', 'now', 200);

  const [history, noise, deploys] = await Promise.all([
    runQuery(Q.alertHistory(25), '-24h', 'now', 25),
    runQuery(Q.noiseBudgetByService(), '-7d', 'now', 200),
    runQuery(Q.recentDeployEvents(25), '-24h', 'now', 25),
  ]);
  expect(Array.isArray(history)).toBe(true);
  expect(Array.isArray(noise)).toBe(true);
  expect(Array.isArray(deploys)).toBe(true);

  const scheduled = await runQuery(
    `dataset="$vt_results"
      | where jobName == "criblapm__home_alerts" and tolong(schema_version) == 1
      | summarize rows=count(), evaluations=dcount(evaluation_id)`,
    '-2h',
    'now',
    10,
  );
  expect(Number(scheduled[0]?.rows ?? 0)).toBeGreaterThan(0);
  expect(Number(scheduled[0]?.evaluations ?? 0)).toBeGreaterThan(0);
});
