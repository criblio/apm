// Scenario · flagd catalog validation
//
// Sanity-checks that each of the flagd failure-injection flags this
// app is supposed to be exercisable against actually injects the
// telemetry pattern FAILURE-SCENARIOS.md claims. Per plan v2
// (docs/sessions/2026-04-15-scenario-plan-v2.md), this is a
// prerequisite for writing individual scenario specs against flags
// 6 (adFailure), 7 (productCatalogFailure), and 14 (llmRateLimitError):
// if a flag is silently broken upstream, there's no point building a
// UI spec on top of it.
//
// Method, per target flag:
//   1. Flip the flag on via flagd-ui's HTTP API
//   2. Sleep TELEMETRY_WAIT_MS to let the OTel collector flush the
//      first round of post-flip spans through to Cribl
//   3. Run a Cribl KQL job for status.code=2 spans on the expected
//      service over the same window
//   4. Soft-assert the count > 0, record the observation, flip off
//
// Uses expect.soft for each flag so one run reports the health of all
// three. A final hard assertion catches the rig-failure case where
// every flag reports zero errors (which would be a helper regression
// or a cluster-wide outage, not a per-flag problem). A human-readable
// summary is logged in the finally block regardless of pass/fail so
// the PR author has the raw numbers to decide whether to annotate
// FAILURE-SCENARIOS.md with ⚠️ markers.
//
// Prereqs:
//   - FLAGD_UI_URL set (see tests/helpers/flagd.ts)
//   - CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET set
//     (see tests/helpers/criblSearch.ts)
//   - otel-demo cluster is up and producing baseline traffic
//
// Test does not drive a browser — it only talks to flagd-ui and the
// Cribl Search API directly, so no `{ page }` fixture is needed.

import { test, expect } from '@playwright/test';
import { setFlag, allOff } from '../helpers/flagd';
import { runQuery } from '../helpers/criblSearch';

const TEST_TIMEOUT_MS = 15 * 60 * 1000;
// Poll interval for the per-target error-count check. Each iteration
// re-runs the Cribl Search job, so too-fast polls waste worker time.
// 15s is a reasonable trade-off between promptness and load.
const POLL_INTERVAL_MS = 15 * 1000;
// Minimum time to wait before the first query, to let the first
// post-flip spans flush through OTel collector + Cribl ingest.
const INITIAL_DELAY_MS = 15 * 1000;
// Query window for the post-flip count. Wider than any individual
// poll interval so in-flight spans that haven't landed by the current
// poll are still inside the window on the next one.
const POST_FLIP_WINDOW = '-5m';

interface FlagTarget {
  flag: string;
  variant: string;
  expectedService: string;
  maxWaitMs: number;
  note: string;
}

// Targets, in FAILURE-SCENARIOS.md section order. `variant` is the
// exact string flagd accepts for each flag's on-state; all three
// use `on` but check flagd-set.sh --list when adding future targets.
//
// `maxWaitMs` is per-flag because the underlying error rates vary:
// - adFailure is only a 10% error rate (random.nextInt(10) == 0 in
//   AdService.java) on top of ~10 GetAds/minute, so a 90s wait has
//   ~20% chance of zero errors by pure variance. Give it 4 minutes.
// - productCatalogFailure errors on one specific product ID out of
//   the catalog, so most requests still succeed but the affected
//   product is called frequently enough to show within 90s.
// - llmRateLimitError is explicitly "intermittent" in the flag
//   description, but observed as ~50% error rate on product-reviews
//   — hits within seconds.
const TARGETS: FlagTarget[] = [
  {
    flag: 'adFailure',
    variant: 'on',
    expectedService: 'ad',
    maxWaitMs: 4 * 60 * 1000,
    note:
      '10%-rate error injection on oteldemo.AdService/GetAds ' +
      '(upstream code uses random.nextInt(10) == 0); ' +
      'FAILURE-SCENARIOS §6 describes this as "hard error" which is ' +
      'misleading — it is actually a Bernoulli trial per request.',
  },
  {
    flag: 'productCatalogFailure',
    variant: 'on',
    expectedService: 'product-catalog',
    maxWaitMs: 90 * 1000,
    note: 'Targeted product-ID error on product-catalog (FAILURE-SCENARIOS §7)',
  },
  {
    flag: 'llmRateLimitError',
    variant: 'on',
    expectedService: 'product-reviews',
    maxWaitMs: 90 * 1000,
    note: 'LLM rate-limit propagation to product-reviews (FAILURE-SCENARIOS §14)',
  },
];

/**
 * Count status.code=2 spans on the given service where the event
 * was ingested at-or-after `sinceSec` (Unix seconds). Filtering by
 * Cribl's ingestion `_time` rather than a relative window prevents
 * residual errors from a previous run (or from the cluster's
 * baseline noise over the past 5 minutes) from satisfying the
 * assertion before the current flag-flip has actually produced
 * any new spans.
 */
async function countErrorSpans(service: string, sinceSec: number): Promise<number> {
  const svc = service.replace(/"/g, '\\"');
  const kql =
    `dataset="otel" | where isnotnull(end_time_unix_nano) ` +
    `| extend svc=tostring(resource.attributes['service.name']) ` +
    `| where svc == "${svc}" and tostring(status.code) == "2" and _time >= ${sinceSec} ` +
    `| summarize n=count()`;
  const rows = await runQuery(kql, POST_FLIP_WINDOW, 'now', 10);
  return rows.length > 0 ? Number(rows[0].n ?? 0) : 0;
}

interface Observation {
  flag: string;
  variant: string;
  expectedService: string;
  errorSpanCount: number;
  elapsedMs: number;
}

test('scenarios · flagd catalog validation (adFailure, productCatalogFailure, llmRateLimitError)', async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const observations: Observation[] = [];

  try {
    for (const target of TARGETS) {
      // Capture the flip timestamp BEFORE calling setFlag so the
      // post-flip query's `_time >= flipSec` filter never misses
      // spans whose ingestion timestamp races the flag write. Any
      // span with _time < flipSec is strictly pre-flip and must be
      // excluded from the count.
      const flipSec = Math.floor(Date.now() / 1000);
      await test.step(`flag · ${target.flag}=${target.variant}`, async () => {
        await setFlag(target.flag, target.variant);
      });

      await test.step(
        `poll · status.code=2 spans on ${target.expectedService} (≤${target.maxWaitMs / 1000}s)`,
        async () => {
          // Short initial delay so the very first query doesn't race
          // the OTel collector's first post-flip flush.
          await new Promise((r) => setTimeout(r, INITIAL_DELAY_MS));

          const startTs = Date.now();
          let n = 0;
          // Early-exit as soon as the first post-flip error lands
          // so fast flags (productCatalogFailure, llmRateLimitError)
          // don't pay the full adFailure budget.
          while (Date.now() - startTs < target.maxWaitMs) {
            n = await countErrorSpans(target.expectedService, flipSec);
            if (n > 0) break;
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          }
          const elapsedMs = Date.now() - startTs;
          observations.push({
            flag: target.flag,
            variant: target.variant,
            expectedService: target.expectedService,
            errorSpanCount: n,
            elapsedMs,
          });
          await expect
            .soft(
              n > 0,
              `${target.flag} should produce status.code=2 spans on ${target.expectedService} ` +
                `within ${target.maxWaitMs / 1000}s of being flipped on (got ${n}). ${target.note}`,
            )
            .toBe(true);
        },
      );

      // Flip this flag off before moving on so subsequent targets
      // start from a clean baseline on their own service.
      await test.step(`reset · ${target.flag}=off`, async () => {
        await setFlag(target.flag, 'off');
      });
    }
  } finally {
    try {
      await allOff();
    } catch (err) {
      console.error('[teardown] allOff() failed:', err);
    }

    // Always-on summary so even a partial run shows what was
    // observed. The PR author uses this to decide which flags to
    // annotate with ⚠️ in FAILURE-SCENARIOS.md.
    console.log('\n========== Flagd catalog validation results ==========');
    for (const obs of observations) {
      const mark = obs.errorSpanCount > 0 ? '✓' : '⚠';
      const flagCol = `${obs.flag}=${obs.variant}`.padEnd(30);
      const svcCol = obs.expectedService.padEnd(18);
      const elapsed = `${(obs.elapsedMs / 1000).toFixed(0)}s`.padStart(5);
      console.log(
        `${mark} ${flagCol} → ${svcCol} ${obs.errorSpanCount.toString().padStart(4)} error spans in ${elapsed}`,
      );
    }
    console.log('=======================================================\n');
  }

  // Rig sanity check: if every target reported zero errors, the test
  // rig itself is broken (helper regression, cluster down, or search
  // API not returning data). Hard-fail so the failure mode is
  // unambiguous in CI output.
  const workingCount = observations.filter((o) => o.errorSpanCount > 0).length;
  expect(
    workingCount,
    `Rig sanity: at least one target flag must produce errors ` +
      `(got ${workingCount}/${observations.length} producing spans). ` +
      `A full-zero result usually means a helper regression, not a per-flag problem.`,
  ).toBeGreaterThan(0);
});
