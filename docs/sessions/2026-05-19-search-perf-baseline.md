# Session: 2026-05-19 — Search performance baseline (Phase 1)

Phase 1 of `docs/research/search-perf-plan.md`. Captures the
current scheduled-search workload and the UI timings under that
workload, before any changes (cadence drops, consolidation,
Lakehouse indexed fields). Each number is one sample from a real
run against the live staging workspace — not multi-run averaged —
so treat them as order-of-magnitude indicators, not precise SLOs.

## Snapshot conditions

- Workspace: `main-objective-shirley-sho21r7.cribl-staging.cloud`
- Pack version: 0.7.3 (commit `001b5b5`)
- Scheduled searches deployed: 16 `criblapm__*`
- Sample window for backend timings: 100 most recent scheduled
  job records via `cribl_getSearchJobs` (covers ~25 minutes,
  2-3 runs per 5-min search and 1-2 runs per hourly search).
- UI timings captured via
  `tests/baseline-ui-timing.spec.ts` (Playwright) in one
  consecutive run, immediately after the backend timing pull.

## Backend: per-search runtime + queue wait

Sorted by estimated worker-runtime contribution per hour
(`p50 runtime × cadence`).

| Scheduled search | n | p50 runtime | max runtime | p50 queue wait | max queue wait | runs/hr | work s/hr |
|---|---:|---:|---:|---:|---:|---:|---:|
| `criblapm__home_service_summary` | 3 | 11.3 s | 16.2 s | 61.0 s | 62.8 s | 12 | 135.0 |
| `criblapm__error_rate_daily` | 2 | **134.8 s** | 198.5 s | 87.5 s | 172.0 s | 1 | 134.8 |
| `criblapm__home_error_spans` | 3 | 7.4 s | 8.5 s | 47.7 s | 81.7 s | 12 | 88.5 |
| `criblapm__sysarch_messaging_deps` | 3 | 7.2 s | 12.3 s | 47.7 s | 56.6 s | 12 | 86.3 |
| `criblapm__sysarch_dependencies` | 3 | 7.2 s | 7.2 s | 12.4 s | 49.8 s | 12 | 86.1 |
| `criblapm__metric_catalog` | 3 | 4.4 s | 9.6 s | 38.6 s | 39.9 s | 12 | 52.6 |
| `criblapm__op_baselines` | 2 | **42.5 s** | 55.6 s | 184.2 s | 288.8 s | 1 | 42.5 |
| `criblapm__home_slow_traces` | 3 | 3.2 s | 3.7 s | 41.3 s | 48.9 s | 12 | 38.3 |
| `criblapm__svc_operations` | 3 | 3.0 s | 3.7 s | 30.4 s | 88.8 s | 12 | 36.2 |
| `criblapm__home_service_time_series` | 3 | 3.0 s | 3.8 s | 23.4 s | 68.0 s | 12 | 35.4 |
| `criblapm__trace_originators` | 3 | 1.1 s | 1.2 s | 43.5 s | 77.0 s | 12 | 12.9 |
| `criblapm__alert_history_send` | 3 | 0.9 s | 1.1 s | 24.9 s | 33.8 s | 12 | 10.6 |
| `criblapm__alert_state_export` | 3 | 0.8 s | 0.8 s | 28.9 s | 36.0 s | 12 | 9.3 |
| `criblapm__home_alerts` | 3 | 0.7 s | 0.8 s | 20.8 s | 35.9 s | 12 | 8.8 |
| `criblapm__attr_catalog` | 2 | — | — | — | — | 1 | **FAILING** |
| `criblapm__home_alerts_prev` | 3 | — | — | — | — | 12 | **FAILING** |

**Aggregate**: 777.3 worker-seconds / hour = **12.95 worker-minutes
per hour spent on this pack's scheduled searches** — 21.6% of a
single worker continuously, before any UI or Investigator
queries.

### Two searches are failing in production

Discovered during this baseline, both with the same Cribl-internal
error `"Unexpected 'reset' signal received"` from the `func:store`
channel inside a `*-lakehouse` pipeline (looks like a
resource-exhaustion kill, not a query bug):

- **`criblapm__attr_catalog`** — fails on both runs sampled. The
  bag_keys / mv-expand discovery query introduced in
  commit `2d73152`. **Ad-hoc execution of the same KQL via MCP
  succeeds** — so it's specific to the scheduled run path,
  likely the work being done while other heavy scheduled
  searches fire concurrently.
- **`criblapm__home_alerts_prev`** — fails on all 3 runs sampled.
  This is the **previous-window summary the alert evaluator
  joins against**. If it stays down, alerts are running on
  stale `criblapm_alert_prev` data — meaning the alert pipeline
  is silently degraded. **Higher-priority than the cadence
  cleanup**.

### Queue wait dominates runtime for most searches

The runtime-vs-queue-wait gap is the story. A search like
`criblapm__home_alerts` runs in 0.7s but waits 20.8s in the queue
to start. Every scheduled search pays a ~30-60s queue tax on top
of its actual work — and ad-hoc / Investigator queries pay that
same tax against the same queue.

### Where the worker-time goes

The two daily/weekly aggregations (`error_rate_daily`,
`op_baselines`) together consume **177 worker-seconds per hour**
(23% of the pack's scheduled-search budget), despite each running
only once per hour. Both are -7d or -24h windows; the only path
to making them cheaper is the Lakehouse indexed-fields + Parquet
pushdown work (Phase 4-6 of the plan), or moving them to less
frequent cadence (`error_rate_daily` proposed → every 6h).

The 5-minute cluster — eight searches running every 5 minutes on
-1h windows — sums to **~556 worker-seconds / hour**, 71% of the
budget. The Phase 3 consolidation (merge the four that all scan
the same span set into one wide aggregation + emit-only
downstream searches) targets this cluster specifically.

## Frontend: UI page timings

Wall-clock from `page.goto` (or click) to a known "primary
content visible" marker, via Playwright. One run, one sample per
page. Specs at `tests/baseline-ui-timing.spec.ts`.

| Page | Nav ms | First-content ms | Marker |
|---|---:|---:|---|
| Home / Overview (`/?range=-15m`) | 5,384 | **5,437** | Detected Issues / Overview heading |
| Services list | 4,946 | **35,271** | "Services (N)" header |
| Service Detail (frontend) | 33,051 | **33,158** | "Top operations" heading |
| Errors | 4,490 | **19,045** | first table row OR empty state |
| System Architecture | 4,369 | **4,403** | first SVG visible |

**Reading the numbers:**

- Home and System Architecture render *fast* (5s, 4s) because
  they read from the cached panel batch (`$vt_results` of the
  5-min searches) — the cache was warm at the moment of capture.
- Services list takes **35 seconds** to show the service table
  on a *cold* navigation. The Services page does a live query
  (no batch cache for the operations table). That's the
  operator's most common landing page; the latency is felt every
  time.
- Service Detail (frontend) takes **33 seconds** including the
  nav (which itself was 33s because it had to wait for Services
  to populate before clicking). Once Services is up, Service
  Detail loads in <1s — both numbers come back near 33s because
  the nav latency dominated.
- Errors takes **19 seconds**.

The two 30s+ numbers are the visible part of the queue-saturation
story from the backend side — the operator sees a spinner for
35s on the most-clicked page.

## What this tells us about the perf-plan phases

Re-grounding the plan against the baseline:

| Plan phase | Now blocks? | Priority |
|---|---|---|
| **Fix the two failing searches** | not in plan; **immediate** | NEW: must come before Phase 2 — alerts are silently degraded |
| Phase 2: cadence audit | Recoverable but limited — at most ~50s/hr from cadence drops on trace_originators / metric_catalog / svc_operations / error_rate_daily | Easy win, ship today |
| Phase 3: consolidate the 4 span-scanning 5-min searches | Targets the 556 s/hr cluster — biggest single recoverable | The real lever |
| Phase 4: Lakehouse top-level fields | The only way to make error_rate_daily / op_baselines cheaper | Cribl-side; needs scheduling |
| Phase 5: query refactor | Required after Phase 4 lands | Depends on Phase 4 |
| Phase 6: indexed fields | The slot allocation (`service.name`, `status.code`, `kind`, `name`, `parent_span_id`) becomes the right test for Phase 4 | Depends on Phase 4 |

## Raw artifacts

- Backend timing extraction lives in the session log (this file).
  Source data: 100 scheduled-job records pulled via
  `mcp__cribl__cribl_getSearchJobs`, saved to
  `~/.claude/projects/-home-clint-local-src-apm/698c4362-.../tool-results/`
  on the local box. The file is large; the Python extract used
  is reproduced here:

  ```python
  import json, statistics
  from collections import defaultdict
  jobs = json.load(open(PATH))['items']
  by_name = defaultdict(list)
  for j in jobs:
      n = j.get('correlationId')
      if not isinstance(n, str) or not n.startswith('criblapm__'): continue
      if j.get('status') != 'completed': continue
      s = j.get('timeStarted'); c = j.get('timeCompleted'); cr = j.get('timeCreated')
      if None in (s,c,cr): continue
      by_name[n].append((c-s, s-cr))
  ```

- UI timings: `/tmp/apm-baseline-ui.json` (5 rows, one per page).
  Specs at `tests/baseline-ui-timing.spec.ts`. The spec captures
  partial data on timeout so re-runs under different load
  conditions remain comparable.

## Next step

Ship the two-failure fix first (separate PR). Then Phase 2
cadence audit. Re-run this baseline after each change, append
to this document for the before / after diff.

---

## 2026-05-20 — round 1 changes shipped

A combined PR landed five changes ahead of Phase 2 proper. Each
either eliminates wasted recomputation or removes a known failure
mode the baseline surfaced. Numbers are projected savings against
the baseline above; a fresh measurement run will append below.

### Changes shipped

1. **`criblapm__error_rate_daily` → `criblapm__error_rate_history`**
   (renamed, reshaped, slowed cadence). The old version
   recomputed the same 7-day aggregate every hour; 6 of those 7
   days were immutable, so 23/24 of the work was wasted. The new
   version:
   - Runs **once per day at 00:30 UTC** instead of hourly
     (`30 0 * * *`).
   - Outputs **one row per service** with columns
     `d1_pct .. d6_pct` (yesterday through 6 days ago) instead of
     one row per (svc, day). This fixes the "lookup returns only
     one row per key" trap that made the old lookup unreadable
     by the Investigator playbook.
   - Today's data point intentionally lives elsewhere (the live
     1h service summary) — today is partial and would skew the
     slope.
   - Projected saving: **~129 s/hr** (134.8 s/hr → 5.6 s/hr
     amortized).

2. **`criblapm__metric_catalog` cadence drop**: 5min →
   hourly (`7 * * * *`). Metric names don't appear/disappear at
   5-min granularity. Projected saving: **~48 s/hr**.

3. **`criblapm__trace_originators` cadence drop**: 5min → hourly
   (`11 * * * *`); window expanded -5m → -15m to keep the
   sample size meaningful at the slower cadence. Originator type
   for a service changes ~never. Projected saving: **~12 s/hr**.

4. **`criblapm__op_baselines` cadence drop**: hourly → every 6h
   (`23 */6 * * *`). Per-op p95 baselines move slowly; this is
   the second-heaviest search in the pack. Projected saving:
   **~35 s/hr**.

5. **`criblapm__attr_catalog` sample reduction**: 5000 → 1000
   spans. The bag_keys + mv-expand pipeline explodes the row
   count ~20x per input span; 5000 input → 100K intermediate
   was hitting Cribl's `"Unexpected 'reset' signal"`
   (resource-exhaustion kill) on every scheduled run. 1000
   input is plenty for discovery and lets the run complete.
   **Fixes a failure**, doesn't change steady-state cost.

### Investigator playbook update

`staticPreamble` in `agentContext.ts` now points the leak
fingerprint check at the new lookup shape — one `lookup ... on
svc` per service returns six daily error-rate percentages in a
single row. Today's data point comes from a separate live
summary query. The playbook calls out the cron lag explicitly
("if the lookup isn't populated yet, fall back to four short
windows").

### Projected aggregate impact

| Change | Saving (s/hr) |
|---|---:|
| error_rate_history daily | 129 |
| metric_catalog hourly | 48 |
| op_baselines every-6h | 35 |
| trace_originators hourly | 12 |
| attr_catalog stable | 0 (correctness) |
| **Total projected** | **224** |

That's **29% of the pack's 777 s/hr baseline** budget removed,
before any consolidation or Lakehouse work. Re-measurement run
will confirm.

### Operational note

The new `criblapm__error_rate_history` search runs at 00:30 UTC
daily, so the lookup will be empty (seed sentinel only) until the
first scheduled run after deploy. The Investigator playbook
falls back to the four-short-windows pattern when the lookup is
empty, so this is graceful. To populate immediately, kick a
manual run from the Cribl UI.

### Remaining audit findings (not shipped here)

Documented for the follow-up cycle:

- **`home_alerts_prev` is failing on every run** (same
  `"Unexpected 'reset' signal"` as the old attr_catalog). This
  query mirrors `home_service_summary` exactly — does the same
  three span scans (primary scan + two scans inside the
  `errorClassificationJoins` subqueries) but on the
  previous-window range. The alert evaluator reads its output;
  while it's down, alerts are running against a stale
  `criblapm_alert_prev` lookup. **Highest-priority follow-up.**
  Likely fix: split the search into a cheap branch (requests +
  percentiles, no joins) and a separate filtered-errors branch
  that operates only on `is_error == true` rows, then merge.
  Same pattern would also speed up `home_service_summary`
  (~5-7 s/run × 12 runs/hr = ~60-84 s/hr savings).

- **`sysarch_dependencies` + `sysarch_messaging_deps`** (~7.2s
  each, both running every 5 min on -1h) share the SAME input
  span scan and only differ in the join's right-side filter
  (RPC edges vs messaging edges). Consolidating into one search
  that emits both shapes via `union` and `case`-tagged rows
  would save one full -1h span scan per cycle (~75 s/hr).

- **`home_slow_traces`, `svc_operations`,
  `home_service_time_series`** (all ~3s, 5min, -1h) are
  candidates for the broader "cache the primary scan in
  `$vt_results` once per cycle, downstream emit-only searches
  read from cache" pattern this pack already uses in the alert
  pipeline. The savings per individual search are small but the
  pattern compounds.

- **The triple-scan inside `errorClassificationJoins`** is the
  single largest invisible cost across the alert pipeline. Every
  call to `serviceSummary` / `prevWindowSummary` /
  `rawRecentErrorSpans` runs the function — each invocation does
  3 span scans (primary + 2 inside the subqueries). Pre-computing
  `(trace_id, trace_origin)` and `(trace_id, parent_span_id) →
  has_error_child` as small lookups would let the consumers
  replace two leftouter joins with cheap lookup operations. This
  is the dataset-level acceleration story Lakehouse indexed
  fields exist to solve, but it's also tractable in pure KQL via
  scheduled pre-compute.

Each of these is its own design conversation; not bundled into
the current change.
