import { test, expect } from '@playwright/test';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import { runQuery } from './helpers/criblSearch';
import * as Q from '../src/api/queries';

const OFFLINE_DATAGEN_WAIVER_EXPIRES = Date.parse('2026-08-31T23:59:59Z');

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

  // Assert the durable contract, not the volatile $vt_results cache. The
  // scheduled search keeps only its last two executions, and an idempotent
  // same-bucket retry can legitimately produce zero rows; two such retries
  // temporarily make the cache look empty even though the versioned events
  // were committed successfully.
  const durable = await runQuery(
    `dataset="otel"
      | where coalesce(tostring(data_datatype), tostring(datatype)) == "criblapm_alert"
      | where producer == "criblapm__home_alerts" and record_kind == "evaluation"
      | where tolong(schema_version) == 1
      | where isnull(is_canary) or tostring(is_canary) != "true"
      | summarize rows=count(), evaluations=dcount(evaluation_id)`,
    '-2h',
    'now',
    10,
  );
  if (
    process.env.APM_ALLOW_OFFLINE_DATAGEN === 'true'
    && Date.now() <= OFFLINE_DATAGEN_WAIVER_EXPIRES
  ) {
    test.info().annotations.push({
      type: 'temporary waiver',
      description: 'Durable-row assertions waived while datagen is offline; expires 2026-08-31.',
    });
    return;
  }
  expect(Number(durable[0]?.rows ?? 0)).toBeGreaterThan(0);
  expect(Number(durable[0]?.evaluations ?? 0)).toBeGreaterThan(0);
});
