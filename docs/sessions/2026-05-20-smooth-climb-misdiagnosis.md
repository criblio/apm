# Session: 2026-05-20 — Smooth-climb 5xx misdiagnosis + deploy-boundary confounder ranking

Follow-up to `2026-05-12-leak-fingerprint-and-investigator-playbook.md`.
That session shipped the trend signal that caught this incident.
This session is the post-incident review: trend detection worked,
the diagnosis we landed on did not, and the bias that produced the
wrong diagnosis needs to be encoded into the Investigator playbook.

## What worked

Frontend 5xx error rate climbed monotonically from ~0% to ~50% over
11 days starting 2026-05-01. The slope/drift signal surfaced it.
Absolute-threshold alerts would have missed it indefinitely — the
per-window delta was too small at any given check. The trend
detection is the only reason this incident got diagnosed at all.
Keep it.

## What we got wrong

Diagnosis: state-accumulation leak in the frontend BFF, supported by
two correlations:

  1. Error climb started 2026-05-01.
  2. The frontend pod (image `9e0f6bd-frontend`) was started
     2026-05-01T22:27:29Z and had been running 18 days without
     restart.

Recommended verification: `kubectl rollout restart deploy/frontend`.
We ran it. Results:

| Stage                       | replicas | pod age | proxy 5xx % |
|-----------------------------|---------:|--------:|------------:|
| original (long-uptime pod)  |        1 |     18d |      12.62% |
| after restart, single repl  |        1 |   fresh |      13.52% |
| after scaling to 3 replicas |        3 |   fresh |   **1.97%** |

The restart did effectively nothing for the user-visible error rate.
The fix was scaling replicas 1 → 3. Actual root cause: the
`LoadTestShape` introduced in the same 2026-05-01 deploy spikes to
25 concurrent users every 10 minutes. The demo's stock frontend runs
single-replica. Single Next.js pod + 25 concurrent in-flight
requests = envoy 503 "no healthy upstream / connection rejected."

The 503/504 mix flipped between the restart and the scale-up. Pre-
restart was 504-dominant (BFF awaiting slow downstream). Post-
restart-single-replica was 503-dominant (capacity exhausted). That
flip *was* the evidence that capacity was the bottleneck, but
neither the app UI nor the Investigator surfaced status-code mix —
both flattened it to "5xx."

There was a small BFF span-error accumulation effect (19% → 3.5%
post-restart), so the leak hypothesis was not zero. It was just
secondary. Capacity dominated by an order of magnitude.

## The bias to correct in the Investigator

When the agent finds a smooth-climb error trend that starts at time
T, today's playbook routes it toward state at time T — pod uptime,
session.id cardinality, monotonic counter growth. That's a valid
hypothesis class, but it's biased toward state-accumulation
explanations because they trivially correlate with a calendar
boundary.

At any deploy boundary, several things change simultaneously:

  - code (new image)
  - infra config (replica count, resource requests/limits, HPA)
  - traffic shape (load generator, A/B split, new client)
  - data shape (new fields, new endpoints)

If the agent examines one of these and it correlates, it recommends
remediation with high confidence — even when 3 other confounders
also correlate. In this incident, single-replica + spike-load both
correlate with 2026-05-01 and both touch the frontend hot path; pod
uptime also correlates but does not touch the hot path. We followed
the easy correlation, not the strong one.

## Plan

Four additions, in the order proposed by the user (B → A/B/D → C).

### B (first) — Status-code-mix surfacing in the UI

Independent of the Investigator. Status-code mix is a diagnostic
for human operators on its own.

- New query `serviceStatusCodeMix(svc, window)` that buckets
  `attributes['http.response.status_code']` (plus the envoy
  `response_flags` field when present) into 4xx, 500, 502, 503, 504,
  and "other 5xx" per `bin(_time, 1m)` for a service.
- New widget on Service Detail page: stacked area or bar over the
  same window as the existing Duration / Errors charts, showing the
  mix as it shifts. Click-through filters the errors table to that
  bucket.
- Optional follow-up: feed into the `home_service_summary` cache so
  the Home catalog can show "503 14% / 504 1%" instead of a flat
  "errors 15%." Hold this until the standalone widget validates.

### A, B, D — Investigator preamble updates

Small diffs to `src/api/agentContext.ts` extending the existing
smooth-climb playbook (`agentContext.ts:299–480`).

- **A. Deploy-boundary confounder enumeration.** Before
  recommending remediation, the agent must list everything that
  changed at time T, not just the first thing that fits.
  Concretely:
    - **Image bumps**: query
      `attributes['deployment.version']` or
      `resource.attributes['service.version']` across the trend
      window; flag any service whose version changed near T.
    - **Workload shape**: compare requests/min and concurrency
      distribution from pre-T window to current.
    - **Infra**: from `k8s.pod.*` resource attributes — replicas
      across pods of the same deployment, resource limits.
    - **Schema**: read `criblapm_attr_catalog` and compare the
      attribute set to a pre-T snapshot. New attributes in the
      window are candidates.
  Each candidate is then weighted by hot-path overlap: does the
  change touch the path that's erroring? Single-replica + spike
  load both touched the frontend hot path; pod age did not.
  Down-rank candidates that don't.

- **B. Envoy/upstream status-code semantics.** Tell the agent how
  to interpret 5xx subtypes:
    - 503 → capacity / availability (no healthy upstream).
      Hypothesis class: replica count, concurrency limits, cold
      pods, HPA misconfig.
    - 504 → upstream timeout. Hypothesis class: slow downstream,
      BFF awaiting slow downstream, BFF saturated by GC.
    - 500 → upstream-originated error. Hypothesis class: bug,
      unhandled case in upstream.
  Shifts in the 503/504/500 mix over time, or before/after a
  remediation, are themselves diagnostic. Tell the agent to look
  at the mix, not just the total.

- **D. Cap on pod-uptime as hypothesis.** Pod uptime is a useful
  leak signal **only** when the pod started before the trend
  started. If pod start time and trend start time coincide (within
  ~1h), pod uptime is a confounder of the deploy event, not a
  cause. Down-weight or strike "leak from uptime" in that case and
  examine the other deploy confounders.

### C (last) — Remediation verification loop

Bigger. Two phases:

- **C1 — Prediction + verification instructions in the summary.**
  Cheapest version. When the agent calls
  `present_investigation_summary`, the summary must include:
    - A specific predicted effect with magnitude and metric
      ("proxy 503 rate should drop from ~13% to <3% within 5
      minutes after scaling to 3 replicas").
    - A specific verification step the operator can run to sample
      the same metric.
    - An explicit "if the remediation does not produce this
      effect, re-invoke the Investigator with a note that the
      first hypothesis was disconfirmed" instruction.
  No state machine yet; the human runs the loop.

- **C2 — Actual state machine.** Investigator records the
  prediction; a background poll re-samples the metric and either
  auto-redirects the agent or surfaces a UI prompt ("predicted
  effect did not occur — open follow-up investigation"). Needs a
  lookup (or KV entry) for open hypotheses + a small scheduled
  search to evaluate effect. Tackle after C1 validates the human-
  in-the-loop version.

## Validation

After (B) and the (A, B, D) preamble updates ship, reproduce on
staging by reverting the scale-up:

```bash
kubectl scale deploy/frontend --replicas=1
```

Let errors climb back to ~12% (a few LoadTestShape cycles). Point
the Investigator at the trend.

It should:

  1. Identify the smooth climb (already works).
  2. Enumerate confounders at the 2026-05-01 boundary: frontend
     image bump, load-generator LoadTestShape addition, replica
     count = 1. Pod uptime should appear with a down-weight
     because pod start time coincides with trend start.
  3. Rank by hot-path overlap. Single-replica + spike load
     dominate; pod age does not.
  4. Recommend `kubectl scale deploy/frontend --replicas=3` (or
     add an HPA) as the first remediation.
  5. Predict expected effect: "proxy 503 rate should drop from
     ~13% to <3% within 5 minutes; if not, re-hypothesize."
  6. After remediation, the operator (or a follow-up run) checks
     the 503/504/500 mix and reports effect-vs-prediction.

If it still recommends restart first, the confounder ranking
isn't strong enough — iterate the preamble before considering
this done.

## Eval coverage

The current `leakFingerprint` scenario seeds a state that matches
the leak hypothesis it was authored to catch. It now needs at least
one sibling:

- `singleReplicaSpikeLoad` — same smooth-climb 5xx shape, but the
  correct diagnosis is capacity, not leak. Synthetic state:
  503-dominant status mix, replica count = 1, recent pod restart
  (so uptime ≠ trend start), LoadTestShape spikes visible in the
  requests/min series.

Score binary: "recommended scale-up correctly" vs "chased a leak."
If both `leakFingerprint` and `singleReplicaSpikeLoad` pass, the
playbook is discriminating between the two. If only one passes,
the playbook is biased toward whichever it passes on.

## What I'm NOT proposing

- An auto-remediation feature. The operator runs the kubectl
  command, same as today.
- Replacing the leak playbook. Leaks are still a real hypothesis
  class. The leak playbook stays — it becomes one branch of the
  deploy-confounder enumeration.
- A clever heuristic for hot-path overlap. The simplest version is:
  the changed service equals the erroring service, OR the changed
  config affects the erroring service's resource envelope.
- Generic anomaly detection. Slope + linearity remain the trend
  signal.

## Files likely touched

- `src/api/queries.ts` — new `serviceStatusCodeMix()` query.
- `src/api/search.ts` — wrapper.
- `src/routes/ServiceDetailPage.tsx` — new status-mix widget.
- `src/api/provisionedSearches.ts` — optionally a scheduled search
  caching the mix per service (only if Service Detail load time
  suffers without the cache).
- `src/api/agentContext.ts` — preamble additions for A, B, D.
- `eval/scenarios/singleReplicaSpikeLoad.ts` — new eval.

## Decisions

1. **Confounder enumeration.** Agent ranks all viable candidates
   with relative confidence (not single-pick). The dominant
   hypothesis is the lead, but alternatives stay visible in the
   summary so the operator sees what was considered. Confirmed
   2026-05-20.
2. **Verification loop scope.** C1 (prediction in the summary,
   human runs verification) is sufficient for v1. C2 (background
   re-sample + state machine) is a follow-up only if C1 proves
   insufficient. Confirmed 2026-05-20.
3. **PR strategy** (proposer's default): four stacked PRs —
   (1) status-mix widget, (2) preamble A/B/D, (3) C1 prediction-
   in-summary, (4) eval scenario + validation.
4. **Mix granularity in the UI** (proposer's default): stacked-
   area-by-minute over the existing Service Detail window, with
   click-through filtering the errors table. Revisit if it's too
   dense in practice.

## Phase 1 shipped — Status-mix widget on Service Detail

Phase B from the plan above landed. Walkthrough:

- `queries.ts:serviceStatusCodeMix(binSeconds, service)` — bucketing
  `coalesce(http.response.status_code, http.status_code)` and the
  gRPC status into 7 classes (503 / 504 / 502 / 500 / other_5xx /
  4xx / grpc_err). Coalesce matters because the demo's stock
  envoy + next.js spans use the legacy field while newer SDKs use
  the modern one — neither alone covers the mix.
- `search.ts:getServiceStatusCodeMix(...)` + `types.ts` —
  `StatusCodeMixBucket` / `StatusCodeClass` / `STATUS_CODE_CLASSES`
  ordered tuple. Wrapper returns long-format rows (one per
  bucket × class); the UI pivots into separate line series.
- `ServiceDetailPage.tsx` — new `Status mix` chart on a full-width
  row below the RED chart row. Status-mix fetch runs alongside
  the prev-window summary, **outside** the cache-fast-path so it
  fires on the default `-1h` + stream-filter-on path even though
  it isn't yet in `$vt_results`.
- `ServiceDetailPage.module.css` — `.chartRow` single-column grid
  for the new chart.

### Two gotchas discovered during validation

1. `streamFilterSpanKqlClause()` injects `| where dur_us < 30000000`.
   The status-mix query didn't compute `dur_us` initially, so the
   injected filter referenced a missing column and returned zero
   rows on staging. Added `dur_us` to the `| extend` block.
2. The Service Detail page's cache-fast-path returns early when the
   user is on the default `-1h` range with the stream filter on,
   skipping the live-fan-out block entirely. The new fetch had to
   move out of that block to fire on the most common page-load
   path.

### Evidence

`frontend-proxy` over the last hour shows the diagnostic clearly —
503 (capacity) dominates the first half, 500 (upstream bug) takes
over later, 504 (upstream timeout) sits in the middle:

![status mix on frontend-proxy](https://raw.githubusercontent.com/criblio/apm/master/docs/sessions/screenshots/2026-05-20-smooth-climb-misdiagnosis/status-mix-frontend-proxy.png)

`frontend` (the BFF) shows a different shape — 500-dominant with
gRPC-error bursts following the same cadence (frontend's HTTP
500s ride on top of downstream gRPC failures):

![status mix on frontend](https://raw.githubusercontent.com/criblio/apm/master/docs/sessions/screenshots/2026-05-20-smooth-climb-misdiagnosis/status-mix-frontend.png)

The two shapes already validate the central point of the
playbook: 503 vs 500/grpc_err vs 504 are different hypothesis
classes and the same operator should see different first
remediations for them.

## What happens next

Pending your go-ahead on the plan. Once approved:
1. Implement B (status-code-mix widget) — small, independently
   useful.
2. Implement A, B, D (preamble additions) — small diffs.
3. Reproduce on staging via `kubectl scale --replicas=1`, validate.
4. Implement C1 (prediction in summary).
5. Add the `singleReplicaSpikeLoad` eval scenario.
6. C2 (state machine) as a follow-up if C1 isn't sufficient.
7. Each step: commit + MCP-query / screenshot evidence in this log.
