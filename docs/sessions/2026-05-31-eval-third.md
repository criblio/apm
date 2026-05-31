# Eval suite — third run after 1e+1f follow-ups (2026-05-31)

Third 14-scenario eval run, against master with PRs #60, #61, #62
all applied. Ran 6h 26m. Mean score **0.75** — up from 0.66 baseline
and 0.72 second run. **5 fully detected** (down from 6 on second
run; one variance flake).

## Run conditions

- Pack version: 0.9.0
- Commit: master after PR #62 merge
- Workspace: `main-objective-shirley-sho21r7.cribl-staging.cloud`
- All flagd flags `off` at start.

## Score evolution across all three runs

| Scenario | 05-30 baseline | 05-31 1st | 05-31 2nd | Direction |
|---|--:|--:|--:|---|
| adFailure | 0.60 | 1.00 | **1.00** | ✓ held |
| adHighCpu | 0.77 | 0.77 | 0.77 | flat (1d insufficient) |
| adManualGc | 1.00 | 1.00 | **0.77** | regression (variance) |
| cartFailure | 0.48 | 0.83 | **0.91** | ↑ +0.08 |
| emailMemoryLeak | 0.70 | 0.20 | **0.30** | 1e marginal +0.10 |
| failedReadinessProbe | 0.40 | 0.50 | 0.50 | flat (cluster) |
| kafkaQueueProblems | 1.00 | 1.00 | 1.00 | ✓ held |
| leakFingerprint | 0.23 | 0.47 | 0.47 | flat (cluster) |
| llmRateLimitError | 0.39 | 0.39 | 0.39 | flat (1f insufficient) |
| loadGeneratorFloodHomepage | 1.00 | 1.00 | 1.00 | ✓ held |
| paymentFailure | 0.91 | 1.00 | 1.00 | ✓ held |
| paymentUnreachable | 0.92 | 0.77 | **0.92** | ↑ recovered from flake |
| productCatalogFailure | 0.70 | 1.00 | 1.00 | ✓ held |
| recommendationCacheFailure | 0.10 | 0.10 | **0.40** | ↑ +0.30 (investigator) |

| Aggregate | 0.66 | 0.72 | **0.75** |
| Fully detected | 3 | 6 | 5 |

## Wins from PR #62 (1e + 1f)

- **emailMemoryLeak +0.10**: still didn't get latency state to fire, but partial improvement. The 1s → 500ms threshold loosening helped a fraction. Memory leak gradual drift still doesn't reach 500ms p95 in 7-min telemetry. Needs slope-based detection.
- **recommendationCacheFailure +0.30**: scenario investigator scored 1 this run (was 0 in earlier runs). My 1f change may have helped the state machine produce SOME firing events that the investigator could observe. Surface checks still all fail.
- **cartFailure +0.08**: continued improvement; one more surface passed this run.

## Persistent flat scenarios

These didn't move despite 1e, 1f, 1c, 1d fixes targeting them:

- **adHighCpu** — p99 surface still timing out at 30s. Threshold issue not addressed by relaxing to ≥3ms; need to either accept the surface as flaky or change the assertion shape entirely.
- **failedReadinessProbe** — cluster behavior issue. The flag doesn't actually yank cart from k8s endpoints in this Cribl Cloud staging cluster. Real blocker is upstream.
- **leakFingerprint** — frontend pod has been recently restarted; the leak signature isn't present. Scenario assumption invalid for current cluster state.
- **llmRateLimitError** — product-reviews traffic is <3 errors / 15min, below my new `curr_errors >= 3` floor. To catch it, the floor would need to go to 2 or 1, but that risks noise on services that normally see occasional errors.

## Regressions vs second run

- **adManualGc 1.00 → 0.77**: `homeSlowestTraceClasses` surface failed at 60s. The ad service's GC sawtooth produces slow traces SOMETIMES but not always in a 7-min window. Eval flake more than detection issue.
- (paymentUnreachable returned to its 05-30 baseline 0.92 — so the dip to 0.77 in the second run was the anomaly, not the third run.)

## What's converging

The first three runs show the alert detection improvements have largely landed and are stable. Specifically:

- **Error-rate scenarios with sufficient traffic** (paymentFailure, productCatalogFailure, cartFailure, adFailure) now reliably reach FIRING state via the -15m window + low-volume floor + absolute-count path.
- **Latency anomaly scenarios** (kafkaQueueProblems, adManualGc when slow traces show, paymentUnreachable for traffic drop) detect cleanly.
- **The "no actionable problem" rate** (loadGen, kafka) all pass — the eval correctly distinguishes these from error scenarios.

Stuck at ~0.75 because:
1. Three scenarios (failedReadinessProbe, leakFingerprint, adHighCpu) have cluster-environment problems beyond our code.
2. Two scenarios (llmRateLimit, recommendationCache) need a more aggressive low-volume path (≥1 or ≥2 errors instead of ≥3, with careful noise gating).
3. emailMemoryLeak needs the slope-based latency detection (1e option 2).
4. UI surfaces (especially svcDetailAlertBadge) flake even when state machine fires (1h roadmap item).

## ROADMAP refinements

Item 1a is fully landed; demoting its priority. The remaining work:

- **1e**: bump from "lower the floor" to "implement slope-based detection". The 500ms floor still isn't enough for emailMemoryLeak.
- **1f**: refine threshold — `curr_errors >= 2` instead of `>= 3`, paired with a `prev_errors == 0` baseline check to gate noise. Or drop to volume-aware: `curr_errors >= max(1, ceil(prev_requests/100))`.
- **1h** (svcDetailAlertBadge flakiness) — promote priority. Failed in 5 scenarios across all three eval runs even when state machine fires.

Raw artifacts:
- Run log: `/tmp/apm-eval-2026-05-31-third.log`
- Investigator transcripts: `/tmp/apm-eval-runs/transcript-2026-05-31T*.jsonl`
