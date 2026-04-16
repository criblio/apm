# Scenario detection coverage + UI fix plan (2026-04-16)

Ran the scenario specs we have today against master, mapped each of
the 15 flags in `FAILURE-SCENARIOS.md` to its current UI detection
capability (cross-checked against source code because the docs
themselves are stale in several places), and drafted a prioritized
set of fixes for the genuine gaps. This doc feeds plan v2's
"scenario → fix → promote" ratchet: the fixes in the "Proposed PR
sequence" section below are the concrete next-round work items, and
the detection matrix is the input the eval-harness design doc
(still a plan v2 deliverable) needs when deciding which scenarios
to run nightly.

## What we ran

- **`tests/scenarios/payment-failure.spec.ts`** (scenario 1) against
  the deployed pack on staging.
- **`tests/scenarios/flagd-catalog-validation.spec.ts`** — the §6 /
  §7 / §14 flag-injection sanity check shipped in PR #10. All three
  flags produce post-flip errors; `adFailure` is a 10% Bernoulli
  trial (see PR #10 body for detail).

### Scenario 1 observations

Scenario 1's hard assertions are all green (payment row shows >1%
error rate at `-15m`; Error classes panel at `-1h` lists a payment
entry — this is PR #8's cache-miss fallback working as designed).

One **soft failure** on the Service Detail step:

> `Recent errors panel should list at least one trace for payment failures`
> Expected: not 0 · Received: 0 · Timeout: 10000ms

Captured screenshot confirms the issue: at the moment the assertion
timed out, the ServiceDetailPage panels (Top operations, Recent
errors, Dependencies) were still rendering loading skeletons. The
data wasn't wrong — it just hadn't arrived.

Root cause is a known and still-unfixed UI issue (FAILURE-SCENARIOS
known gap #6): **`ServiceDetailPage::fetchAll()` fires six
uncached parallel queries** and the slowest of them gate the whole
page. On a busy cluster at the default `-1h` range, the top-operations
rollup (`listOperationSummaries` — scans every span of the service
in the window) and the cross-service dependencies query can each
take 10-20s. Anything drilling into a service *during* an incident
(exactly when the page matters most) hits this.

The soft-failure is the test showing us the gap honestly — the
data is present, the UI just can't render it fast enough for a
click-driven interaction to feel responsive.

## Detection coverage — current state of master

| # | Scenario | Detected? | Primary surface | Notes |
|---|---|---|---|---|
| 1 | `paymentFailure` | ✅ | Home errors chip + Error classes + SvcDetail RED chart | Scenario 1 green on hard asserts via PR #8's cache fallback |
| 2 | `kafkaQueueProblems` | ⚠️ partial | Home p99 chip fires | **Slowest trace classes panel hides kafka consumer lag** — the stream filter correctly suppresses idle-wait span shapes in a healthy cluster but also suppresses actual lag traces (same shape) during this scenario |
| 3 | `adManualGc` | ✅ | Home p99 delta chip + SvcDetail p99 tile + RED chart bimodal | FAILURE-SCENARIOS §3 "no p99 tile" is **stale**. Tile exists at `src/routes/ServiceDetailPage.tsx:742` |
| 4 | `loadGeneratorFloodHomepage` | ✅ | Home rate chip (neutral blue) + rate sparkline spike | |
| 5 | `cartFailure` | ✅ | Home errors chip + root-cause hint | Hint points `frontend-proxy → cart`; see `HomePage.tsx:378-407` |
| 6 | `adFailure` | ⚠️ design limit | Home errors chip (faint ~1%) | 10% Bernoulli trial on `GetAds` only. Fundamental signal-to-noise limitation, not a fixable UI gap — see PR #10's FAILURE-SCENARIOS.md §6 rewrite |
| 7 | `productCatalogFailure` | ✅ | Home Error classes panel | Single-product-ID errors group by distinctive message |
| 8 | `recommendationCacheFailure` | ✅ | Home errors + p95 chip | Same shape as scenario 1 |
| 9 | `paymentUnreachable` | ✅ | Home rate-drop red chip + SystemArch ghost node | ROADMAP 1b.1 (ghost nodes) and 1b.2 (red rate-drop) are **both already implemented** — see `SystemArchPage.tsx:199` and `DeltaChip.tsx` `rateDrop` mode. ROADMAP entries are stale |
| 10 | `adHighCpu` | ✅ | Home p95 + p99 delta chips | Broad-distribution shift; both chips fire |
| 11 | `emailMemoryLeak` | ❌ missing | (aggregate Duration chart drifts) | **No per-instance view.** One leaking pod dilutes in the service-level aggregate. `service.instance.id` is on the spans; the UI doesn't group by it anywhere |
| 12 | `failedReadinessProbe` | ⚠️ partial | Propagated errors on upstream callers + ghost node | k8s events aren't in the dataset — the root cause path is invisible. Ghost node shows the *effect* |
| 13 | `llmInaccurateResponse` | ❌ out of scope | — | Semantic correctness of LLM output is not observable from spans/logs/metrics |
| 14 | `llmRateLimitError` | ✅ | Home errors + Error classes | Same shape as scenario 1 |
| 15 | `imageSlowLoad` | ❌ out of scope | — | Client-side browser delay; needs RUM (ROADMAP §10) |

**Summary:**

- **9 fully detected** (1, 3, 4, 5, 7, 8, 9, 10, 14)
- **3 partially detected** with known UI fixes (2, 11, 12)
- **1 design limit** not fixable in UI (6)
- **2 out of scope** for backend APM (13, 15)

The per-scenario assessment surfaced a secondary finding worth its
own section:

## Many "known gaps" are already fixed

During the audit I verified every claimed UI gap in both ROADMAP.md
(section 1b) and FAILURE-SCENARIOS.md (the "Known UI gaps" table)
against the current source. Most were implemented at some point and
the documentation was never refreshed:

| Doc entry | Actual status | Evidence |
|---|---|---|
| ROADMAP 1b.1 "Ghost nodes on System Architecture" | ✅ Implemented | `SystemArchPage.tsx:199-290` — `traffic_drop` and `silent` health buckets render dashed/outlined nodes |
| ROADMAP 1b.2 "Red DOWN chip on rate column" | ✅ Implemented | `DeltaChip.tsx:36,80-89` — `rateDrop` mode, `RATE_DROP_THRESHOLD = 0.5`, red tone when ratio ≤ 0.5 |
| ROADMAP 1b.3 "Root-cause hint on Home rows" | ✅ Implemented | `HomePage.tsx:378-407` — `rootCauseHints` aggregates outgoing RPC edges per service, renders `→ likely <child>` |
| FAILURE-SCENARIOS §3 "No p99 tile in SvcDetail stats" | ✅ Implemented | `ServiceDetailPage.tsx:742-744` — `<span className={s.statLabel}>p99</span>` |
| FAILURE-SCENARIOS gap #1 "Messaging edges not on arch graph" | ✅ Implemented | Documented as a WIN in ROADMAP.md's "Things we have that ARE competitive" section; `criblapm__sysarch_messaging_deps` scheduled search |
| FAILURE-SCENARIOS gap #3 "Slow trace classes polluted by flagd streams" | ✅ Implemented | `src/api/streamFilter.ts` — `STREAM_DURATION_US = 30_000_000` + `STREAM_CHILD_RATIO = 0.1` heuristic |

Fix #5 below is a 30-minute cleanup PR to prune these stale entries.
Leaving them in place wastes future review cycles — every audit like
this one rediscovers that they're already done.

## Proposed fixes

Ordered by leverage (how many scenarios each unblocks) × effort.

### Fix 1 — ServiceDetail panel caching (highest leverage)

**Scope.** Mirror the Home-panel cache pattern from `src/api/panelCache.ts`
onto ServiceDetail. Three new `criblapm__svc_*` scheduled searches
grouped by `svc`, plus a `listCachedSvcPanels(serviceName)` reader
that `ServiceDetailPage::fetchAll()` consults before firing live
queries.

Candidate scheduled searches:

| Saved search ID | What it caches | Read by |
|---|---|---|
| `criblapm__svc_operations` | Per-`(svc, op)` rollup (rate / error / p50 / p95 / p99) | Top operations table |
| `criblapm__svc_recent_errors` | Rolling 20 most-recent error traces per service | Recent errors panel |

The dependencies query (`getDependencies`) is already cached by
`criblapm__sysarch_dependencies` — ServiceDetail just isn't reading
from that cache. Wire it up without new scheduled searches.

**Cache-miss fallback.** Same shape as PR #8: cache-read returning
`null` / empty per panel falls through to a live query for that
specific panel only, keeping the other panels on their cached values.

**Scenarios unblocked.** Every scenario where the user clicks into
ServiceDetail: 1, 5, 6, 8, 9, 10, 14 (and 3 / 11 once they become
hardenable). Makes scenario-1's `Recent errors` soft assertion
deterministic.

**Generality.** Rollups group by `svc`; no service names appear in
the scheduled-search definitions. No flag-specific knowledge.
Matches the existing Home panel cache's shape.

**Est effort.** 1-2 days. Most of the work is provisioning
boilerplate (new scheduled searches, new `provisionedSearches.ts`
entries) and mirroring the existing `listCachedHomePanels` reader
onto a per-service scoped variant. The Home cache has been
production-tested for weeks so the pattern is low-risk.

### Fix 2 — Instances tab on ServiceDetail (scenario 11)

**Scope.** New tab on ServiceDetailPage alongside the existing
Overview / Metrics / etc. Groups the same RED metrics by
`resource.attributes['service.instance.id']` instead of at the
service level. Table with sortable columns (rate / error rate /
p50 / p95 / p99) and a click-through that filters the Duration
chart to just that instance.

Query: `serviceOperations()` pattern from `queries.ts` with the
`by name` replaced by `by instance_id=tostring(resource.attributes['service.instance.id'])`.
No new KQL primitives needed.

**Scenarios unblocked.** 11 (`emailMemoryLeak`) — the leaking pod
drifts upward on the p95/p99 rows while the others stay flat.
Also useful for any single-pod failure mode: rolling-restart in
flight, slow-start, noisy-neighbor, an individual pod with stale
config.

**Generality.** `service.instance.id` is a standard OTel resource
attribute (every language SDK populates it). No k8s-specific or
pod-name-pattern knowledge; the query just groups by whatever
instance ids exist.

**Est effort.** 1-2 days. Query is trivial (one grouping change);
UI is a new table + chart-filter wiring.

### Fix 3 — Kafka-aware stream filter exemption (scenario 2)

**Scope.** `src/api/streamFilter.ts::streamFilterKqlClause()` and
`streamFilterSpanKqlClause()` each emit a KQL fragment that hides
traces matching the idle-wait heuristic. Add an operation-name
exemption: when the root operation name matches a kafka consumer
pattern (`/-consumed$/` or `/\.Consume[A-Za-z]*$/`), don't apply
the filter. Kafka consumer spans always *look* like idle-wait
(one long root with tiny children), but during scenario 2
(`kafkaQueueProblems`) that appearance *is* the signal we want
to preserve.

**Scenarios unblocked.** 2 (`kafkaQueueProblems`). Slowest trace
classes panel on Home starts showing `accounting order-consumed`
and similar entries with multi-minute durations when the flag is on.

**Generality.** The exemption matches on operation-name pattern,
not on service name. Any kafka consumer operation from any service
benefits; any non-kafka operation still gets the filter.

**Est effort.** Under an hour. Two-line KQL conditional.

### Fix 4 — Bump scenario 1 Recent errors timeout

**Scope.** In `tests/scenarios/payment-failure.spec.ts:202`, raise
the `toHaveCount(0, { timeout: 10_000 })` budget to 30s so the
assertion stops flaking while Fix 1 is in flight. Once ServiceDetail
panel caching lands, this can come back down.

**Scenarios unblocked.** Scenario 1 runs green end-to-end again
without a stale soft-fail.

**Est effort.** 5 minutes.

### Fix 5 — Prune stale ROADMAP / FAILURE-SCENARIOS entries

**Scope.** Delete or update the six doc entries listed in the
"Many 'known gaps' are already fixed" table above. ROADMAP 1b
becomes "done"; FAILURE-SCENARIOS known gaps table drops rows
#1, #3; FAILURE-SCENARIOS §3 loses the `p99 tile` limitation
bullet.

**Scenarios unblocked.** None directly. Saves future audit time.

**Est effort.** 30 minutes.

## What this does NOT unblock

### Still design-limited (no UI fix)

- **Scenario 6 `adFailure`** — 10% Bernoulli trial hard-coded in
  upstream `AdService.java`. Detection is already working but
  chronically low-SNR. Best we can do is document the rate (PR #10
  §6 rewrite) and make sure the test spec tolerates it.
- **Scenario 13 `llmInaccurateResponse`** — semantic correctness of
  an LLM response is fundamentally not observable from
  spans/logs/metrics. Out of scope for a backend APM.

### Still out of scope (needs new data shape)

- **Scenario 15 `imageSlowLoad`** — client-side browser delay; needs
  RUM. Already listed as ROADMAP §10.
- **Scenario 12 `failedReadinessProbe`** (root cause visibility) —
  the *effect* is detected today (ghost node + upstream connection
  errors), but the *cause* (k8s `Readiness probe failed` event)
  lives in the Kubernetes events stream, which isn't in the `otel`
  dataset by default. Getting root-cause visibility here would
  require either (a) ingesting k8s events via the OTel log
  collector, or (b) the Log Explorer would need to handle a
  separate dataset of k8s events. Not scoped here.

## Proposed PR sequence

| Order | PR | Est | Unblocks |
|---|---|---|---|
| 1 | `test: bump scenario 1 Recent errors timeout` | 5 min | scenario 1 regression-test goes green |
| 2 | `fix: exempt kafka consumer ops from stream filter` | ~1 hr | scenario 2 |
| 3 | `perf: ServiceDetail panel caching` | 1-2 days | scenarios 1, 5, 6, 8, 9, 10, 14 (faster load during incidents) |
| 4 | `feat: Instances tab on ServiceDetail` | 1-2 days | scenario 11 |
| 5 | `docs: prune stale ROADMAP + FAILURE-SCENARIOS gap entries` | 30 min | removes six already-solved items from the docs |

Total: roughly 3-4 days of focused work.

After PRs 1-4 merge, **every theoretically-detectable scenario (12
of the 15) has a working UI surface**. PR 5 is optional cleanup.
The remaining three scenarios (6, 13, 15) are documented
limitations rather than unfinished work.

## How this feeds plan v2

Plan v2 deferred PRs #3-#7 (kafka / payment-unreachable / delta-chip
fix / ghost-nodes fix / ad-manual-gc scenario specs) pending the
eval-harness design doc. With this audit:

- **PR #5 (`fix/delta-chip-rate-drop-red`)** in plan v2 is **already
  done** in the codebase — the `rateDrop` mode exists in
  `DeltaChip.tsx` and is wired on Home catalog's rate column. Drop
  from the sequence.
- **PR #6 (`fix/system-arch-ghost-nodes`)** in plan v2 is **already
  done** — `SystemArchPage.tsx` renders `traffic_drop` / `silent`
  health buckets with dashed outlines. Drop from the sequence.
- Plan v2's PR #3 (`scenarios/kafka-queue-problems`) should be
  authored *after* Fix 3 above lands so the Slowest trace classes
  assertion doesn't start life soft-fail-ing.
- Plan v2's PR #4 (`scenarios/payment-unreachable`) can be authored
  now — the surfaces it's meant to assert on are all present.
- Plan v2's PR #7 (`scenarios/ad-manual-gc`) can be authored now
  for the same reason.

The eval-harness design doc should pick the **fully-detected
scenarios** from the coverage table (rows marked ✅) as its v1
scenario list, since those are the ones where per-run pass/fail
has meaning today. Partially-detected scenarios (2, 11, 12) should
be added to the harness only after the corresponding fix lands.
