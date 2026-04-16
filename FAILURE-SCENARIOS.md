# Failure scenarios — enabling demo flags and validating them in the UI

The upstream OpenTelemetry Demo ships a [flagd](https://flagd.dev/) service
with 15 failure-injection flags. This document covers how to turn each one
on against your demo cluster, what telemetry signals to expect, and
which view in the Cribl APM app is supposed to surface it. Use this as a
regression test plan when iterating on the app.

## Prerequisites

- A running [otel-demo-criblcloud](https://github.com/criblio/otel-demo-criblcloud)
  cluster (kind, k3d, real k8s — anywhere flagd's `flagd-ui` sidecar is
  reachable)
- `FLAGD_UI_URL` env var pointing at flagd-ui. The pack ships flagd as a
  `ClusterIP` service so the simplest path is a port-forward:
  ```bash
  kubectl -n otel-demo port-forward --address 0.0.0.0 svc/flagd 4000:4000 &
  export FLAGD_UI_URL=http://localhost:4000
  ```
  Persist `FLAGD_UI_URL` in `.env` so you don't have to re-export it
  every session
- Cribl APM app is deployed to the Cribl Cloud staging environment
  and the OTel telemetry pipeline is shipping data to the `otel` dataset

## Helper script

```bash
# List every flag, its variants, and current state
scripts/flagd-set.sh --list

# Show which flags are currently active (non-off)
scripts/flagd-set.sh --status

# Turn a flag on (variant name must match the flag's variants exactly)
scripts/flagd-set.sh paymentFailure 50%
scripts/flagd-set.sh kafkaQueueProblems on
scripts/flagd-set.sh emailMemoryLeak 100x

# Revert one flag
scripts/flagd-set.sh paymentFailure off

# Revert every flag at once (use this after any test session)
scripts/flagd-set.sh --all-off
```

Under the hood the script just calls flagd-ui's HTTP API
(`GET $FLAGD_UI_URL/api/read` / `POST $FLAGD_UI_URL/api/write`). The
write triggers flagd's file-watch reload, so changes take effect in
under a second with no pod restart.

## Best practices for observing a scenario

- **Wait ~2 minutes after turning on.** Telemetry needs to flow through
  the OTel Collector, into Cribl, and through the app's lookback window.
- **Use a 15-minute range** on Home and Service Detail, not the default
  1 hour. The 1h window dilutes fresh signal with baseline noise.
- **Watch the baseline delta chips** (▲/▼ pills next to rate / error rate
  / p95 / p99). They compute `current-window vs previous-window-of-same-
  length`, so the cleanest signal is when the flag was off for the whole
  previous window and is on now.
- **After testing, revert with `--all-off`.** Leaving flags on skews every
  future observation until you do.

## Automated catalog validation

`tests/scenarios/flagd-catalog-validation.spec.ts` flips each of the
flags tagged §6 / §7 / §14 below in turn and confirms each one injects
`status.code=2` spans on the expected service, using a post-flip
timestamp filter so residual errors from prior runs don't satisfy the
assertion. Run it after bumping otel-demo's upstream services to catch
regressions like "the flag's boolean check got removed from one RPC".
Per-flag budget is generous enough to accommodate Bernoulli-rate flags
(`adFailure` is 10% per request — see §6).

```bash
npx playwright test tests/scenarios/flagd-catalog-validation.spec.ts
```

The spec prints a per-flag summary with error counts and first-
observed elapsed time on exit. Treat a zero-error row or a timeout as
a signal to open an upstream issue against `open-telemetry/opentelemetry-demo`.

---

## Scenarios

Each section covers: what the flag does, what telemetry shape it
produces, which UI surface catches it, and any known limitations.

### 1. `paymentFailure` — hard error injection

```bash
scripts/flagd-set.sh paymentFailure 50%
```

Variants: `off`, `10%`, `25%`, `50%`, `75%`, `90%`, `100%`.

**Signal shape.** `payment` service gRPC `Charge` calls fail N% of the
time with `status.code=2` (ERROR). The failure propagates upstream: the
`checkout` service catches the error and its `PlaceOrder` span is also
marked errored.

**Where it shows up in the UI:**
- **Home catalog**: `payment` row's error-rate cell gets a red ▲+Npp
  delta chip. `checkout` gets a smaller one (propagated). Row background
  tints to warn/critical.
- **System Architecture (graph + isometric)**: the `checkout → payment`
  edge goes red (edge-level health). Hover shows call count / error %
  / p95.
- **Service Detail (`payment`)**: Errors RED chart jumps from 0% to
  ~(2 × variant)% at the exact time the flag was flipped. Recent errors
  panel lists traces with the error message.
- **Home > Error classes** panel lists the error messages grouped by
  `(service, operation, first-line-of-message)`.
- **Logs tab**: ❌ nothing — `paymentFailure` only emits gRPC status,
  not log records.

---

### 2. `kafkaQueueProblems` — consumer lag

```bash
scripts/flagd-set.sh kafkaQueueProblems on
```

Variants: `off`, `on`.

**Signal shape.** Kafka is overloaded and consumer processing is
delayed. `checkout` produces order messages normally; `accounting` and
`fraud-detection` consume them but with multi-second lag. Spans from
these consumers have durations in the tens to hundreds of seconds.

**Where it shows up:**
- **Home catalog**: `fraud-detection` p99 gets a huge red ▲+N% chip
  (often thousands of percent). `accounting` similarly.
- **Home > Slowest trace classes**: `accounting order-consumed` and
  `load-generator user_checkout_multi` appear near the top with
  multi-minute durations.
- **Service Detail (`fraud-detection` or `accounting`)**: Duration RED
  chart shows dramatic p99 spikes after the flag was flipped; p50
  stays low (only tail is affected). The Errors chart may also show
  periodic ~100% bursts if the consumer fully gives up on some batches.
- **System Architecture**: `checkout → fraud-detection` / `accounting`
  edges show via the messaging lens (dashed stroke). Without the
  messaging lens, kafka edges are invisible because OTel propagates
  producer→consumer via span links, not parent-child.
- **Logs tab**: ❌ the OTel demo services don't emit structured log
  records about kafka lag.

---

### 3. `adManualGc` — bimodal GC pauses

```bash
scripts/flagd-set.sh adManualGc on
```

Variants: `off`, `on`.

**Signal shape.** `ad` service triggers full manual GC runs periodically,
pausing the JVM for ~500ms to several seconds. The baseline p50 stays
around 1ms, but p99 spikes to hundreds of ms or seconds during pauses.
Looks like a **bimodal** distribution that p95 alone often misses.

**Where it shows up:**
- **Service Detail (`ad`)**: Duration RED chart shows a clear sawtooth
  pattern on the p99 line while p50 and p95 stay flat.
- **Home catalog**: `ad` row's **p99** column gets a red ▲+N% delta chip.
  p95 may have no chip at all (GC doesn't shift the 95th percentile
  enough in a short window).
- **Home > Slowest trace classes**: ad entries appear with seconds-long
  max durations.
- **Limitation**: the ServiceDetail hero currently shows only p50/p95/p99
  via the three-line Duration chart. The stats row (Rate / Error rate /
  p95) doesn't include a p99 tile — users relying on the hero tiles will
  miss GC-pause scenarios. See gap #2 in the roadmap.

---

### 4. `loadGeneratorFloodHomepage` — traffic surge

```bash
scripts/flagd-set.sh loadGeneratorFloodHomepage on
```

Variants: `off`, `on`.

**Signal shape.** The load-generator flips into "flood mode" and hammers
the homepage with ~100× the normal rate. Every service downstream sees
a matching spike.

**Where it shows up:**
- **Home catalog**: `frontend` and `frontend-proxy` rate columns get
  blue ▲+N% chips (neutral-color because a surge is informative, not
  inherently "bad"). Rate sparklines show a visible vertical spike at
  the right edge.
- **Service Detail (`frontend`)**: Rate chart shows the same step-up.
- **Slowest trace classes**: a new `load-generator user_flood_home`
  trace class appears (didn't exist in baseline).
- If the surge saturates anything downstream, p95/p99 deltas also fire
  on those services.

---

### 5. `cartFailure` — hard error (cart)

```bash
scripts/flagd-set.sh cartFailure on
```

Variants: `off`, `on`.

**Signal shape.** `cart` gRPC methods throw errors. Checkout depends on
cart for fetch + clear operations, so checkout inherits the failure.

**Where it shows up:** same pattern as `paymentFailure`:
- Home catalog: cart row with red error chip
- System Architecture: upstream edges (`frontend → cart`, `checkout →
  cart`) go red
- Service Detail (`cart`): error chart spike
- Home > Error classes: cart entries with the error message

---

### 6. `adFailure` — ⚠️ 10%-rate error injection (ad)

```bash
scripts/flagd-set.sh adFailure on
```

Variants: `off`, `on`.

**Signal shape.** The ad service's `oteldemo.AdService/GetAds` gRPC
handler throws `StatusRuntimeException(UNAVAILABLE)` on approximately
**1 in 10** requests when the flag is on. The 10% rate is hard-coded
in [AdService.java](https://github.com/open-telemetry/opentelemetry-demo/blob/main/src/ad/src/main/java/oteldemo/AdService.java)
(`if (ffClient.getBooleanValue(AD_FAILURE, ...) && random.nextInt(10) == 0)`),
so it's a fixed Bernoulli trial per request — **not** the hard-error
pattern `cartFailure` / `paymentFailure` produce. Only the top-level
`GetAds` RPC is gated by the flag; `getAdsByCategory` and
`getRandomAds` continue serving cleanly.

With baseline ad traffic of roughly 10 `GetAds`/minute, expect on
the order of 1 error span per minute while the flag is on. A 15-
second window has ~80% chance of zero errors by pure variance —
observe over 2+ minutes when diagnosing, and poll rather than
sample when asserting in a test.

**Where it shows up:**
- **Home catalog**: `ad` row's error-rate cell gets a small chip
  (error rate ≤1% over the default window). Much subtler than the
  hard-error scenarios because the rate itself is low.
- **System Architecture**: the `frontend → ad` edge picks up a
  trickle of errored calls; whether it tints red depends on the
  graph's health thresholds.
- **Service Detail (`ad`)**: Errors chart shows a small but
  persistent error rate after the flag is on.
- **Home > Error classes**: `ad` / `GetAds` entries appear with
  the `UNAVAILABLE` status message.

**Limitation.** The signal-to-noise is low because only 10% of one
operation fails. Useful for testing the "small chronic failure"
case but not a strong demo of "service is broken". Documented as
⚠️ here so the flag's name (`adFailure`) is not read as implying
the same shape as `cartFailure`. Spotted via
`tests/scenarios/flagd-catalog-validation.spec.ts`.

---

### 7. `productCatalogFailure` — targeted product error

```bash
scripts/flagd-set.sh productCatalogFailure on
```

Variants: `off`, `on`.

**Signal shape.** `product-catalog` errors for **one specific product ID**
(`OLJCESPC7Z` historically). Background request volume looks normal;
only the affected product's traces fail.

**Where it shows up:**
- **Home > Error classes**: grouped by (service, operation, message);
  this scenario produces a distinctive product-specific message.
- **Home catalog**: product-catalog error rate is small (maybe ~10% if
  that product is popular) — the delta chip still catches it.
- **Limitation**: there's no UI today to filter traces by a specific
  span attribute (like `product.id`), so you can't isolate the bad
  product from the dashboard. Use the Error classes panel.

---

### 8. `recommendationCacheFailure` — cache layer error

```bash
scripts/flagd-set.sh recommendationCacheFailure on
```

Variants: `off`, `on`.

**Signal shape.** The cache inside `recommendation` fails, forcing
recomputation. Errors are intermittent; latency also creeps up because
every request misses the cache.

**Where it shows up:**
- Home catalog: recommendation row — error chip **and** p95 latency
  chip may both fire.
- Service Detail: Errors and Duration charts both show regression.

---

### 9. `paymentUnreachable` — hard downtime

```bash
scripts/flagd-set.sh paymentUnreachable on
```

Variants: `off`, `on`.

**Signal shape.** Payment is **completely unavailable**. `checkout →
payment` calls return connection-refused / gRPC UNAVAILABLE. This is
the "blast radius" scenario — every checkout fails.

**Where it shows up:**
- Home catalog: payment + checkout both light up critical.
- **System Architecture**: the `checkout → payment` edge is the best
  view — thick red with `UNAVAILABLE` in the tooltip.
- Error classes: connection-refused messages.

---

### 10. `adHighCpu` — sustained CPU saturation

```bash
scripts/flagd-set.sh adHighCpu on
```

Variants: `off`, `on`.

**Signal shape.** Unlike `adManualGc` which causes intermittent spikes,
this keeps the ad service at high CPU continuously. The latency
distribution **shifts right broadly** — p50, p95, and p99 all move up
together (not bimodal).

**Where it shows up:**
- Home catalog: `ad` — chips on **all three** of rate / p95 / p99
  (rate stays the same or slightly drops, p95 and p99 rise).
- Service Detail: all three Duration lines (p50 / p95 / p99) rise
  roughly in parallel — distinguishes this from `adManualGc` which
  only moves p99.

---

### 11. `emailMemoryLeak` — slow creep + eventual OOM

```bash
scripts/flagd-set.sh emailMemoryLeak 100x
```

Variants: `off`, `1x`, `10x`, `100x`, `1000x`, `10000x`. Higher is faster.

**Signal shape.** The email service leaks memory. Over time latency
creeps up, then the pod eventually OOM-kills and restarts, which
causes a short burst of errors. Then reset. At `1x` this takes hours;
at `1000x` / `10000x` it takes minutes.

**Where it shows up:**
- Service Detail (`email`): slow upward drift on the Duration chart,
  then a vertical spike on the Errors chart at restart time.
- **Limitation**: there is no per-pod/per-instance breakdown, so if
  only one pod is leaking and the others are fine, the aggregate looks
  diluted. This is a roadmap item (per-instance view).

---

### 12. `failedReadinessProbe` — k8s-level outage

```bash
scripts/flagd-set.sh failedReadinessProbe on
```

Variants: `off`, `on`.

**Signal shape.** Kubernetes removes the `cart` pod from the Service
endpoints because the readiness probe fails. Upstream callers get
intermittent or total connection failures to cart. The root cause is
in k8s events and kubelet logs, not in app traces.

**Where it shows up:**
- Home catalog: cart row — error chip fires once failures propagate.
- Error classes: upstream-side messages like "connection refused".
- **Logs tab**: partial — if k8s events are in the dataset (they
  usually aren't unless explicitly ingested), you'd see
  "Readiness probe failed" lines. Otherwise there's no UI signal
  for the root cause today. This is the most log-first scenario of
  the set.

---

### 13. `llmInaccurateResponse` — semantic bug (no telemetry)

```bash
scripts/flagd-set.sh llmInaccurateResponse on
```

**Signal shape.** The AI product-assistant returns a **wrong answer**
for one specific product (`L9ECAV7KIM`). No error in telemetry. No
latency change. Only visible by reading the response body.

**Where it shows up:**
- ❌ **Nowhere.** This is a known blind spot — a generic APM can't
  detect semantic correctness. It would require either (a) a known-
  answer test in the demo or (b) content search on span attributes,
  which we don't currently offer. Documented as a limitation, not
  a target.

---

### 14. `llmRateLimitError` — LLM rate limit

```bash
scripts/flagd-set.sh llmRateLimitError on
```

**Signal shape.** LLM endpoint returns rate-limit errors intermittently.
Shows up as normal span errors on the `product-reviews` service (the
one that calls the LLM).

**Where it shows up:**
- Home catalog: product-reviews error chip.
- Error classes: rate-limit error messages.
- Same pattern as any other hard-error scenario.

---

### 15. `imageSlowLoad` — ⚠️ client-side only, invisible to backend APM

```bash
scripts/flagd-set.sh imageSlowLoad 10sec
```

Variants: `off`, `5sec`, `10sec`.

**Signal shape.** This is a **client-side (browser) delay** in the
Next.js frontend's image loading code. It does NOT produce a backend
span with high duration. We confirmed this against the `frontend` and
`frontend-proxy` services — top p95 stays under 400ms regardless of
the flag state.

**Where it shows up:**
- ❌ **Nowhere in a backend APM.** You would need Real User Monitoring
  (RUM) or synthetic browser monitoring to catch this. Documented as
  a limitation of the scenario, not the app.

---

## Known UI gaps

Pruned 2026-04-16 — three of the original six were implemented
(verified against source in the detection coverage audit). The
remaining gaps are tracked in ROADMAP.md §1d with concrete PRs.

| # | Gap | Impact | Status |
|---|-----|--------|--------|
| ~~1~~ | ~~Messaging edges not on arch graph~~ | ~~kafka invisible~~ | **DONE** — `criblapm__sysarch_messaging_deps` + `toMessagingEdges` |
| ~~2~~ | ~~No p99 tile / p99 delta chip~~ | ~~GC-pause hidden~~ | **DONE** — `ServiceDetailPage.tsx:742` + `HomePage.tsx:743-746` |
| ~~3~~ | ~~Slow trace classes polluted by flagd streams~~ | ~~noise~~ | **DONE** — `streamFilter.ts` heuristic (duration + child ratio + span count) |
| 4 | Delta chips misfire on noisy-tail services (accounting) | False alarms | Open — needs investigation |
| 5 | Time range doesn't persist across pages | Lose context | Open |
| 6 | ServiceDetail queries slow (10-20s at `-1h`) | Skeleton state during incidents | Open — **tracked as ROADMAP §1d fix 1 (ServiceDetail panel caching)** |

## Quick reference: which scenarios exercise which feature

| Feature | Best scenario to demo it |
|---|---|
| Baseline delta chips (error rate) | `paymentFailure 50%` |
| Baseline delta chips (p95 latency) | `adHighCpu` |
| Baseline delta chips (rate) | `loadGeneratorFloodHomepage` |
| Baseline delta chips (**p99**, bimodal) | `adManualGc` |
| Edge-level health on graph | `paymentFailure` or `paymentUnreachable` |
| Messaging edges | `kafkaQueueProblems` |
| Ghost nodes + rate-drop chip | `paymentUnreachable` |
| Root-cause hint | `cartFailure` |
| Log Explorer | `failedReadinessProbe` (if k8s events are in the dataset) |
| Error classes grouping | `productCatalogFailure` |
| Slowest trace classes | `kafkaQueueProblems` (after ROADMAP §1d fix 3) |
| Sortable Top Operations by p95 | `adHighCpu` |
