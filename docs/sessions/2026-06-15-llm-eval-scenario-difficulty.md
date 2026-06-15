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

All three OTel signal types are available — **traces, logs,
metrics** — ingested as NDJSON (one OTLP record per line, or
pre-flattened to one span / log / metric data point per line).
This matches what the OTel demo emits by default once the
collector is configured for all three pipelines.

- **Spans** expose `service.name`, `name`, `kind`, `traceId`,
  `spanId`, `parentSpanId`, `startTimeUnixNano`,
  `endTimeUnixNano`, `attributes`, `status.code`.
- **Logs** expose `service.name`, `severityNumber`,
  `severityText`, `body` (text or structured), `timeUnixNano`,
  `attributes`, often `traceId` / `spanId` for trace correlation.
- **Metrics** expose `name`, `dataPoints[].asDouble` (or
  `asInt`), `dataPoints[].timeUnixNano`,
  `dataPoints[].attributes`, and metric type
  (gauge / sum / histogram). Standard OTel demo emissions
  include:
  - **HTTP / RPC server**: `http.server.request.duration`,
    `http.server.active_requests`, `rpc.server.duration`
  - **JVM runtime** (ad, fraud-detection, accounting):
    `process.runtime.jvm.gc.duration`,
    `process.runtime.jvm.memory.usage`,
    `process.runtime.jvm.cpu.utilization`,
    `process.runtime.jvm.threads.count`
  - **Go runtime** (checkout, product-catalog, frontend, etc.):
    `process.runtime.go.gc.count`,
    `process.runtime.go.mem.heap_alloc`,
    `process.runtime.go.goroutines`
  - **Node.js runtime** (frontend, payment): equivalents under
    `process.runtime.nodejs.*`
  - **Process**: `process.cpu.utilization`,
    `process.memory.usage` (when collector hostmetrics receiver
    is enabled)
  - **Kafka**:
    `messaging.kafka.client.consumer.records.consumed`,
    `messaging.kafka.consumer.lag` (presence depends on collector
    config — discussed in scenario #2)
  - **Custom business metrics** (small set in the demo, e.g.
    `app.frontend.recommendations_counter`)
- A reasonable lookback (15–60 min) is provided. The LLM can run
  multiple passes within a token/turn budget.
- Duration is `(endTimeUnixNano − startTimeUnixNano) / 1e6` ms,
  computed in `jq` or `awk`. Histogram-based duration metrics
  (`http.server.request.duration`) carry bucket counts —
  percentiles can be derived from them without going to spans.
- **What signal is and isn't in the demo matters for the harness
  authors to verify.** Two emissions worth confirming before
  finalizing the scenario set:
  - `messaging.kafka.consumer.lag` — emitted only if the
    collector's kafka receiver is configured. Without it,
    scenario #2 stays RCA-hard.
  - **k8s events** as OTel logs — emitted only if the collector
    has the `k8sobjects` receiver or `k8sevents` receiver wired.
    Without it, scenario #12 stays RCA-hard.

## Problem-domain identification (where is the problem?)

With logs and metrics added, the **rate-spike** and **chronic
low-rate-error** scenarios get cleaner signal paths (HTTP request
count metrics, error counter metrics) but the domain-identification
ranks don't move much — the fastest path to "which service" is
still usually error-span counts. The shifts show up in RCA.

### Easy — first natural query finds it

Shape is "many error spans on one service." A `jq 'select(.status.code==2) | .resource.attributes["service.name"]' | sort | uniq -c` pass lights up the answer. Equivalently for logs: `severityNumber >= 17` (ERROR) grouped by service.

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

The RCA axis is where logs + metrics matter most. Scenarios
whose root cause lives in **JVM, Go-runtime, or process
metrics** (CPU, memory, GC, goroutines) move from
"trace-impossible" to "metric-easy" — if the harness's data
set includes those emissions. Scenarios whose cause lives in
**logs** (error messages with embedded context like product IDs
or rate-limit codes) get cleaner signal paths than digging
through span attributes.

What stays hard is anything off the OTel pipeline entirely —
kafka broker internals (without the collector's kafka receiver)
and k8s control-plane events (without the `k8sobjects` /
`k8sevents` receiver).

### RCA feasible — symptom → cause is a direct read

- **1. paymentFailure / 5. cartFailure / 9. paymentUnreachable** —
  Logs almost certainly include the injected exception stack
  trace, which names the throwing class and (often) the
  feature-flag check. A model with logs in scope can usually
  say "service is throwing a flag-gated exception at call site
  X" — a much stronger RCA than the trace-only conclusion of
  "local errors with no upstream cause."
- **7. productCatalogFailure** — Two RCA paths now: span attribute
  drill-down on `app.product.id`, **or** error log body grep
  for the product ID. Logs likely produce the cleaner one-liner.
- **4. loadGeneratorFloodHomepage** — Best RCA signal is now the
  HTTP request count metric on `frontend` showing the step
  change, plus the new `user_flood_home` trace class — two
  corroborating signals beat one.
- **14. llmRateLimitError** — Logs trivially carry "rate limit" /
  `429` and which provider returned it. Stronger than the
  trace-only path.
- **6. adFailure** — Error logs identify the `GetAds` handler;
  the operation-level error counter metric quantifies the rate
  cleanly without per-span counting.

### RCA newly feasible because logs/metrics surface the cause

These were trace-only-hard and become **directly diagnosable**
once metrics are in scope. They are no longer good
discriminators against confabulation — instead, they test
whether the model knows **which signal to look at**.

- **3. adManualGc** — `process.runtime.jvm.gc.duration` histogram
  shows the GC pause spikes with timestamps that correlate to
  the p99 sawtooth. A model that pulls JVM GC metrics nails RCA
  in one step. Tests *knowing JVM metric names exist*.
- **10. adHighCpu** — `process.runtime.jvm.cpu.utilization` (or
  `process.cpu.utilization` from hostmetrics) sustained near 1.0
  on `ad` is unambiguous. Combined with the latency shift this
  is a textbook CPU-bound diagnosis.
- **11. emailMemoryLeak** — `process.runtime.python.memory` /
  `process.runtime.nodejs.heap_used` (whichever the email service
  emits) shows monotonic growth followed by a reset — the
  characteristic leak-then-OOM-restart shape. Combined with
  trace latency drift and a brief error burst at restart, the
  diagnosis is direct.
- **8. recommendationCacheFailure** — Redis client spans (the demo
  emits these) and/or cache hit/miss attributes on
  `recommendation` spans surface the cache failure. Error logs
  likely contain "cache" / "redis" terms. Multiple
  corroborating signals.

### RCA conditionally feasible — depends on collector config

- **2. kafkaQueueProblems** — IF the collector's kafka receiver
  is enabled and emitting `messaging.kafka.consumer.lag`, the
  metric tells the story directly (lag growing on
  `fraud-detection` / `accounting` consumer groups). IF NOT,
  RCA stays at the trace-only level ("consumer processing has
  multi-second tail; would need broker lag metrics to confirm
  kafka congestion"). **Verify what your demo cluster emits
  before scoring** — answer to "is this scenario a discriminator"
  changes entirely with collector config.
- **12. failedReadinessProbe** — IF the collector's `k8sobjects`
  or `k8sevents` receiver is wired, the readiness-probe failure
  appears as a structured log event ("Readiness probe failed"
  for `cart-*` pod). RCA becomes a one-line grep. IF NOT, the
  symptom side (intermittent connection-refused to cart) is the
  best the model can offer, and "consistent with k8s removing
  the pod from endpoints — would need k8s events to confirm" is
  the right honest answer.

### RCA structurally impossible — keep as negative controls

- **13. llmInaccurateResponse** — Logs and metrics don't help.
  The service that returned the wrong answer doesn't know it's
  wrong. No telemetry path. Correct answer: "no signal anywhere
  that explains this; would need response-content evaluation
  against a known-answer baseline."
- **15. imageSlowLoad** — Potentially a borderline case worth
  verifying. The OTel demo's Next.js frontend ships with
  `@opentelemetry/sdk-trace-web` and *may* emit browser-side
  spans with `http.url` referencing image endpoints. If those
  reach the dataset, the model could find a frontend-origin
  span with seconds-long duration on an image URL — moving this
  from "undetectable" to "medium." **Verify what the demo
  actually emits client-side.** If browser telemetry isn't in
  the dataset, this stays a true negative control.

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

### Discriminators shift when logs and metrics are in scope

With traces-only, the best discriminators were scenarios that
tempted confabulation: #3 (GC), #10 (CPU), #11 (memory leak),
#12 (readiness probe) — each had a "first plausible label" that
the data didn't actually support, and good models got rewarded
for saying so.

With **logs + metrics in scope**, three of those (#3, #10, #11)
become directly diagnosable from JVM / process metrics. They no
longer test epistemic discipline — they test **multi-signal
literacy**: does the model know to leave the traces and look at
runtime metrics?

The new discriminator clusters:

**Multi-signal literacy** — model has to switch signal types
to RCA, not stay in spans:

- **3. adManualGc** — model must look at JVM GC duration
  histogram, not stop at trace bimodality
- **10. adHighCpu** — model must look at process / JVM CPU
  utilization metric
- **11. emailMemoryLeak** — model must look at runtime memory
  metric AND notice the periodic reset
- **8. recommendationCacheFailure** — model must look at Redis
  client spans or cache hit/miss attributes

These distinguish "models that reflexively grep error spans"
from "models that pick the right signal type for the question."

**Epistemic discipline remaining** — scenarios where the right
answer is still "telemetry insufficient":

- **2. kafkaQueueProblems** — only if collector lacks kafka
  receiver. If lag metrics are present, this becomes a
  multi-signal-literacy test instead.
- **12. failedReadinessProbe** — only if k8s events are not
  ingested. Same caveat.
- **13. llmInaccurateResponse** — no telemetry can fix this.
  Hard negative control.

The honest correct answer for the conditional ones changes
depending on what your harness's data actually contains. Decide
which version of #2 and #12 you want — and if you want a clean
epistemic-discipline test, deliberately exclude the receivers
that make them easy.

**Cross-signal correlation** — scenarios where the strongest
RCA combines two or more signals:

- **1, 5, 9** — error span + log stack trace is a much stronger
  answer than either alone
- **4. loadGeneratorFloodHomepage** — HTTP request count metric
  step + new trace class
- **7. productCatalogFailure** — span attribute cluster + error
  log substring on the product ID

Reward models that synthesize across signals; penalize models
that report a single-signal answer when a richer one was
trivially available.

## Tooling considerations

### Volume and signal separation

With three signal types in scope, **shard the dataset by signal
type at minimum**: separate NDJSON files (or directories) for
spans, logs, and metrics. A model that has to filter the right
signal out of a single mixed file burns turns on plumbing. The
files-on-disk should answer "where do I look for X?" without a
turn.

Within each signal type, also consider pre-flattening:

- **Spans** → one span per line (`jq -c
  '.resourceSpans[].scopeSpans[].spans[]'`)
- **Logs** → one log record per line
- **Metrics** → one data point per line, with `metric_name`
  flattened to a top-level field and `dataPoints[].attributes`
  promoted onto the row. Histograms expand to one row per
  bucket boundary, or keep the histogram array intact if you
  expect the model to compute percentiles from buckets directly.

Pre-extraction matters more with all three signals than with
spans alone — `jq` over GB-scale logs is genuinely slow.
Pre-extracting `(service, ts_min, severity, body_summary)` for
logs and `(service, ts_min, metric_name, value, attrs)` for
metrics into TSV makes the harness reasoning-bound rather than
plumbing-bound. Decide deliberately whether you're testing the
model's *reasoning* or its *`jq` / `awk` fluency*.

### Recommended toolset

The minimum (`jq` / `awk` / `grep` / `sort` / `uniq` / `wc` /
`cut` / `sed`) is enough to detect everything in the table, but
forces models to write manual percentile and group-by code in
`awk` — burning a turn on plumbing that the better-equipped
models would skip. Suggested extensions, all of which are
single binaries from standard distro repos (no network, no
vendor accounts, no runtimes):

| Tool | Use | Install |
|---|---|---|
| `datamash` | percentiles, mean, median, group-by-and-aggregate on TSV | `apt install datamash` / `brew install datamash` (GNU, GPL) |
| `mlr` (Miller) | "awk for JSON/CSV/TSV" — group-by, stats, joins, type-aware | `apt install miller` / `brew install miller` (BSD-2) |
| `bc` | arbitrary-precision math (timestamp arithmetic without overflow) | already in coreutils on most systems |
| `parallel` | parallelize `jq` over sharded files | `apt install parallel` / `brew install parallel` (GNU, GPL) |
| `dateutils` | date math (bucket timestamps, diff times) | `apt install dateutils` / `brew install dateutils` (BSD-3) |

Notable inclusions:

- **`datamash`** — turns "compute p50/p95/p99 per service" from a
  ~15-line `awk` script into one pipeline. Without it, expect
  models to either lose points on #3 / #11 or burn a turn
  writing manual percentile code. Recommended baseline.
- **`mlr` (Miller)** — group-by over JSON without round-tripping
  to TSV. `mlr --ijson stats1 -a p95,p99 -f duration_ms -g
  service` is a strong alternative to a `jq` + `datamash`
  pipeline. Worth including because it's idiomatic for the
  problem shape, and a capable model will reach for it.

Notable **exclusions**:

- **`q` / `csvkit` / `osquery`** — language runtimes attached
  (Python), inflate the "what's installed" surface.
- **`xsv`** — fine, but `mlr` covers the same ground with more
  range; pick one.
- **Anything network-attached** (HTTPie, curl-with-cribl) —
  defeats the point of the harness.

### Tooling × difficulty rankings

Allowing `datamash` and `mlr` shifts the hard end of the
tracing-only ranks for #3 and #11, but with logs and metrics in
scope, those scenarios are now already-tractable from runtime
metrics — the tooling shift matters less for them.

Where the extended tools matter most with full signals:

- **Time-bucketed metric analysis** is `mlr`'s sweet spot.
  Detecting a memory-leak ramp in `process.runtime.python.memory`
  is `mlr --ijson filter '$name=="process.runtime.python.memory"'
  then stats1 -a max,min -f value -g service,ts_bucket` followed
  by visual inspection of the delta — clean.
- **Histogram → percentile** on `http.server.request.duration`
  buckets requires either `mlr`'s histogram support or manual
  bucket math. Models without the extended toolset will reach
  for spans instead, which works but is more expensive.
- **Cross-signal joins** — correlating a metric spike to a
  trace error burst by time bucket is a one-liner in `mlr` and
  a multi-step pipeline in `jq` + `awk`.

The other rankings still don't move materially — surfacing is
already feasible with the minimum toolset; RCA limits remain
structural (collector config for #2 and #12), not tooling-limited.

### Decision recommendation

Default to **minimum toolset + `jq` + `datamash` + `mlr`**. It
keeps the eval focused on reasoning rather than `awk` golf,
covers every detection step the harness needs, and stays small
enough that "what tools do you have" fits on one screen in the
model's system prompt. Reserve the `awk`-only version as a
harder variant if you want to measure resourcefulness under
constraint separately.

## Capturing the data from the OTel demo

Recommended path: OTel Collector's `file` exporter writing OTLP
JSON, **one exporter per signal type** so the harness gets
pre-separated `traces.ndjson` / `logs.ndjson` / `metrics.ndjson`
files without filtering.

### Collector config

```yaml
exporters:
  file/traces:
    path: /data/eval/traces.ndjson
    rotation:
      max_megabytes: 100
      max_days: 7
      max_backups: 10
      localtime: true
    format: json           # OTLP JSON, one batch per line
    compression: ""        # leave uncompressed for easy jq/grep

  file/logs:
    path: /data/eval/logs.ndjson
    rotation: { max_megabytes: 100, max_days: 7, max_backups: 10, localtime: true }
    format: json

  file/metrics:
    path: /data/eval/metrics.ndjson
    rotation: { max_megabytes: 100, max_days: 7, max_backups: 10, localtime: true }
    format: json

service:
  pipelines:
    traces/eval:
      receivers: [otlp]
      processors: [batch]   # NO tail sampler on the eval branch
      exporters: [file/traces]
    logs/eval:
      receivers: [otlp]
      processors: [batch]
      exporters: [file/logs]
    metrics/eval:
      receivers: [otlp]
      processors: [batch]
      exporters: [file/metrics]
```

Key choices and why:

- **Separate `eval` pipelines, not just separate exporters.**
  Lets you bypass any tail sampling, rate-limiting, or transforms
  applied to the production pipeline. The eval needs every span —
  sampling 10% of `adFailure`'s already-rare errors loses the
  scenario.
- **OTLP JSON format** preserves status codes, exemplars,
  histogram buckets, log severities, span links. Don't use
  `proto` — `jq` can't read it.
- **Rotation** keeps disk bounded; `max_days: 7` is enough
  headroom for any single eval run.
- **No compression** — biggest tooling win. `jq -c
  'select(.resourceSpans)' /data/eval/traces.ndjson` works
  without a decompress step.

### Receivers that affect scenario difficulty

Two scenarios change RCA difficulty based on which receivers
are enabled:

```yaml
receivers:
  kafkametrics:                  # enables RCA-easy for #2 kafkaQueueProblems
    brokers: ["kafka:9092"]
    protocol_version: 3.0.0
    scrapers: [consumers, brokers, topics]
    collection_interval: 15s

  k8sobjects:                    # enables RCA-easy for #12 failedReadinessProbe
    objects:
      - name: events
        mode: watch
```

Wire `kafkametrics` into the metrics pipeline, `k8sobjects` into
the logs pipeline. **Leave them out** if you want #2 and #12 as
honest "what would you need" tests of epistemic discipline.

### Deployment

The OTel demo's Helm values expose the collector config under
`opentelemetry-collector.config`. Patch in the three eval
exporters + pipelines as an overlay value rather than forking
the upstream chart, so updates stay clean. Mount `/data/eval` as
a `hostPath` (single-node kind/k3d) or a small
`PersistentVolume` claim.

Zero-cluster-touch alternative: run a **second standalone
collector** as a sidecar that receives OTLP from the in-cluster
collector via OTLP-HTTP-forward and writes to a local path on
your eval host. More moving parts but zero risk of breaking the
demo's production pipeline.

### Pre-flattening for the harness

The file exporter writes one *batch* per line — each line
contains an array of resources × scopes × records. For the LLM
you almost certainly want one record per line:

```bash
# Spans — flatten + promote service.name to a top-level field
jq -c '
  .resourceSpans[]
  | .resource as $r
  | .scopeSpans[].spans[]
  | . + { service: ($r.attributes[] | select(.key=="service.name") | .value.stringValue) }
' traces.ndjson > traces.flat.ndjson

# Logs — same shape with .resourceLogs[].scopeLogs[].logRecords[]
# Metrics — .resourceMetrics[].scopeMetrics[].metrics[], then
#           expand dataPoints[] to one row per data point
```

Promoting `service.name` to a top-level field is the single
highest-value transform — every harness query keys on it.

### Capture window per scenario test

The simplest pattern that doesn't require collector restarts:

1. Run the collector continuously with rotation on.
2. For each scenario:
   - Record `t_flag_on`, wait 5 min for a clean baseline window
   - Flip the flag, wait the scenario's observation window
     (5–15 min depending on type — bimodal ones like
     `adManualGc` need longer to surface)
   - Record `t_test_end`, flip the flag off
3. Slice the captured files by `timeUnixNano` between
   `t_flag_on - 5min` (baseline) and `t_test_end + 1min`.

The 5-minute pre-flip baseline gives the model a reference
window for comparison — important for any chip-vs-baseline
reasoning, and for fair scoring on the "is this normal?"
question.

### Volume estimate

The OTel demo at baseline emits roughly:

- **Traces**: ~2–5k spans/min, ~5–15 MB/min uncompressed
- **Logs**: ~1–3k records/min, ~2–5 MB/min
- **Metrics**: ~500 data points/min, ~1 MB/min

Per hour, ~1–2 GB total across signals. A 30-minute eval window
per scenario is ~500–800 MB, well within `jq` / `mlr` /
`datamash` working sizes.

### Things to verify on a first capture

Before scoring any models, do a manual `jq` pass on a clean
capture to confirm:

- `process.runtime.jvm.gc.duration` appears in `metrics.ndjson`
  with non-empty data points during the window
- `process.runtime.jvm.cpu.utilization` (or
  `process.cpu.utilization` from hostmetrics) is present for
  `ad`
- Error logs from `payment` / `cart` carry stack traces in
  `body` (not stripped by a processor)
- If you enabled `kafkametrics`, confirm
  `messaging.kafka.consumer.lag` exists
- If you enabled `k8sobjects`, confirm a "Readiness probe failed"
  log appears when you flip `failedReadinessProbe`

A single missing emission silently turns one of the harness's
RCA-easy scenarios into RCA-hard — worth catching before you
discover it via model score variance.

## Summary table

Ranks reflect the full traces + logs + metrics dataset described
in Assumptions. Where collector configuration meaningfully
changes the answer, both ranks are shown as
"present / absent."

| # | Scenario | Domain | RCA | Best signal for RCA | Notes |
|---|---|---|---|---|---|
| 1 | paymentFailure | Easy | Easy | Error logs (stack trace) | Logs name the throwing class / flag check |
| 2 | kafkaQueueProblems | Easy | Easy / Hard | Kafka consumer lag metric, if emitted | Conditional on collector kafka receiver |
| 3 | adManualGc | Hard (traces) / Easy (metrics) | Easy | `process.runtime.jvm.gc.duration` | Tests multi-signal literacy |
| 4 | loadGeneratorFloodHomepage | Easy | Easy | HTTP request count metric + new trace class | Two corroborating signals |
| 5 | cartFailure | Easy | Easy | Error logs | Mirror of #1 |
| 6 | adFailure | Medium | Easy | Error logs + error counter metric | Low-rate, but signals are clean |
| 7 | productCatalogFailure | Medium | Easy | Error log substring (product ID) | Logs likely shorter path than span attrs |
| 8 | recommendationCacheFailure | Medium | Easy | Redis client spans + cache-related logs | Multi-signal corroboration |
| 9 | paymentUnreachable | Easy | Easy | Error logs (connection refused) | 100% errors localized to one service |
| 10 | adHighCpu | Medium | Easy | `process.runtime.jvm.cpu.utilization` | Tests multi-signal literacy |
| 11 | emailMemoryLeak | Medium | Easy | `process.runtime.*.memory.*` series | Tests multi-signal literacy + time-series reasoning |
| 12 | failedReadinessProbe | Medium | Easy / Hard | k8s event log, if ingested | Conditional on collector k8s receiver |
| 13 | llmInaccurateResponse | None | None | — | Hard negative control |
| 14 | llmRateLimitError | Easy | Easy | Error logs (429 / rate limit text) | Message text carries the cause |
| 15 | imageSlowLoad | None / Medium | None / Medium | Browser-side spans, if emitted | Conditional on frontend OTel JS reaching dataset |

### What got easier — and what that means for the harness

Compared to the traces-only baseline, six scenarios got
substantially easier on RCA: **#3, #8, #10, #11** (via runtime
metrics), and **#1, #5, #9** (via error log stack traces). The
implication is that the harness's measurement of "epistemic
discipline" has narrowed — most scenarios now have a clear
signal somewhere. The shift is from "does the model know when
the data is insufficient?" toward "does the model know which
signal to look at?"

That's a worthwhile thing to measure on its own — model
**signal-type discrimination** (logs vs metrics vs traces for a
given question) is a distinct capability and a real-world
debugging skill. But if you also want to preserve a strong
epistemic-discipline track, the cleanest path is:

1. Run **two variants** of the harness: a full-signals run and
   a traces-only run. Models that score similarly on both have
   broad signal literacy; models that crater on traces-only
   either depend on the easy path or lack signal-type
   discrimination.
2. Deliberately exclude the kafka receiver and k8s events
   receiver to keep #2 and #12 as honest "what would you need"
   tests under the full-signals condition.
3. Keep #13 (and probably #15) as negative controls under
   either condition.
