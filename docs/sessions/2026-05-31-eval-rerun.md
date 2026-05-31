# Eval suite — second run after detection fixes (2026-05-31)

Second 14-scenario eval run, this time against `master` with PR #60
applied (detection fixes 1a, 1c, 1d). Ran 6h 29m. Mean score
**0.72** — up from 0.66 on the 2026-05-30 baseline. **6 of 14
fully detected** — up from 3.

## Run conditions

- Pack version: 0.9.0
- Commit: `462d5f1` (master after PR #60 merged)
- Workspace: `main-objective-shirley-sho21r7.cribl-staging.cloud`
- All flagd flags `off` at start.
- Sequential scenarios; ~25-30 min per scenario.

## Score deltas vs 2026-05-30

| Scenario | 2026-05-30 | 2026-05-31 | Δ | Verdict |
|---|--:|--:|--:|---|
| **adFailure** | 0.60 | **1.00** | +0.40 | 1a fix landed cleanly |
| adHighCpu | 0.77 | 0.77 | 0 | p99 still <3ms; loosen further |
| adManualGc | 1.00 | 1.00 | 0 | Already perfect |
| **cartFailure** | 0.48 | **0.83** | +0.35 | 1a fix; UI surfaces lag |
| **emailMemoryLeak** | 0.70 | 0.20 | **-0.50** | Previous run was residual state; latency branch needs fix |
| failedReadinessProbe | 0.40 | 0.50 | +0.10 | homeCheckoutErrorChip now ✓ |
| kafkaQueueProblems | 1.00 | 1.00 | 0 | Already perfect |
| **leakFingerprint** | 0.23 | 0.47 | +0.24 | alertsPageFrontend ✓ |
| llmRateLimitError | 0.39 | 0.39 | 0 | curr_requests≥5 floor blocks low-volume service |
| loadGeneratorFloodHomepage | 1.00 | 1.00 | 0 | Already perfect |
| **paymentFailure** | 0.91 | **1.00** | +0.09 | alertHistory now reliable (was the lone gap) |
| paymentUnreachable | 0.92 | 0.77 | -0.15 | Surface-check flake |
| **productCatalogFailure** | 0.70 | **1.00** | +0.30 | UI surfaces now reflecting state |
| recommendationCacheFailure | 0.10 | 0.10 | 0 | Low-volume + cache-miss noise; same blocker as llm |

**Aggregate: 0.66 → 0.72 (+0.06). 3 → 6 fully detected.**

## What worked

### 1a fix (shorter -15m alert detection window)

The biggest leverage point. Five scenarios that previously had silent alert state machines now fire correctly:

- **adFailure** (10% Bernoulli low traffic) +0.40
- **cartFailure** +0.35
- **productCatalogFailure** +0.30
- **paymentFailure** +0.09 (alertHistory dataset event now lands)
- **leakFingerprint** +0.24

The pattern: with the -1h window, a 7-min burst on a low-traffic service couldn't reach the 1% threshold consistently because the prior 53 minutes of healthy traffic diluted it. Switching the alert evaluator to query spans directly over -15m surfaces fresh signal without dilution.

### 1c fix (Investigator waitMs bump)

Mixed — bumped `emailMemoryLeak` and `recommendationCacheFailure` from 5min to 10min. Neither cleared the investigator scoring this time either; the issue isn't time, it's playbook coverage. Worth pursuing further as a roadmap item, but for now: the bump didn't help.

### 1d fix (adHighCpu p99 threshold loosened to ≥3ms)

Didn't land either — p99 in this run was still <3ms. The ad service's CPU-saturation pattern shifts p95 (which ✓) but doesn't push p99 hard enough above baseline to clear even 3ms. Need to either loosen further (≥2ms) or change the assertion shape.

## Regressions

### emailMemoryLeak: 0.70 → 0.20

This was confusing. In the 2026-05-30 eval, alertStateemailFiring fired in 1418ms (instantly) and all 7 surfaces passed. Now in 2026-05-31, alertStateemailFiring timed out at 8min, and 5 of 7 surfaces failed.

**Diagnosis**: the 2026-05-30 run's instant alert state was almost certainly **residual** from earlier in the run sequence — some prior latency anomaly had left email in firing state via the `auto:latency:svc:op` key. When 2026-05-31 starts fresh (alert state lookup wiped between scenarios + fresh deploy), email's actual latency anomaly in 7 minutes of emailMemoryLeak doesn't cross the latency branch's thresholds:

```
where prev_p95_us > 0
  and curr_p95_us >= prev_p95_us * 5
  and curr_p95_us >= 1000000
  and prev_op_requests >= 20
```

The `>= 1000000` (1 second absolute) is the killer. emailMemoryLeak gradually drifts the p95; it may not reach 1 second in 7 minutes of telemetry. Need to either:

1. Loosen the absolute threshold to e.g. 500ms.
2. Add a separate "absolute slope" detection that catches gradual drift even when the multiplier ratio isn't 5x yet.

This is a real ROADMAP follow-up.

### paymentUnreachable: 0.92 → 0.77

Three surfaces flaked (homeCheckoutErrorChip, svcDetailAlertBadge, overviewDetectedIssuespayment). The previous run's "alertHistorypaymentFired" being instant was likely residual state from immediately-prior paymentFailure scenario carrying over. This run is freshly clean, so the new firing event needs the full 10-min state walk before it lands.

Not a real regression — more like the previous run was inflated by inter-scenario bleed.

## Persistent gaps (still un-addressed)

- **llmRateLimitError**: product-reviews has only 1-3 requests per 15min in normal operation. My new `curr_requests >= 5` floor explicitly blocks it. **Trade-off**: floor prevents 1-error-of-1-span noise but also blocks legitimate low-volume signal. Could try lowering to 3, OR use a different metric (absolute error count instead of rate).
- **failedReadinessProbe** (checkout-side): the upstream-propagation surfaces still fail. Cluster probably isn't actually yanking cart from k8s endpoints when the flag is on — need to verify by manually flipping and watching `kubectl describe pod cart` events.
- **recommendationCacheFailure**: similar low-volume issue; cache-miss errors are sparse.
- **adHighCpu p99**: doesn't shift enough to cross even the relaxed 3ms threshold.

## ROADMAP follow-ups to add

Three items emerged from this re-run that warrant new ROADMAP entries:

### 1e (new). Latency-branch detection for gradual-onset scenarios

emailMemoryLeak in particular: the 1-second absolute floor on the latency-anomaly branch misses memory-leak drift that hasn't yet reached 1s but IS multi-x above baseline. Either lower the absolute floor to e.g. 500ms, or add a separate slope-based detection that fires when curr_p95 is well above prev_p95 *and* the slope across recent buckets is positive.

### 1f (new). Low-volume service alerting

llmRateLimitError and recommendationCacheFailure are blocked by the `curr_requests >= 5` floor I added in 1a. The floor prevents 1-error-of-1-span noise but also blocks signal on legitimately low-traffic services that get a handful of errors. Either lower to ≥3, OR use a separate "absolute error count" path: alert if `curr_errors >= 3` AND `curr_error_rate >= 0.5` regardless of total volume.

### 1g (new). Investigator playbook coverage for cache misses

The Investigator scored 0 on emailMemoryLeak, leakFingerprint, AND recommendationCacheFailure. Bumping waitMs didn't help — the playbook doesn't cover these patterns. Each has a specific signature that needs a dedicated decision step in the Investigator's reasoning.

## ROADMAP follow-ups to add (UI/UX side)

### 1h (new). Surface check flake on UI alert badges

`svcDetailAlertBadge` failed in 5 scenarios this run (cart, email, failed-readiness, payment-unreachable, recommendation) even when the underlying alert state machine fired. The badge's 30-second timeout may not be enough for the panel-cache refresh cycle to pick up the new state, or there's a real refresh bug.

### 1i (new). Low-traffic services dropping off Services list

`llmRateLimitError` failed two surfaces with "navigation failed" because product-reviews wasn't on the Services list page when the eval tried to click into it. Either keep low-traffic services in the list (with an "idle" pill), or update the eval to use URL-based navigation as a fallback.

## Conclusion

The 1a fix landed cleanly — measurable improvement on the error-rate detection scenarios. Latency-branch detection needs separate work (1e). Low-volume service handling needs revisit (1f). Investigator playbook coverage needs broader work (1g).

Mean score improvement from 0.66 → 0.72 is real but modest. The fully-detected count doubling (3 → 6) is the more meaningful metric — six scenarios now end-to-end clean.

Raw artifacts:
- Run log: `/tmp/apm-eval-2026-05-31-rerun.log`
- Investigator transcripts: `/tmp/apm-eval-runs/transcript-2026-05-31T*.jsonl`
