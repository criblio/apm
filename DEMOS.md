# Cribl APM — demo runbook

How to demonstrate each failure scenario the eval suite exercises.
Each entry has: the flag flip, the service the failure manifests
on, the surfaces an operator should check, the Investigator prompt
that earns a passing root-cause score, and a brief reading of
what makes the scenario interesting.

For a deeper reference (variants, telemetry shape, prerequisites)
see `FAILURE-SCENARIOS.md`. For the test harness that runs all of
these, see `eval/run.ts`.

## Prerequisites

```bash
# Once per session
kubectl -n otel-demo port-forward --address 0.0.0.0 svc/flagd 4000:4000 &
export FLAGD_UI_URL=http://localhost:4000
# (or http://clintdev:4000 on Clint's box)
```

After every demo session: `scripts/flagd-set.sh --all-off`.

## Reading the table

- **Wait** — minutes between flipping the flag and the surface
  visibly reacting. Most scenarios need 5–7 min for the scheduled
  searches and alert state machine to converge.
- **Where to look** — the page surfaces the eval asserts on.
  Listed roughly in order of how quickly each surface lights up.
- **Investigator prompt** — the question that exercises the
  Copilot Investigator. The eval scores positive when its
  conclusion matches the expected root-cause pattern.

---

## 1. `paymentFailure` — hard error injection on payment service

```bash
scripts/flagd-set.sh paymentFailure 50%
```

| | |
|---|---|
| Flag | `paymentFailure=50%` |
| Service that fails | `payment` |
| Wait | ~5 min |

**What to look at**

1. **Overview → Detected Issues** — `payment` row appears with critical/warn severity, error-rate detail.
2. **Services list** — `payment` row's error column shows a non-zero percentage (e.g., 25–50%).
3. **Errors page** — expand the payment row; Spotlight should call out `rpc.method = Charge` and `rpc.grpc.status_code` differential.
4. **Service Detail / payment** — alert badge "FIRING" in header, Errors chart non-zero, Spotlight section ranks `name` (operation = Charge) at the top.
5. **Alerts page** — `payment` row with `Firing` or `Pending` state.

**Investigator prompt**

> *Why are there payment service errors in the last 15 minutes? Summarise root cause.*

Pass: mentions "payment errors", "Charge fail", or "invalid token". Reads from `criblapm_alert` history events + queries the dataset.

---

## 2. `kafkaQueueProblems` — consumer lag

```bash
scripts/flagd-set.sh kafkaQueueProblems on
```

| | |
|---|---|
| Flag | `kafkaQueueProblems=on` |
| Service that suffers | `fraud-detection` (consumer-side latency) |
| Wait | ~7 min |

**What to look at**

1. **Services list** — `fraud-detection` p99 delta chip turns red (▲ vs previous window).
2. **Slowest trace classes** widget — `consumed` operations on `fraud-detection`.
3. **Service Detail / fraud-detection** — p99 line on the Duration chart spikes; p50 stays flat (bimodal).

**Investigator prompt**

> *Why is the fraud-detection service showing high p99 latency in the last 15 minutes? Summarise root cause.*

Pass: mentions "kafka", "consumer", "lag", "queue", or "accounting".

---

## 3. `adManualGc` — bimodal GC pauses (p99 spike, p50 flat)

```bash
scripts/flagd-set.sh adManualGc on
```

| | |
|---|---|
| Flag | `adManualGc=on` |
| Service that suffers | `ad` |
| Wait | ~7 min |

**What to look at**

1. **Services list** — `ad` p99 delta chip flares ▲ vs previous window; p50 stays calm.
2. **Slowest trace classes** widget — `ad` rows.
3. **Service Detail / ad** — Duration chart shows p99 sawtooth pattern.

**Investigator prompt**

> *The ad service has high p99 latency but normal p50. What is causing intermittent slowness in the last 15 minutes?*

Pass: mentions GC, garbage collect, pause, bimodal, JVM, intermittent, spike, or sawtooth.

---

## 4. `loadGeneratorFloodHomepage` — traffic surge (no errors)

```bash
scripts/flagd-set.sh loadGeneratorFloodHomepage on
```

| | |
|---|---|
| Flag | `loadGeneratorFloodHomepage=on` |
| Service that surges | `frontend` |
| Wait | ~5 min |

**What to look at**

1. **Services list** — `frontend` Rate delta chip flares ▲ (often 3–5×).
2. **Service Detail / frontend** — Rate chart visibly higher than baseline window.

No errors are injected — this scenario validates the **traffic-change** detection path, not error detection. The Investigator is not exercised here.

---

## 5. `cartFailure` — hard error on cart service (Redis/Valkey)

```bash
scripts/flagd-set.sh cartFailure on
```

| | |
|---|---|
| Flag | `cartFailure=on` |
| Service that fails | `cart` |
| Wait | ~5–7 min |

**What to look at**

1. **Services list** — `cart` error chip non-zero.
2. **Error classes** widget — `cart` rows with EmptyCart / GetCart operation breakdown.
3. **Service Detail / cart** — Errors chart populates, alert badge fires.
4. **Errors page** — expanded row's Spotlight should highlight `rpc.method` and `peer.service` differentials.

**Investigator prompt**

> *Why are there cart service errors in the last 15 minutes? Summarise root cause.*

Pass: mentions cart errors, redis, valkey, EmptyCart, or GetCart.

---

## 6. `adFailure` — 10%-rate gRPC errors on ad service

```bash
scripts/flagd-set.sh adFailure on
```

| | |
|---|---|
| Flag | `adFailure=on` |
| Service that fails | `ad` |
| Wait | ~7 min |

**What to look at**

This is a **low-rate Bernoulli** failure — only ~10% of GetAds calls error. On low-traffic services this surfaces slowly:

1. **Services list** — `ad` error chip eventually shows a single-digit percentage.
2. **Error classes** widget — `ad` rows.
3. **Service Detail / ad** — alert badge "FIRING" after ~5 min of sustained low-rate errors.

**Investigator prompt**

> *Are there any ad service errors in the last 15 minutes? Summarise root cause.*

Pass: mentions ad errors, GetAds, UNAVAILABLE, or adservice.

---

## 7. `productCatalogFailure` — targeted-product error

```bash
scripts/flagd-set.sh productCatalogFailure on
```

| | |
|---|---|
| Flag | `productCatalogFailure=on` |
| Service that fails | `product-catalog` (specifically the `OLJCESPC7Z` product) |
| Wait | ~5 min |

**What to look at**

This is **Spotlight's textbook scenario**. The flag fails GetProduct for a specific product ID; the differential lands on `app.product.id = OLJCESPC7Z` at ~100% error rate while every other product is at 0%.

1. **Services list** — `product-catalog` error chip non-zero.
2. **Error classes** widget — multiple rows: "Product Not Found: OLJCESPC7Z" plus the normal not-found cases (DEADBEEF99, NOTAPRODUCT).
3. **Errors page** — expand any product-catalog row. **`app.product.id`** should rank near the top, with `OLJCESPC7Z` showing the highest volume + 100% error rate.

**Investigator prompt**

> *Why are there product-catalog errors in the last 15 minutes? Which product is affected?*

Pass: mentions product-catalog, `OLJCESPC7Z`, product id, or GetProduct.

---

## 8. `recommendationCacheFailure` — cache layer error on recommendation

```bash
scripts/flagd-set.sh recommendationCacheFailure on
```

| | |
|---|---|
| Flag | `recommendationCacheFailure=on` |
| Service that fails | `recommendation` |
| Wait | ~5–7 min |

**What to look at**

1. **Services list** — `recommendation` error chip non-zero.
2. **Service Detail / recommendation** — Errors chart populates, alert badge fires.

**Investigator prompt**

> *Why are there recommendation service errors in the last 15 minutes? Summarise root cause.*

Pass: mentions recommendation errors, cache, redis, or ListRecommendations.

---

## 9. `paymentUnreachable` — hard downtime on payment

```bash
scripts/flagd-set.sh paymentUnreachable on
```

| | |
|---|---|
| Flag | `paymentUnreachable=on` |
| Service that fails | `payment` (silent) → propagates to `checkout` (errors) |
| Wait | ~5–7 min |

**What to look at**

This is the **silent-service / propagation** scenario. Payment goes from "serving traffic" to "no traffic at all"; the rate-drop chip turns red on payment, and the failure propagates up to checkout which can't reach payment.

1. **Services list** — `payment` rate delta chip flares red (traffic drop).
2. **Services list** — `checkout` error chip non-zero.
3. **Error classes** widget — `payment` errors (connection refused).
4. **Service Detail / payment** — Errors visible, alert badge fires.

**Investigator prompt**

> *The payment service appears unreachable. What is causing checkout failures in the last 15 minutes? Summarise root cause.*

Pass: mentions payment unreachable, unavailable, connection refused, or payment down.

---

## 10. `adHighCpu` — sustained CPU saturation

```bash
scripts/flagd-set.sh adHighCpu on
```

| | |
|---|---|
| Flag | `adHighCpu=on` |
| Service that suffers | `ad` |
| Wait | ~7 min |

**What to look at**

Unlike `adManualGc`, this saturates across the board — p95 AND p99 both shift up together.

1. **Services list** — `ad` p95 and p99 both elevated (baseline ~1ms → ≥5ms).
2. **Service Detail / ad** — Duration chart broad shift up, not just outliers.

**Investigator prompt**

> *The ad service latency has increased across all percentiles. What is causing it in the last 15 minutes?*

Pass: mentions ad cpu, saturation, broad shift, or both p95 + p99 increasing.

---

## 11. `emailMemoryLeak` — gradual creep + eventual OOM

```bash
scripts/flagd-set.sh emailMemoryLeak 100x
```

| | |
|---|---|
| Flag | `emailMemoryLeak=100x` |
| Service that drifts | `email` |
| Wait | ~7+ min for latency drift to be visible |

**What to look at**

1. **Services list** — `email` p95 delta chip flares ▲ vs previous window.
2. **Service Detail / email** — Duration chart drifts up over the window (not a step change).
3. **Service Detail / email** — alert badge eventually fires.

**Investigator prompt**

> *The email service latency is increasing over time. What could be causing gradual performance degradation?*

Pass: mentions email latency, memory, leak, gradual, or drift.

---

## 12. `failedReadinessProbe` — k8s-level outage on cart

```bash
scripts/flagd-set.sh failedReadinessProbe on
```

| | |
|---|---|
| Flag | `failedReadinessProbe=on` |
| Service that fails silently | `cart` (no traffic) |
| Service that surfaces errors | `checkout` (calls to cart get connection refused) |
| Wait | ~7 min |

**What to look at**

`cart` is yanked from k8s endpoints; upstream callers (checkout, frontend) get connection errors. The detection surface is on the **caller**, not the failing service:

1. **Services list** — `checkout` error chip non-zero; `cart` rate drops to zero.
2. **Error classes** widget — cart-related entries on the checkout row.
3. **Service Detail / checkout** — alert badge fires.
4. **Overview → Detected Issues** — `checkout` listed.

**Investigator prompt**

> *Checkout is experiencing errors calling the cart service. Is cart having availability issues in the last 15 minutes?*

Pass: mentions cart errors, connection refused, unavailable, readiness, pod restart, cart down, or cart unreachable.

---

## 13. `llmRateLimitError` — LLM rate-limit hits product-reviews

```bash
scripts/flagd-set.sh llmRateLimitError on
```

| | |
|---|---|
| Flag | `llmRateLimitError=on` |
| Service that fails | `product-reviews` |
| Wait | ~5 min |

**What to look at**

1. **Services list** — `product-reviews` error chip non-zero (≥1%).
2. **Error classes** widget — `product-reviews` rows.
3. **Service Detail / product-reviews** — Errors chart populates, alert badge fires.

**Investigator prompt**

> *Why are there product-reviews errors in the last 15 minutes? Summarise root cause.*

Pass: mentions product-reviews, rate limit, llm, 429, or throttle.

---

## 14. `leakFingerprint` — cardinality leak on a long-running frontend pod

**No flag flip.** This is the natural state of the demo cluster when
a frontend pod has been up many days accumulating
`BaggageSpanProcessor` cardinality on `session.id`. The
2026-05-02 frontend deploy left the pod up 11+ days; its error
rate has climbed monotonically from 0.37% to ~14%.

| | |
|---|---|
| Flag | (none — observed natural-state condition) |
| Service that drifts | `frontend` |
| Wait | already present in current data |

**What to look at**

1. **Alerts page** — `frontend` Firing or Pending row.
2. **Service Detail / frontend** — Errors chart shows monotonic climb across the window.
3. **Service Detail / frontend → instances** — one pod with multi-day uptime, others fresh.

**Investigator prompt**

> *The frontend service error rate has climbed from <1% to ~14% over the last 10 days. Identify the root cause and recommend a specific verification action.*

Pass: identifies leak / cardinality / `session.id` / pod uptime, and recommends rollout restart of the long-running pod. Fail: blames `paymentFailure` or `kafkaQueueProblems` (those are flag-driven and not relevant here).

---

## Running the full eval

To run all 14 scenarios end-to-end (UI surface assertions + KQL
assertions + Investigator scoring):

```bash
npm run eval                              # full matrix, ~2–3h
npm run eval -- --scenario paymentFailure # one scenario
npm run eval -- --no-investigator         # surface-only, ~45 min
```

Sequential by design — see CLAUDE.md "Running scenario tests" for
why parallel runs saturate the cluster.
