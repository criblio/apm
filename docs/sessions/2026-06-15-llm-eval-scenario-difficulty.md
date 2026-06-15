# LLM eval harness — scenario difficulty when only standard Linux tools are available

This session pairs the 15 documented failure scenarios in
`FAILURE-SCENARIOS.md` with two difficulty estimates for an LLM
that has only `grep` / `jq` / `awk` / `sort` / `uniq` / `wc` /
`cut` against raw OTel span NDJSON (no Cribl Search, no APM app,
no metrics/log pipelines beyond what the demo emits).

The two estimates are:

1. **Problem-domain identification** — "what's wrong, and where?"
   Surface the anomaly: which service, operation, or attribute is
   misbehaving.
2. **Root-cause analysis** — "why is it happening?" Either name a
   plausible cause from the available signals, or correctly
   conclude that the cause is not visible in this telemetry and
   say what additional data would be needed.

These two ranks **disagree often** — many scenarios are easy to
spot the symptom but hard to explain the cause, because the
actual cause lives off the trace path (kafka broker, JVM, CPU,
memory, k8s control plane).

## Assumptions

- OTel demo data ingested as NDJSON spans (one JSON object per
  line) — or a `jq -c '.resourceSpans[].scopeSpans[].spans[]'`
  pre-step has been done. Each span exposes `service.name`,
  `name`, `kind`, `traceId`, `spanId`, `parentSpanId`,
  `startTimeUnixNano`, `endTimeUnixNano`, `attributes`,
  `status.code`.
- Logs and metrics are *not* in scope (matches what the demo
  ships out-of-the-box for traces).
- A reasonable lookback (15–60 min) is provided. The LLM can run
  multiple `jq` passes within a token/turn budget.
- Duration is `(endTimeUnixNano − startTimeUnixNano) / 1e6` ms,
  computed in `jq` or `awk`.

## Problem-domain identification (where is the problem?)

### Easy — first natural query finds it

Shape is "many error spans on one service." A `jq 'select(.status.code==2) | .resource.attributes["service.name"]' | sort | uniq -c` pass lights up the answer.

- **1. paymentFailure (50%)** — 50% of `payment.Charge` spans error.
- **5. cartFailure** — same pattern, `cart` service.
- **9. paymentUnreachable** — 100% of `payment` spans error with `UNAVAILABLE`.
- **14. llmRateLimitError** — same pattern, `product-reviews` with rate-limit messages.
- **4. loadGeneratorFloodHomepage** — count spans/min on `frontend`; ~100× spike is obvious in any time bucket. Easy *if* the model thinks to bucket by time (borderline easy/medium).

### Medium — needs aggregation, time bucketing, or attribute drill-down

- **2. kafkaQueueProblems** — compute per-span duration, sort, notice multi-second spans concentrated on `accounting` / `fraud-detection` consumers.
- **10. adHighCpu** — broad latency shift on `ad`; even mean duration moves up. `awk` over durations grouped by service.
- **8. recommendationCacheFailure** — intermittent errors + latency creep on `recommendation`; two correlated signals on one service.
- **7. productCatalogFailure** — first pass finds "errors on product-catalog." Real diagnosis requires `jq` into `attributes."app.product.id"` and noticing all errors share one value. Tests whether the model drills into attributes.
- **6. adFailure (10%)** — chronic low-rate errors on a low-traffic operation; needs the model to compute per-operation error ratios, not eyeball totals.
- **12. failedReadinessProbe** — connection-refused errors from `cart`'s callers are detectable. The *root cause* (k8s event) isn't in the trace stream — see RCA section.

### Hard — subtle distributional/time-series signal

- **3. adManualGc** — bimodal p99 spike on `ad` while p50/mean barely move. A simple "average duration by service" pass shows nothing. Model has to compute percentiles per time bucket or look at the tail of the duration distribution.
- **11. emailMemoryLeak** — slow upward drift in `email` latency over minutes, then a brief error burst at OOM restart. Needs time-bucketed trend analysis, not point-in-time aggregation.

### Effectively undetectable from backend traces

- **13. llmInaccurateResponse** — wrong answer for one product, no telemetry change.
- **15. imageSlowLoad** — Next.js client-side delay; backend p95 stays flat.

## Root-cause analysis (why is it happening?)

The RCA axis splits scenarios very differently. Cases where the cause is feature-flag-injected error behavior visible in messages or status codes stay easy; cases where the real cause is an off-platform resource (JVM, kernel, k8s, broker) become hard or impossible from traces alone.

### RCA feasible from traces

- **1. paymentFailure / 5. cartFailure / 9. paymentUnreachable** — best the model can correctly say: "intermittent (or 100%) errors on `payment.Charge` / `cart.*` with no upstream caller-side anomaly; cause is local to that service." That **is** the right RCA conclusion — the actual cause (feature-flag injection) is unknowable from telemetry, and the model should not invent more.
- **7. productCatalogFailure** — strong RCA test. All error spans share `attributes."app.product.id" = "OLJCESPC7Z"`. A model that finds the cluster nails RCA: "errors are scoped to one product ID." Models that stop at "product-catalog is erroring" miss the cause.
- **4. loadGeneratorFloodHomepage** — root cause visible in the trace mix: a new trace class like `user_flood_home` appears; the load generator is the source. Reasonable RCA.
- **14. llmRateLimitError** — if the error message text contains "rate limit" / `429`, RCA is essentially read off the message. Otherwise generic "LLM call failing."
- **6. adFailure** — error message + operation path (`GetAds` → `UNAVAILABLE`) is identifiable. Same RCA shape as #1: "intermittent errors at ad.GetAds, no upstream cause."

### RCA hard or impossible from traces alone

The cause lives off the telemetry path. The model should characterize the symptom and explicitly say "additional data needed."

- **2. kafkaQueueProblems** — consumer spans are slow; inferring "kafka queue backed up" requires broker lag metrics or producer→consumer span links. From spans alone: "fraud-detection / accounting consumer processing time has multi-second tail."
- **3. adManualGc** — bimodality alone doesn't say "GC." Could be batch processing, lock contention, periodic background work. Honest RCA: "intermittent pauses on ad — could be GC, periodic flush, lock contention; would need JVM or runtime metrics to distinguish."
- **8. recommendationCacheFailure** — "cache failing" is only diagnosable if Redis spans, cache hit/miss attributes, or error messages mentioning cache are present. Otherwise: "recommendation is degraded on both latency and errors."
- **10. adHighCpu** — distribution shifts right uniformly. Possible causes: CPU saturation, downstream blocking, GC tuning, lock contention. Honest RCA: "ad is uniformly slower — would need CPU / runtime metrics to distinguish saturation from contention."
- **11. emailMemoryLeak** — latency drift + periodic restart-shaped error bursts. "Memory leak" is a guess. Honest RCA: "email latency drifts upward over minutes with periodic recovery events — consistent with leak / queue buildup / GC pressure; would need memory metrics or restart events to confirm."
- **12. failedReadinessProbe** — root cause is in k8s events. From traces: "cart is intermittently unreachable from its callers; pattern is consistent with pod removed from service endpoints or rolling restart — would need k8s events to confirm."

### RCA impossible — by design

- **13. llmInaccurateResponse / 15. imageSlowLoad** — same as domain identification. The harness should reward "I don't see a signal that explains this" and penalize confabulation.

## How RCA changes harness design

The two axes test **different model skills** and should be scored independently:

1. **Surfacing skill** — does the model do basic enumeration: filter by status, group by service/operation, look at attribute clusters, bucket by time, compute simple distributions?
2. **Epistemic skill** — does the model know the limits of trace-based RCA? Does it correctly say "the cause is not in this telemetry; would need X" rather than confidently naming a wrong cause?

The second is more interesting and more likely to discriminate between models. A model that confidently labels emailMemoryLeak as "memory leak" from latency-drift alone is **hallucinating**, even if the answer happens to be correct — the model has no signal that distinguishes leak from "queue buildup" or "downstream slowdown."

### Recommended scoring rubric

For each scenario, three independent judgments:

| Judgment | Rewards |
|---|---|
| **Located** | Did the model name the right service / operation / attribute? |
| **Characterized** | Did the model accurately describe the *shape* of the signal (intermittent, persistent, tail-only, time-correlated)? |
| **Honest RCA** | Did the model correctly name a cause AND distinguish "supported by data" from "consistent with but not proven"? Or correctly say "telemetry insufficient"? |

`Located` × `Characterized` measures the surfacing skill. `Honest RCA` measures epistemic discipline. The combined score should weight epistemic discipline highly — that's the rare capability.

### Negative controls

- **All flags off** — true-negative baseline. A model that "finds" an issue is hallucinating.
- **#13 llmInaccurateResponse and #15 imageSlowLoad** — telemetry shows nothing. The correct answer is "no backend trace signal; would need response-content inspection / RUM." Scoring them out of the test inflates apparent accuracy; keeping them in measures hallucination rate.

### Domain-easy / RCA-hard scenarios are the most valuable discriminators

The biggest model-vs-model gaps will appear on scenarios where **domain identification is straightforward but RCA tempts confabulation**:

- **2 kafkaQueueProblems** — domain easy, RCA needs honesty about kafka opacity
- **3 adManualGc** — domain medium, RCA tempts "GC!" without runtime data
- **10 adHighCpu** — domain medium, RCA tempts "CPU!" without resource metrics
- **11 emailMemoryLeak** — domain hard, RCA tempts "memory leak!" with no memory signal
- **12 failedReadinessProbe** — domain medium, RCA tempts "readiness probe!" with no k8s events

Each of these has a sharp correct answer ("symptom is X; cause is consistent with Y, Z, or W; would need additional telemetry of type T to distinguish"). Models that produce that shape of answer are notably better than models that pick the first plausible label.

## Tooling considerations

- `jq` over many GB of NDJSON is slow but workable. If the data set is large, pre-shard by service or pre-extract `(service, name, status, duration_ms, time_min)` into TSV. That tooling choice effectively shifts the medium/hard line — pre-extracted duration columns make #3 and #11 substantially more tractable. Decide deliberately whether you're testing the model's *reasoning* or its *jq fluency*.
- For percentile computation in `awk`, the LLM needs to know the trick: collect into an array, sort, index at `n * p`. Many models will reach for a built-in that doesn't exist. Probably worth allowing `datamash` (single binary, no deps) as a quality-of-life tool — `datamash` perc:95 0 is standard Linux-ish.
- If you want to keep `awk`-only for purity, expect models to either lose points on #3/#11 or burn a turn writing a manual percentile function.

## Summary table

| # | Scenario | Domain rank | RCA rank | Notes |
|---|---|---|---|---|
| 1 | paymentFailure | Easy | Easy* | RCA = "local errors, no upstream cause" |
| 2 | kafkaQueueProblems | Easy/Med | Hard | Domain: slow consumers. RCA: kafka opaque from spans |
| 3 | adManualGc | Hard | Hard | Bimodal p99; cause not distinguishable from runtime data |
| 4 | loadGeneratorFloodHomepage | Easy | Medium | New trace class names the source |
| 5 | cartFailure | Easy | Easy* | Mirror of #1 |
| 6 | adFailure | Medium | Medium | Low-rate, but error message identifies operation |
| 7 | productCatalogFailure | Medium | Medium | Attribute clustering is the RCA |
| 8 | recommendationCacheFailure | Medium | Hard | Two signals, cause depends on cache-layer telemetry |
| 9 | paymentUnreachable | Easy | Easy* | 100% errors localized to one service |
| 10 | adHighCpu | Medium | Hard | Uniform latency shift; cause needs resource metrics |
| 11 | emailMemoryLeak | Hard | Hard | Drift + burst; cause needs memory/restart data |
| 12 | failedReadinessProbe | Medium | Hard | Cause in k8s events, off-platform |
| 13 | llmInaccurateResponse | None | None | Negative control |
| 14 | llmRateLimitError | Easy | Medium | Message text carries the cause |
| 15 | imageSlowLoad | None | None | Negative control |

\* "Easy" RCA = correct answer is "local errors with no upstream cause; the actual cause (flag injection) is unknowable from telemetry, and that should be stated."
