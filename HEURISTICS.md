# Heuristics — what Cribl APM considers a "real problem"

This document is the canonical list of judgment-call rules the app
applies to telemetry: which errors are noise, what counts as a user
vs service trace, how propagation is detected, etc. **Heuristics
are product semantics, not UI polish.** They define what the app
considers actionable and must be applied consistently everywhere
"actionable error" gets surfaced: the Home panel, the cached
service metrics, the alert evaluator, eval scenarios.

If you add or change a heuristic, update this file. If you discover
a place where the heuristic isn't applied consistently, that's a
bug — file it.

## Core principle: backend, metrics, alerts, and UI must agree

A heuristic that filters something out of the Home panel **must
also filter it out of the metrics feeding alerts**, or vice versa.
Otherwise operators get paged for the same noise the UI told them
to ignore (or worse: they trust a clean panel while alerts are
silent because the metric layer hides what the UI shows).

Concretely: every default filter rule in
`src/api/errorFilter.ts` should have a corresponding `where` /
`countif` clause in the metric queries that drive alerts —
`Q.serviceSummary()` and `Q.prevWindowSummary()`. The
classifier inputs (`trace_origin`, `has_error_child`,
semconv status codes) need to be available on the metric
side, which means projecting them in the same way the live
error-span query does.

Anti-pattern: "I'll just filter the rows the panel displays."
That fixes the visual layer and leaves the operational layer
broken. Look at every consumer of the affected signal before
shipping.

## Heuristic inventory

### 1. Trace originator classification

- **Question answered:** Was this trace started by a user (real
  browser, synthetic load generator, k8s probe simulating a user)
  or by a service (cron job, queue consumer, scheduled worker)?
- **Where the logic lives:** `Q.traceOriginators()` in
  `src/api/queries.ts`.
- **How it's materialized:** Scheduled search
  `criblapm__trace_originators` (5-minute cadence, 5-minute
  window) writes to the `criblapm_trace_originators` lookup. Seeded
  in `SEED_LOOKUPS` so the lookup exists before consumers join to
  it.
- **Signals**, in priority order:
  1. `http.user_agent` matches `Mozilla|Chrome|Safari|Firefox|Edge|Opera` → `user`
  2. `http.user_agent` matches `k6|locust|jmeter|gatling|wrk|ab/|loadgen` → `user`
  3. `http.user_agent` matches `kube-probe|go-http-client|healthcheck|liveness|readiness` → `service`
  4. `messaging.system` populated → `service`
  5. Span name matches `(?i)(^|_)(user|browse|view|checkout|cart|search)(_|$)` → `user`
  6. Span name matches `(?i)(^|_)(tick|cron|consume|process|poll|worker|job|task)(_|$)` → `service`
  7. Otherwise → `unknown`
- **Threshold:** ≥ 50% of a service's root spans must match for a
  classification to stick. `total ≥ 10` per 5-minute window.
- **Consumers:** `rawRecentErrorSpans` joins this lookup to tag
  every error span with its trace's origin. **MUST also be joined
  by `serviceSummary` and `prevWindowSummary`** for alert
  consistency (see Heuristic 3–5 below). Settings UI exposes
  overrides via `forceUserOriginators` / `forceServiceOriginators`
  in the app-config KV namespace.
- **Failure mode:** Brand-new services with no traffic yet are
  `unknown`. Services with mixed-origin traffic (an API serving
  browsers AND queue consumers) get classified by majority — the
  minority origin's errors leak into the wrong filter scope. Manual
  override compensates.

### 2. Error propagation detection (leaf-only)

- **Question answered:** Is this error span the actual cause, or
  is it propagation from a downstream span that errored?
- **Where the logic lives:** Inline in `Q.rawRecentErrorSpans()` —
  a leftouter self-join from each error span's `span_id` to other
  error spans' `parent_span_id` within the same trace.
- **Implementation note:** The right side of the join is
  pre-aggregated by `(trace_id, child_parent)` so a span with
  multiple error children doesn't produce duplicate rows in the
  joined output. This was discovered when the naive form inflated
  counts in proportion to fanout.
- **Output:** `has_error_child` boolean column on every error span.
- **Consumers:** `propagation-leaf-only` filter rule in
  `errorFilter.ts`. **MUST also flow into `serviceSummary` /
  `prevWindowSummary`** so propagation doesn't inflate the
  error_rate that drives `auto:error_rate:<svc>` alerts.
- **Failure mode:** The error chain has to be *connected* —
  every link in the chain must itself have `status.code == ERROR`.
  In our staging dataset, some traces have intermediate spans
  that don't error (the outer frontend SERVER catches the
  inner exception), breaking the chain. Spans below the break
  appear as "leaves" even though they're really propagation.
  A future enhancement: extend to "has any error descendant
  in trace" via reachability. Not pursued in v1 — recursive
  traversal isn't natural in KQL.

### 3. User-trace HTTP 4xx filter

- **Question answered:** Is this HTTP 4xx a real ops issue or
  expected user behavior?
- **Where the rule lives:** `DEFAULT_FILTER_RULES` in
  `src/api/errorFilter.ts`, id `user-trace-http-4xx`.
- **Rule:** `trace_origin == "user" AND http_status ∈ [400, 499]`
  → drop.
- **Reasoning:** A 4xx returned to a real or synthetic user is
  almost always caller fault — expired session, wrong URL, bad
  form input, missing page. Operators don't get paged for
  those. The same 4xx from one service to another (e.g.
  `cart-worker` getting 401 from `auth`) is a broken-mesh
  signal and stays visible.
- **Consumers:** Home panel via `listErrorClasses`. **MUST also
  apply at metric aggregation** so the alert pipeline doesn't
  fire on synthetic user fault rates. See the
  "Caller-fault rate regression" edge case below.

### 4. User-trace gRPC client-fault filter

- **Question answered:** Same as 3, for gRPC.
- **Where the rule lives:** `DEFAULT_FILTER_RULES` in
  `src/api/errorFilter.ts`, id `user-trace-grpc-client-fault`.
- **Rule:** `trace_origin == "user" AND rpc.grpc.status_code ∈ {3,
  5, 6, 7, 11, 16}` → drop. (INVALID_ARGUMENT, NOT_FOUND,
  ALREADY_EXISTS, PERMISSION_DENIED, OUT_OF_RANGE,
  UNAUTHENTICATED — gRPC-spec client faults.)
- **Reasoning:** A user asking for a product ID that doesn't
  exist is NOT_FOUND. That's not a service regression — the
  catalog is working fine. UNAVAILABLE (14), DEADLINE_EXCEEDED
  (4), INTERNAL (13) stay visible regardless of origin.
- **Consumers:** Home panel, **same alert pipeline obligation
  as Heuristic 3**.

### 5. Propagation-leaf-only filter

- **Question answered:** Should we count both the originating
  error and every layer that propagated it, or just the leaf?
- **Where the rule lives:** `DEFAULT_FILTER_RULES` in
  `src/api/errorFilter.ts`, id `propagation-leaf-only`.
- **Rule:** `has_error_child == true` → drop. Applies to all
  trace origins (scope `any`).
- **Reasoning:** A single "Product Not Found" deep in
  product-catalog becomes ~10-15 error spans by the time it
  bubbles back to the load-generator. Each layer is the same
  incident at a different vantage point. Showing one row per
  incident is what users want; showing one row per span turns
  the panel into noise.
- **Consumers:** Home panel. **MUST also apply at metric
  aggregation** — propagation inflates `error_count` linearly
  with the call-chain depth, which moves `error_rate` around
  for reasons that have nothing to do with whether anything
  is wrong. A service that's "deeper" in the call graph would
  look more error-prone than one closer to the edge for the
  same actual incident.

## Known gap — caller-fault rate regression won't fire `error_rate` alerts

The combined heuristics 3 + 4 mean the error_rate metric (after
the metric-layer fix lands) won't move when user-trace
caller-faults spike. Specifically:

- **Scenario:** A deploy to `product-catalog` introduces a bug
  where it returns NOT_FOUND for product IDs that should
  exist. Load generator hits it at the usual rate; user-trace
  gRPC NOT_FOUND goes from ~5% to ~50%.
- **Today, after the metric-layer fix:** `serviceSummary`
  applies `user-trace-grpc-client-fault` filter; the spike
  doesn't show up in `error_rate`; `auto:error_rate:product-catalog`
  doesn't fire. The home panel correctly hides the noise but
  also hides the regression.

This is a deliberate tradeoff in v1. Reasoning: the alternative
(don't filter caller-faults from metrics) means every steady-state
synthetic-user fault rate triggers a permanent paging condition,
which is worse. The catch-rate cost of missing a real catalog
regression is mitigated by the slow-trace panel and operation
anomaly detector noticing the latency change first.

**Mitigations to consider before users complain:**

- Ship a second alert family that tracks `caller_fault_rate`
  per service (the inverted complement of the existing
  metric). Threshold on `Δ vs prior window` rather than
  absolute value — so steady-state 5% NOT_FOUND doesn't
  page, but a jump to 50% does.
- Surface caller-fault rate as a chip in the home panel near
  each service so operators can spot the trend without
  waiting for an alert.
- Add an eval scenario that simulates the catalog-regression
  case (load-gen Δ NOT_FOUND rate) and asserts the
  caller_fault_rate alert fires while error_rate stays
  quiet.

Not in v1 scope, but the bug-shape is documented so the next
review knows it's a known gap, not an oversight.

## Layers a heuristic might live at

When you add a new heuristic, walk this list before declaring done:

| Layer | Where | Why it might need the heuristic |
|---|---|---|
| Live KQL queries | `src/api/queries.ts` | Powers the live (non-cached) Home / Services / Errors paths via `listErrorClasses` et al. |
| Cached scheduled searches | `src/api/provisionedSearches.ts` + `src/api/queries.ts` | Drives the `criblapm__*` cached panels (`home_error_spans`, `home_service_summary`, etc.) read by Home. |
| Metric aggregation | `Q.serviceSummary`, `Q.prevWindowSummary`, `Q.allOperationsSummary` | Feeds the error_rate that drives alerts. **Must agree with display layer.** |
| Alert evaluator | `Q.alertEvaluator`, `Q.alertEvaluatorExportState` | The state-machine layer. Reads aggregates from cached metric search results. |
| Client-side display filter | `src/api/errorFilter.ts` `DEFAULT_FILTER_RULES` | What the user actually sees on Home. **Must agree with metric layer.** |
| Eval scenarios | `eval/scenarios/*.ts` | Locks the behavior in. New heuristic → new scenario verifying it fires (or doesn't) as expected. |
| Settings UI | `SettingsPage` | Where users can see and override. Surface confidence (signal counts) so users can audit. |
| Documentation | This file + `docs/research/error-filter-design.md` | The next reviewer / contributor needs to know the rule exists. |

Default assumption: a new filter heuristic touches at least the
KQL layer, the metric layer, the client-side filter, and this
file. If you find yourself only changing one of those, ask why.
