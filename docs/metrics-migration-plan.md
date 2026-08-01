# Metrics migration & upgrade plan — `$vt_results` → fast metrics store

**Status:** design. Read path AND write path both **validated live on
staging (2026-07-23)** — counter, gauge, and histogram all `export to
metrics` from OTel spans with zero drops and read back via the fast PromQL
engine (incl. `histogram_quantile` for latency). See
`docs/sessions/2026-07-23-vt-results-to-metrics.md` §"Phase 0 write-path —
VALIDATED" for the exact recipes. The migration is unblocked; this doc is
the execution plan.

> Correction: an earlier revision of this plan said the write path was a
> "forthcoming-platform dependency." That was wrong — it was two syntax
> bugs (time-field name after `summarize bin`, and `type=histogram` must be
> a literal export param, not a `typeField` value). Both fixed and
> validated.

## Why

Panel reads today run as KQL search jobs (`dataset="$vt_results" | where
jobName in (...)`), which occupy the small staging worker pool and are a
real source of the concurrency saturation the scenario-test guidance in
`CLAUDE.md` warns about. Metrics queries use a **synchronous
`searchJobSource=metrics` GET — no search job** — and return in ~ms. The
goal: move the RED (rate/errors/duration) panel reads off the worker pool
onto the metrics query engine, and get free history + any-range reads.

## Confirmed facts (live, 2026-07-23)

- Fast PromQL store = dataset `metrics` (type `cribl_search`,
  `eventStorageSchemaVersion`); read via `@cribl/app-utils/metrics`.
- Read-time aggregations work: `histogram_quantile`, `rate`, `sum by`,
  `topk`, scalar math. `label_replace` / vector `or` **fail** (core PromQL
  only). Histogram type is real (24 `hist_default` metrics live).
- `export to metrics` syntax (confirmed correct by Clint):
  ```kusto
  … | summarize value=count() by bin(_time, 1m), <dims…>
    | extend name="<metric>", type="counter"    // or "gauge"/"histogram"
    | export to metrics
        timeField=_time nameField=name valueField=value
        typeField=type labelFields=[<dims…>]
  ```
- **Write path works from OTel spans** (validated). Two gotchas baked into
  the recipes: after `summarize … by bin(_time,1m)` rename the time column
  (`| project-rename _time=bin_time_1m`); pass histogram type as the literal
  `type=histogram` param (not `typeField`). Always read the export output
  table (`eventsOut/eventsDropped/dropReasons`) — a `completed` job can
  still drop 100% of events (`invalid_type`).

## Target architecture

```
 spans (otel)
   │  scheduled search, incremental window, export to metrics   ← GATED until platform support
   ▼
 metrics store  (criblapm_* series)
   │  @cribl/app-utils/metrics  (queryRange / queryInstant)     ← synchronous, no worker job
   ▼
 useMetricsQuery hooks  →  panelCache dual-read  →  panels
```

Dual-read is the safety net: a panel asks for metrics first, and on empty/
error falls back to the existing `$vt_results` cache, then to the live
span query — extending `panelCache.ts`'s current miss→live seam by one
layer on top.

### Emitters (authored against confirmed syntax; provisioned only when gated on)

One incremental scheduled search per metric family, `-5m`/1m bins, so each
run scans ~5 min instead of re-scanning a rolling 1h every 5 min (the
overlap-elimination win). Labels kept low-cardinality.

| Metric | Type | Labels | Source aggregation |
|---|---|---|---|
| `criblapm_request_total` | counter | `service` (+ `operation` in P4) | `count()` per 1m bin |
| `criblapm_error_total` | counter | `service` | `countif(is_error)` |
| `criblapm_request_duration_ms` | histogram | `service` | **raw per-span `dur_ms` rows** (many per 1m bin) → `type=histogram`; store buckets to `hist_default`. Validated. |

Read patterns (all synchronous):
- rate: `sum(rate(criblapm_request_total[5m])) by (service)`
- error %: `sum(rate(criblapm_error_total[5m])) by (service) / sum(rate(criblapm_request_total[5m])) by (service)`
- latency: `histogram_quantile(0.95, sum(rate(criblapm_request_duration_ms[5m])) by (le, service))` — validated, real per-service p95.

**Counter emit caveat (still to pin down):** our per-bin `count()` is a
*delta*, not a cumulative counter. `rate()` gave plausible numbers in
testing, but confirm whether the store treats an emitted `type=counter`
point as cumulative (`rate` correct) or delta (`sum_over_time` correct)
before trusting production dashboards.

### Read layer (foundation — landable now)

- `src/api/metrics.ts` — thin re-export of `@cribl/app-utils/metrics`
  (subpath import; never the root barrel — it pulls `node:fs`).
- `src/hooks/useMetricsQuery.ts` — port ubiquiti's
  `useRangeQuery`/`useInstantQuery`/`useScalarQuery`, incl. its
  non-destructive-refresh behavior.
- Testable today against host metrics already in the store (proves the
  fetch-proxy path from APM's build), even though no `criblapm_*` series
  exist yet.

## Migration (running install, no breakage)

Phased so each step is independently shippable and reversible. All steps
are executable now (write path validated); the gating below is for
staged rollout + safe rollback, not a platform wait.

- **M1 — read foundation (now).** Add the client + hooks. No behavior
  change; nothing reads metrics yet.
- **M2 — dual-read seam (now, dark).** Extend `panelCache.ts` so RED
  panels *try* metrics first, but the metrics path is behind a KV flag
  (`metricsRead: false` default) and short-circuits to today's
  `$vt_results` path. Ship dormant; validated by unit tests with a
  mocked metrics client.
- **M3 — emit.** Add the emitter scheduled searches to
  `provisionedSearches.ts` behind a provision-time gate (see Upgrades).
  Provision. Metrics begin accumulating **from now forward** — see
  Backfill.
- **M3.5 — backfill (on enable).** Immediately after turning emit on, run
  each emitter query **once** over a wide historical window so the store
  has history from day one (see Backfill). Without this, M5 can't happen
  without a blackout.
- **M4 — flip read flag per panel.** Turn `metricsRead` on for the
  time-series + summary panels once a week of side-by-side agreement
  (metric-derived vs `$vt_results`) holds. During transition the read
  falls back to a **live span query** (not the cache) on a metrics miss —
  the cache is on its way out, not a permanent tier.
- **M5 — retire the caches (REQUIRED end state, not optional).** The
  migrated `$vt_results` panel-cache searches are **removed**, not left as
  a standing fallback — remove the plan entries and the provisioner
  **deletes** them on reconcile. End state: RED panels read metrics, with
  live span queries as the only fallback. This is where the cost drops.
- **M6 — collapse derived searches.** `error_rate_history`,
  `op_baselines`, `home_alerts_prev` become PromQL derivations; delete
  them and their seed lookups.

**Not migratable (stay on `$vt_results` / live — they are not metric-shaped):**
`home_slow_traces`, `home_error_spans`, `error_propagation`,
`metric_catalog`, `home_alerts`. "No `$vt_results` after migration" applies
to the RED/summary caches being replaced; these raw-row / state panels
have no metric representation, so removing them from `$vt_results` is a
separate effort (direct live queries or another store) — called out here
so it isn't assumed done.

### Backfill / no-history-before-emit

`$vt_results` searches don't backfill today (they run forward, keep only
`keepLastN`); the historical views re-scan the raw span lakehouse each run.
Metrics accumulate only from the first emit, so a naive enable leaves
7d/30d charts blank for a week. **Fix: an on-enable backfill emit** — the
emitter reads *raw spans*, which are already retained, so run it once over
a wide historical window to populate metric history immediately. This is
what lets M5 delete the caches with no blackout (replacing the earlier
"keep `$vt_results` alive through backfill" idea).

Backfill constraints:
- **Non-overlap** with the forward emitter (store double-counts): backfill
  covers `[now-Nd, floor(now)@m)`; forward emit starts at `floor(now)@m`.
  Run exactly once (a one-shot job / provisioning step, not a scheduled
  search).
- **Bounded by raw-span retention and query cost** — a -7d/-30d span scan
  is heavy (the -7d `error_rate_history` scan is ~60-70s); chunk the
  backfill by day/window.
- **Histogram volume** — a per-span histogram backfill over weeks is
  billions of rows; **sample** for the histogram (counters aggregate fine).
- A `metricsCoverageStart` timestamp (KV) still records the true earliest
  covered time so a reader can note "history begins <date>" if a query
  reaches past the backfill horizon.

## Upgrades

The app upgrades by uploading a new pack + running the provisioner
(`npm run deploy` → `scripts/provision.ts`). The migration must be safe
across **version skew** (server may run an older/newer app than the
provisioned searches) and **re-provision idempotency**.

- **Provisioner reconcile = create/update/delete/noop** keyed on the
  `criblapm__` id prefix. Adding a plan entry creates it; removing one
  **deletes** it. So M3 = add emitter entries, M5 = remove old-cache
  entries — both are ordinary reconciles. Order the removals *after* the
  read flip so a rollback (see below) still has the caches.
- **Provision-time gate for emitters.** Mirror `getSearchCadenceCron()` /
  low-volume-mode: read a flag at plan-build time so
  `getProvisioningPlan()` includes emitters only when
  `metricsEmit` is on. Toggling requires a re-provision (the KQL is baked
  into the scheduled search at creation) — same contract as existing
  gates. Default off until the platform supports OTel input.
- **Runtime gate for reads.** `metricsRead` lives in `appSettings` (KV),
  read per-render by the hooks — flips without a re-provision, and can be
  turned off instantly if a panel misbehaves.
- **Version skew safety:**
  - *Old app + new searches:* old readers ignore `criblapm_*` metrics and
    keep reading `$vt_results` (which still exists through M4). Safe.
  - *New app + old searches (emitters not yet provisioned):* `metricsRead`
    default-off + dual-read fallback → behaves exactly like today. Safe.
  - Never delete a `$vt_results` cache in the same release that first
    reads its metric replacement; leave one release of overlap so a
    rollback has the cache to fall back to.
- **Seed lookups:** M6's deletions must also drop the corresponding
  `SEED_LOOKUPS` entries and, if desired, the lookup tables — but only
  after confirming no provisioned search still `lookup`s them.
- **Rollback:** flip `metricsRead` off (instant, KV) to revert reads;
  re-add removed cache entries and re-provision to restore emit. Because
  overlap is maintained until M5, rollback within the M3–M4 window is
  a flag flip with no data loss.

## Rollout sequence

1. **Now:** M1 (client + hooks), M2 (dark dual-read seam), this plan, and
   the emitter KQL authored from the validated recipes + unit-tested.
2. Turn on `metricsEmit`, provision (M3), let metrics accumulate.
3. Validate a week of agreement (metric-derived vs `$vt_results`), flip
   `metricsRead` per panel (M4).
4. Retire redundant searches (M5), collapse derived searches (M6).

Before M4, still resolve: counter cumulative-vs-delta; incremental-window
idempotency; label cardinality; per-span histogram volume vs sampling.

## Implemented so far (2026-07-23) — full candidate migration wired

All metric-candidate RED panels now read from the fast store first
(metrics-primary), across **all** time ranges, with live-events fallback.
Both flags default **ON** (`metricsRead`, `metricsEmit`), KV-overridable.

- **6 emitters** (all validated live, 0 drops): `criblapm_requests_total`
  (svc, operation, outcome) + `criblapm_request_duration_ms` (svc,
  operation) + edge calls/duration (parent, child) + messaging
  calls/duration (svc, dest, op, system). In `queries.ts`, provisioned in
  `provisionedSearches.ts` behind `metricsEmit`. Minute-aligned
  non-overlapping windows.
- **Readers** (`metricsPanels.ts`, all validated live): service summary,
  service buckets (time series), per-op summaries (Top Operations),
  dependency edges (RPC + messaging producer/consumer pairing).
- **Metrics-first at the source functions** (`search.ts`, current-window
  only): `listServiceSummaries`, `getServiceTimeSeries`,
  `listOperationSummaries`, `getDependencies` → try metrics, fall back to
  the live span query on miss. Serves every range.
- **`-1h` cache override** (`panelCache.ts`): `listCachedHomePanels` /
  `listCachedSysarchPanels` replace summaries/buckets/dependencies with
  metrics while keeping the non-migratable panels (slow traces, error
  classes, alerts) from `$vt_results`.
- Read builders in `metricNames.ts`; 325 unit tests + golden snapshots;
  provision guard + dry-run clean (6 emitters plan as `+create`).

**Not migrated (stay on `$vt_results`/live — not metric-shaped):** slow
traces, error spans/classes, error propagation, metric catalog, alerts.

### Backfill — implemented (on-provision, `npm run deploy`)

`src/api/metricsBackfill.ts` (+ `scripts/metricsBackfillDeps.ts`, wired in
`scripts/provision.ts`) populates history from raw spans so panels work
across all ranges immediately, not just from emitter-start forward.
Validated live (6 windows, 12 exports, **0 dropped**).

- **Count first** — `Q.backfillSpanCounts(300)` sizes the work.
- **Chunk** — `planBackfillWindows` packs bins into aligned,
  non-overlapping windows under a ~40k export cap.
- **Zero drops** — each export's `eventsDropped` is checked; a window that
  drops is split in half and retried down to a 1-minute floor (dense
  minutes that still drop are reported, not silently lost).
- **Non-overlap + idempotent** — covers `[now-horizon, floor(now)@m)`;
  forward emit takes over at the boundary. Re-runs are skipped via a
  coverage probe (`probeMetricCoverage` — is the horizon's far edge already
  covered?), so re-provision doesn't double-count.
- **Horizon** — `METRICS_BACKFILL_HORIZON_SEC` (default 24h). Ranges
  **beyond** the horizon still undercount until forward emit fills them or
  a deeper backfill runs — the one remaining bound. Changing the horizon
  upward between deploys can overlap already-covered data; clear metrics or
  keep it fixed.

### Before cutting the release — TODO

- **Backfill newest→oldest.** Today the runner walks windows oldest→newest,
  so recent ranges (the most-viewed) get metric data *last*. Reverse it —
  process from `floor(now)@m` back to the horizon — so recent ranges become
  usable immediately and history fills in behind. Likely also swap the loop
  nesting to window-outer / emitter-inner so each recent window gets all 6
  metrics before moving further back.
  **Implication:** the current idempotency probe checks the *far* edge
  (horizon start). With reverse order, an interrupted run leaves the far
  edge uncovered, so a re-run would re-probe it as "not covered" and
  re-emit the already-done recent windows → **double-count**. Reversing the
  order therefore requires changing the guard too — e.g. a KV marker
  recording the covered range (not a single far-edge probe), or probe the
  most-recent-not-yet-forward-covered window.

## Open items

1. **Counter semantics — RESOLVED.** Delta storage: read with
   `sum_over_time`, never `rate()`/`increase()`. Baked into
   `metricNames.ts` + the emitter docs.
2. **Idempotency — RESOLVED.** The store double-counts a re-emitted bin
   (verified: 2×). Emitters use minute-aligned, cadence-matched,
   non-overlapping windows (`earliest=-<cadence>@m`, `latest=@m`). Still
   watch for scheduler re-runs/retries re-emitting a window.
3. **Histogram volume.** Per-span emit hits the ~50k input-row cap on busy
   windows (biases the histogram). Fine at 1–2m cadence; add sampling if
   `eventsDropped` shows up at 5–10m. Monitor the export output table.
4. **Error-count parity.** The counter's `outcome="error"` is raw
   `status.code==2`; the panels' `errors` exclude propagation/user-fault
   via the filter rules. Expect a gap; reconcile during M4 side-by-side.
5. **Label cardinality** for the P4 `operation` label — top-N + `other`.
6. **Cost accounting** — confirm ingest/storage pricing nets out positive.
3. Incremental-window idempotency — do overlapping `-5m` runs double-count,
   or are points keyed by (name, labels, timestamp)?
4. Label cardinality ceiling for `service × operation` (P4) — top-N +
   `other` cap if needed.
5. Cost accounting — confirm metric ingest/storage pricing doesn't erase
   the compute + concurrency saving.
