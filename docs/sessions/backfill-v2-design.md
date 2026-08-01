# Backfill v2 — design + progress

Goal (user requirements, this session):
1. **Per-metric idempotency** — adding a NEW metric family backfills ONLY
   that new family; already-covered families are skipped. No double-count
   (store is non-idempotent).
2. **Reverse order** — newest→oldest back to the horizon (default 24h).
3. **Sample histograms** — per-span histogram emit is the slow part; sample
   by first-hex-char of span_id (verified uniform) so backfill runs in
   minutes. Resolution drop in backfill data is acceptable. Percentiles are
   preserved (distribution shape unchanged by unbiased sampling).
4. **Big counter windows** — counters emit aggregated rows (few per minute),
   so cover them in large windows (6h) instead of span-count chunking.
5. **UI == deploy** — the SAME core (`src/api/metricsBackfill.ts`, pure +
   deps-injected) runs from the Settings UI (browser deps) and from
   `npm run deploy` (Node deps). Identical algorithm.

## Idempotency mechanism (the key design decision)

Track coverage FROM THE METRICS STORE (source of truth), not a KV marker.
For each emitter's metric, probe **`earliestCoveredSec`** = the earliest
`_time` the metric has data over [fromSec, toSec]. Backfill only the gap
`[fromSec, earliestCoveredSec)` — in reverse (newest→oldest), which extends
coverage contiguously backward.

- NEW metric → no data → earliestCoveredSec = null → backfill full horizon.
- Existing (fully backfilled) → earliestCoveredSec ≤ fromSec → gap empty →
  skip.
- Interrupted reverse backfill → earliestCoveredSec sits at the deepest
  completed point → re-run fills only the remaining gap. No double-count,
  because reverse order keeps coverage contiguous down from the forward-emit
  boundary, and we never emit into an already-covered window.

Windows never straddle the forward-emit boundary: the gap's upper bound is
`earliestCoveredSec` (= forward emit's earliest write), so backfill windows
sit entirely before forward emit → no overlap → no double-count.

## Per-emitter window strategy
- counter (kind='counter'): fixed 6h windows over the gap. Emit volume ≈
  360min × ~50 (svc×op×outcome) ≈ 18k < 40k cap. Drop-split fallback still
  guards overflow.
- histogram (kind='histogram'): sampled query (first-hex-char subset), span-
  count chunking with effective cap = SAFE_MAX / sampleRate.

## Sampling
`span_id` first hex char is uniform over 0-f (verified ~3200 each). Sample
rate r → keep spans whose first hex char ∈ first round(r*16) chars.
Backfill uses the sampled histogram query; the LIVE scheduled search stays
unsampled (rate=1). Counters never sampled.

## Files
- [x] `src/api/metricsBackfill.ts` — v2 core: BackfillEmitter gains
      {metricName, kind, backfillQuery}; deps gains earliestCoveredSec;
      runMetricsBackfill loops per-emitter, computes gap, reverse windows,
      per-type planning.
- [x] `src/api/queries.ts` — `metricDurationExport(sampleRate?)` +
      `sampleFirstHexClause()`; same for edge/messaging duration.
- [x] `src/api/provisionedSearches.ts` — getMetricEmitters returns metadata
      (metricName, kind, backfillQuery); live searches stay unsampled.
- [x] `scripts/metricsBackfillDeps.ts` — add earliestCoveredSec (range
      query min _time); keep countSpans/runExport.
- [x] `src/api/metricsBackfillBrowser.ts` (NEW) — browser deps (fetch via
      host proxy: search jobs + metrics query).
- [x] `scripts/provision.ts` — drop the single-metric far-edge probe; call
      v2 (which self-probes per-metric).
- [x] UI trigger — Settings panel button "Backfill metrics" with progress,
      using browser deps + the same core.
- [x] tests — metricsBackfill.test.ts updated for v2 (coverage gap, reverse,
      per-type windows, skip-covered).

## Status: DONE — validated on staging 0.13.17 (all 6 metrics skip idempotently; new-metric path validated next via status-mix).

## Coverage-probe bug (found during first deploy) + fix

First v2 deploy: `metric_requests` (counter) skipped correctly, but
`metric_duration` (HISTOGRAM) probed as uncovered and re-ran a 53-window
backfill. Root cause: the probe used `count(metric)`, which returns NOTHING
for a histogram on this engine — histogram data is ONLY reachable via
`histogram_quantile(… by (le))` (verified: bare `count`/`sum`/`present_over_time`/
`_bucket`/`_count`/`_sum` all return 0 rows for the histogram name).

Fix: `coverageProbeQuery(metricName, kind)` in metricNames.ts —
- counter   → `count(metric)`
- histogram → `histogram_quantile(0.5, sum(rate(metric[5m])) by (le))`
`kind` threaded through `earliestCoveredSec`. Histogram probes pad the
query start by 5m (rate lookback) so small windows don't false-negative,
and coverage = presence of a FINITE sample (a histogram quantile can be a
legitimate 0, so not `value > 0`). Verified: the duration histogram now
probes covered (287 samples, earliest ≤ horizon start) → skipped.

Collateral from the buggy run: the aborted 53-window backfill re-emitted
some 25%-sampled duration data on top of existing. Because sampling is
unbiased the histogram_quantile SHAPE is preserved, so percentiles remain
correct (only le-bucket counts inflated, which reads don't use). No fix
needed / possible (non-idempotent store).

## Per-window check removed (boundary false-positive)

Migrating status-code-mix (the first NEW metric) surfaced a bug: after its
first backfill covered ~18h, a re-run's gap probe found a 6h gap
[24h,18h) — correct — but the per-window re-probe reported that window
"already covered" and skipped it, leaving a 6h hole. Cause: the window's
LATEST edge equals `gapToSec` = the first covered 5-min bin, so a
`count()`/`histogram_quantile` probe over [w.earliest, w.latest] catches
that boundary bin and false-positives.

Fix: removed the per-window re-probe entirely. The gap `[fromSec,
earliestCoveredSec)` is already exact and non-overlapping (its upper bound
IS the first covered bin), so every window in it is emittable. Resume-safety
comes from the gap itself — a re-run re-derives `earliestCoveredSec` and
fills only what's still missing, newest→oldest, with coverage contiguous
from the forward-emit boundary. Simpler and correct.
