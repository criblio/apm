# 2026-07-23 — Moving `$vt_results` panel caches to the new Cribl metrics store

**Status:** research + plan only. No code, no provisioning changes.

## The prompt

Cribl Search shipped a **metrics store** — counter, gauge, and histogram
metric types, queried via **PromQL**. A saved search can now land its
output as metrics instead of results:

```kusto
dataset="my_logs"
| where status >= 500
| summarize value=count() by bin(_time, 1m), service, status
| extend name="http_errors_total", type="counter"
| export to metrics
    timeField=_time
    nameField=name
    valueField=value
    typeField=type
    labelFields=[service, status]
```

Question: which of our current saved searches that land in `$vt_results`
could be **metrics** instead, for more speed and lower cost? Histograms
give percentile aggregations; gauges are the simplest.

## What "become a metric" actually requires

A search can emit metrics when its output is **numeric aggregate values
over time, keyed by low/medium-cardinality labels**. It cannot when its
output is **raw rows whose identity matters** (a specific trace, a
specific error message, a span/trace id used as a join key) or **string
metadata** (a catalog of names, an alert-state snapshot with a status
string).

Mapping to the three metric types:

| Type | Fits our data | Re-aggregatable across time? |
|------|---------------|------------------------------|
| **counter** | `requests=count()`, `errors=countif(...)` | Yes — `sum`/`rate` over any range is correct |
| **gauge** | a value sampled at a point (`error_rate`, a pre-computed `p95` for one bin) | Only at the emitted granularity — averaging gauges across bins is lossy but often acceptable |
| **histogram** | latency distribution → `histogram_quantile()` for true p50/p95/p99 at any range | Yes — this is the whole point of histograms |

**The percentile catch (most important finding).** Every RED search we
have computes `percentile(dur_us, 95)` from raw span durations *at query
time*. If we emit that pre-computed p95 as a **gauge**, we get "p95 of
this 1-minute bin" — and there is no correct way to roll several of those
bins up into an hour or a day. Averaging p95s is statistically wrong (it's
already burned us once — see the cumulative-histogram note in `CLAUDE.md`).
To keep percentiles honest across arbitrary ranges we must emit a real
**histogram** (bucketed duration counts) and read it back with PromQL
`histogram_quantile()`. Counters (request/error counts) have no such
problem — they re-aggregate cleanly.

So the conversion splits every RED search into two independent metric
emissions: **counts as counters (easy, exact)** and **latency as a
histogram (higher value, needs the bucket representation to exist)**.

## Inventory: every search that writes `$vt_results`

Source of truth is `src/api/provisionedSearches.ts` + the builders in
`src/api/queries.ts`.

| Search (id) | Builder | Output shape | Metric verdict |
|---|---|---|---|
| `home_service_time_series` | `serviceTimeSeries(60)` | per-**svc × 1m bin**: requests, errors, p50/p95/p99_us | ★ **Best candidate.** Already a time series. Counts→counters, latency→histogram. |
| `home_service_summary` | `serviceSummary()` | per-svc (current window): requests, errors, p50/p95/p99, error_rate | ✅ **Yes**, but redundant — derivable from the time-series metric via PromQL over the window. |
| `svc_operations` | `allServiceOperations()` | per-(svc, **operation**): requests, errors, percentiles | ✅ **Yes**, with `operation` as a label. Watch cardinality (svc×op). |
| `sysarch_dependencies` | `dependencies()` | per-**edge** (parent_svc→child_svc): callCount, errorCount, p95 | ✅ **Yes.** Labels = parent, child. Moderate cardinality. |
| `sysarch_messaging_deps` | `messagingDependencies()` | per-(svc, dest, op, system): spans, errors, p95 | ✅ **Yes.** 4 labels — check dest cardinality. |
| `noise_budget` | `noiseBudgetByService()` | per-(svc, day): alert fire counts | ⚠️ **Possible but low value.** Daily cadence, tiny data, reads alert events not spans. Leave. |
| `home_slow_traces` | `rawSlowestTraces(500)` | **raw trace rows** (trace_id, root_svc/op, duration), top-N | ❌ **No.** Identity matters — panel links to specific traces. |
| `home_error_spans` | `rawRecentErrorSpans(300)` | **raw error span rows** (msg, trace_id, status) | ❌ **No.** Drill-down rows; message strings and trace ids are the payload. |
| `error_propagation` | `errorPropagationRollup()` | per-(trace_id, span) error-child counts | ❌ **No.** Keyed by span/trace ids (unbounded cardinality); it's a join cache. |
| `metric_catalog` | `listMetricNames()` | catalog of metric **names** (strings) + counts | ❌ **No.** String metadata; and it already reads the metrics store. |
| `home_alerts` | `alertEvaluator()` | alert-state snapshot **events** (status strings, debounce state) | ❌ **No.** Stateful event records, already immutable-event-sourced. |

**Lookup-exporting searches** (not `$vt_results`, but relevant because
metrics would obsolete them):

| Search | Output | Relationship to metrics |
|---|---|---|
| `op_baselines` | rolling 24h per-op p50/p95/p99 → lookup | **Derivable** from the op-level latency histogram via PromQL over -24h. Could delete the whole scheduled search. |
| `error_rate_history` | 6-day per-svc error-rate, pivoted d1..d6 → lookup | **Derivable** from the request/error counters via PromQL `rate` over daily steps. This search exists *only* because `$vt_results` can't hold history — metrics remove the reason it exists (and the ugly pivot workaround). |
| `home_alerts_prev` | previous-hour summary → lookup | Derivable from counters (compare -2h..-1h vs -1h..now). |
| `trace_originators`, `attr_catalog` | classification / attribute-name lookups | ❌ Not metric-shaped (string classifications / key discovery). Keep. |

> **Update (same day) — after reading the framework metrics client and
> the sibling `ubiquiti` app.** The analysis below understated the win.
> The metrics *read* path is the headline, not the write side. See the
> "Metrics query path" section further down; it revises the cost story
> and collapses most of the read-side effort I'd estimated. The
> inventory verdicts above stand; the emphasis and plan change.

## Where the speed and cost actually come from

This is subtle, because the panel reads are *already* cheap — they read
precomputed `$vt_results`, not raw spans. The wins are elsewhere:

1. **Overlap elimination (write-side compute).** Today each panel search
   re-scans a rolling **1h** window every **5 min** — every span is
   scanned ~12×. A metric emitter only needs to scan the **incremental**
   window since the last run (~5 min) and append immutable data points the
   store accumulates. That's the largest raw-compute saving, and it's real
   worker time on a small pool.

2. **Free history / retention.** `$vt_results` is kept `keepLastN: 2` — we
   can only ever read the *latest* 1h window. Any historical chart today
   requires a *separate heavy search* (that's literally why
   `error_rate_history` and `op_baselines` exist, with their daily
   cadence and pivot hacks). Metrics persist → 7d/30d RED charts for free,
   and **several scheduled searches collapse into zero**.

3. **Arbitrary time range without fallback.** The `$vt_results` cache only
   serves the default 1h window; non-default ranges (6h/24h/15m) fall back
   to a live full-span scan today (documented graceful miss). PromQL over
   metrics serves any range fast — the expensive fallback path disappears.

4. **Cheaper storage.** Columnar metric points vs. retained result-set
   rows; long retention at a fraction of the cost.

Net: the span scan doesn't vanish (something must still read spans to
*produce* the metrics), but it shrinks (incremental window), stops being
duplicated 12×, and buys history + any-range reads that currently cost us
extra searches and fallback scans.

## Metrics query path — the real win (revises the section above)

The framework ships a metrics query client
(`cribl-search-app-framework/packages/app-utils/src/metrics.ts`, imported
as `@cribl/app-utils/metrics`) and the sibling `ubiquiti` app is built
entirely on it. Reading their code changes the cost story:

**Metrics queries do not spawn a search subprocess.** They are a
*synchronous* `GET /m/default_search/search/query?searchJobSource=metrics&datasetId=<ds>&query=<PromQL>`
that streams NDJSON back immediately (job ids are `mq-…`, a different
class from async search jobs). Contrast the current panel read —
`dataset="$vt_results" | where jobName in (...)` — which **is** a regular
KQL search job: every Home / SysArch / Service Detail page load spawns a
worker-pool job just to *read the cache*. Those reads are a real slice of
the concurrency pressure that has been saturating the small staging
worker pool (the same pool the scenario-test guidance in `CLAUDE.md` warns
about running serially).

So the biggest lever isn't write-side compute — it's that **migrating the
reads takes them off the search worker pool entirely.** The UI also gets
markedly more responsive (ubiquiti's dashboards confirm this) because the
metrics GET returns in ~ms with no job lifecycle.

**The client already exists — the read-side rewrite is cheap, not the
bulk of the work as I first wrote.** The framework provides:
`queryRange`, `queryInstant`, `runMetricsQuery`, plus discovery
(`listMetricMetadata` = `.metadata`, `listLabels` = `.labels`,
`listSeries` = `.series`, `listSearchDatasets`), and `MetricSeries` /
`MetricSample` types. Ubiquiti's `src/hooks/useMetricsQuery.ts`
(`useRangeQuery` / `useInstantQuery` / `useScalarQuery`, with the
non-destructive-refresh pattern already baked in) is copy-pasteable. Our
job is to point panels at these behind `panelCache.ts` — not to build a
metrics client.

**Dataset resolves cleanly.** Ubiquiti verified that metrics queries with
`datasetId=main` and `datasetId=metrics` return identical results —
"lakehouse datasets on the same engine share one metrics store." Our OTel
lakehouse dataset should therefore be queryable through the metrics API
(needs a direct probe against our `generic_metrics` records, but the
signal is strong). Import gotcha: use subpath imports
(`@cribl/app-utils/metrics`), never the root barrel — the barrel pulls
`node:fs` via the provisioner and breaks in browser code.

**PromQL surface — verified live against our staging store
(2026-07-23).** I probed the metrics API directly with an OAuth
client-credentials token (script:
the probe script (appendix below), reuses the flow from
`tests/helpers/criblSearch.ts`). Results:

- **`histogram_quantile` WORKS** — my earlier claim that it wasn't
  supported was **wrong** (ubiquiti simply never uses it because unpoller
  emits no histograms). Both
  `histogram_quantile(0.95, sum(rate(<hist>[5m])) by (le))` and
  `histogram_quantile(0.95, sum by (le) (<hist>))` returned rows,
  `status=completed`. **Read-time percentile aggregation over histograms
  is real** — exactly as you said.
- **Histogram metrics already exist in `otel`** — `.metadata` reports
  555 gauge, 343 counter, **24 `hist_default`** metrics (Go-runtime and
  Prometheus-internal histograms like `go_gc_pauses_seconds`,
  `prometheus_http_request_duration_seconds`). So the store *stores and
  serves* histograms today.
- **Confirmed working:** bare selectors, `{label=...}` matchers,
  `sum … by`, `rate()`, `avg_over_time()`, `topk()`, scalar arithmetic.
- **Confirmed failing** (job `status=failed`): `label_replace()` — matches
  ubiquiti's note. So the probe is discriminating, not rubber-stamping.
- `datasetId` = `otel` / `metrics` / `main` return identical metadata —
  one shared metrics store, as ubiquiti found.

**What this does to the latency plan:** the read side is no longer the
constraint. If `export to metrics` can emit a real bucketed histogram
(write-side, still unproven — see below), then **latency p50/p95/p99 come
straight from `histogram_quantile` server-side at any range** — no
per-bin gauge hack, no client-side quantile math. Counters
(request/error counts) are exact via `sum(rate(...))`. The migration
splits cleanly by *emission difficulty*, not read capability: counts are
a trivial counter emit; latency needs the histogram emit to work.

**Write side is the only real unknown now.** The public `export` operator
docs (docs.cribl.io/search/export) list only `to lake` / `to search` /
`to lookup` — `export to metrics` isn't documented yet (consistent with
"just shipped"). There *is* a KQL `histogram(expr, buckets:number[])`
aggregation that emits a bucketed object (keys = buckets incl. `Infinity`,
values = counts) — the plausible mechanism for feeding a histogram-typed
`export to metrics`. Whether `typeField="histogram"` + that bucket object
produces an `le`-queryable `hist_default` series is the one thing Phase 0
must confirm by actually emitting (kept out of scope here — plan only).

**One caveat ubiquiti does *not* answer:** its metrics come from
`unpoller` (an external Prometheus exporter) landing natively in the
`metrics` store — it never uses `export to metrics` from a saved search.
So it validates the *read* path completely but tells us nothing about
whether a Cribl saved search can `export to metrics` from spans, and
especially whether it can emit histogram buckets. **That write-side
question is the #1 thing Phase 0 must prove.**

## Proposed plan (phased, each phase shippable)

Ordering principle (revised): the concurrency/responsiveness win lives in
the **read path**, and the read client already exists, so the fastest
route to value is *counts as counters, read via the metrics API*. Latency
percentiles come after we pick option (a) vs (b).

**Phase 0 — prove the write path (must do first, ~half a day).** The read
path is proven (ubiquiti + the 2026-07-23 live probe, incl.
`histogram_quantile`); the only unknown is *emission*.
- Confirm `export to metrics` works from a scheduled search against our
  OTel lakehouse dataset, and that the resulting series are queryable via
  `GET …?searchJobSource=metrics&datasetId=otel` (re-run
  the probe script (appendix below) filtered to a `criblapm_test_*` prefix).
- **The pivotal test:** can `export to metrics` with
  `typeField="histogram"` (fed by the KQL `histogram(dur_us, [...])`
  bucket object) produce a `hist_default` series that
  `histogram_quantile(...)` reads back correctly? If yes, latency is a
  solved problem end-to-end. If no, fall back to pre-computed percentile
  gauges (lossy across ranges) for latency only — counts are unaffected.
- Check incremental-window idempotency: emitting on `-5m`/1m bins each run
  — are points deduped by (name, labels, timestamp) or do overlapping
  runs double-count?
- Sanity-check label cardinality headroom (svc × operation).

**Phase 1 — emit + read the counter metrics (the high-value, low-risk
slice).**
- Emit two counters from spans, incrementally: `criblapm.request.count`
  and `criblapm.error.count`, labels `service`, `operation`. Additive —
  runs alongside the existing `$vt_results` caches.
- Stand up the read hooks by lifting ubiquiti's `useMetricsQuery.ts`
  (`useRangeQuery`/`useInstantQuery`/`useScalarQuery`) and wiring
  `@cribl/app-utils/metrics` behind `panelCache.ts`.
- Re-point the **request/error** portions of `home_service_time_series`
  and `home_service_summary` to `sum(rate(...)) by (service)` /
  `sum(...) by (service)`. Latency still comes from `$vt_results` for now
  (mixed read is fine during transition).
- Validate a week of side-by-side agreement (metric-derived vs cache).
  **Win banked here:** those panel reads leave the worker pool.

**Phase 2 — latency percentiles.** If Phase 0 proves histogram emission
(expected path): emit `criblapm.request.duration` as a histogram and read
p50/p95/p99 via `histogram_quantile(...)` — server-side, any range, no
client math. Otherwise fall back to pre-computed percentile gauges for
latency only. Either way, move the latency portion of the two panels onto
metrics, then delete the `home_service_time_series` and
`home_service_summary` scheduled searches. Kills the non-default-range
live-span fallback for these panels too.

**Phase 3 — collapse the history/baseline searches.** With counters in
the store, `error_rate_history` (and its d1..d6 pivot workaround) and
`home_alerts_prev` become PromQL `rate` derivations; `op_baselines`
follows once latency metrics exist. Delete the searches and their
lookups — the largest cost + complexity reduction, since these searches
exist *only* to fake the history `$vt_results` can't retain.

**Phase 4 — dependency + messaging edges, and `svc_operations`
(optional).** Emit edge / per-operation metrics and re-point the System
Architecture + Service Detail Top-Operations panels. Lower priority and
higher cardinality; do last.

**Never migrate:** `home_slow_traces`, `home_error_spans`,
`error_propagation`, `metric_catalog`, `home_alerts`. Raw rows and state,
not metrics.

## Open questions

*Resolved by reading the framework + ubiquiti:*
- ~~PromQL reachable from the sandboxed iframe / auth carry-through~~ —
  yes; framework `metrics.ts` fetches through the same proxy as Search.
- ~~Which dataset~~ — lakehouse datasets share one metrics store;
  `datasetId=<our ds>` should work (confirm with a probe in Phase 0).
- ~~Does the read spawn a search job~~ — no; synchronous `mq-` query.
- ~~`histogram_quantile` server-side~~ — **supported** (verified live
  2026-07-23); histogram metrics exist and read-time percentiles work.

*Still open — all Phase 0 write-side:*
1. **Can `export to metrics` emit a histogram-typed series** (via the KQL
   `histogram(expr, buckets)` bucket object + `typeField="histogram"`)
   that `histogram_quantile` reads back? The read side is ready; this is
   purely about emission. Fallback if not: percentile gauges for latency.
2. **Incremental-window idempotency** — do overlapping `-5m` runs
   double-count, or are points keyed by (name, labels, timestamp)?
3. **Label cardinality ceiling** — svc×operation series count; need a
   top-N + `other` cap?
4. **Cost accounting** — confirm metric ingest/storage pricing doesn't
   erase the compute + concurrency saving.

## Risk notes

- **Correctness regression on latency** is the top risk — mishandled it
  silently produces plausible-but-wrong p95s. Gate Phase 2 on a week of
  side-by-side agreement between the metric-derived and `$vt_results`
  values.
- **Read-path rewrite** touches every panel that migrates; do it behind
  `panelCache.ts` so UI components are untouched.
- **Reversibility:** Phases 1 is purely additive; Phases 2–4 delete
  searches only after their PromQL replacement is validated live on
  staging. Every phase is independently shippable and revertible.

## Appendix — live probe results + script (2026-07-23)

Probe output (staging, dataset `otel`, `-1h`):

```
datasetId=otel: status=completed rows=922 types={"gauge":555,"counter":343,"hist_default":24}
   histogram metrics incl.: go_gc_pauses_seconds, go_sched_latencies_seconds,
   prometheus_http_request_duration_seconds, prometheus_rule_group_duration_histogram_seconds, ...
datasetId=metrics / main: identical (one shared metrics store)

read-time aggregation probes (datasetId=otel):
✓ histogram_quantile(0.95, sum(rate(<hist>[5m])) by (le))   -> completed, 61 rows
✓ histogram_quantile(0.95, sum by (le) (<hist>))            -> completed, 61 rows
✓ sum(<m>) by (__name__) | rate(<m>[5m]) | avg_over_time | topk(3, <m>)  -> completed
✗ label_replace(<m>, ...)                                   -> failed  (unsupported)
```

Takeaway: histogram metric type + `histogram_quantile` read-time
aggregation are supported today. The remaining unknown is whether our own
`export to metrics` can *emit* a histogram-typed series (Phase 0).

Run it: `node --env-file=.env <path>/metrics-probe.mjs` (needs
`CRIBL_BASE_URL` / `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` in `.env`).

```js
// Probe the Cribl Search built-in metrics query API:
//  1. do histogram-typed metrics exist in our otel store?
//  2. which PromQL read-time aggregations work vs. error (esp. histogram_quantile)?
const BASE = process.env.CRIBL_BASE_URL.replace(/\/$/, '');
const isStaging = /cribl-staging\.cloud/.test(BASE);
const tokenUrl = isStaging
  ? 'https://login.cribl-staging.cloud/oauth/token'
  : 'https://login.cribl.cloud/oauth/token';
const audience = isStaging ? 'https://api.cribl-staging.cloud' : 'https://api.cribl.cloud';

async function getToken() {
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.CRIBL_CLIENT_ID,
      client_secret: process.env.CRIBL_CLIENT_SECRET,
      audience,
    }),
  });
  if (!resp.ok) throw new Error(`token ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).access_token;
}
const TOKEN = await getToken();

async function mq(query, { dataset = 'otel', step, earliest = '-1h', latest = 'now' } = {}) {
  const params = new URLSearchParams({ query, earliest, latest, searchJobSource: 'metrics', datasetId: dataset });
  if (step !== undefined) params.set('step', String(step));
  const resp = await fetch(`${BASE}/api/v1/m/default_search/search/query?${params}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const text = await resp.text();
  const lines = text.split('\n').filter((l) => l.trim());
  let summary = null;
  try { summary = JSON.parse(lines[0]); } catch {}
  const rows = [];
  for (let i = 1; i < lines.length; i++) { try { rows.push(JSON.parse(lines[i])); } catch {} }
  return { httpOk: resp.ok, httpStatus: resp.status, summary, rows, raw: text };
}
const jobStatus = (r) => r.summary?.job?.status ?? (r.httpOk ? '(no summary)' : `HTTP ${r.httpStatus}`);

// 1. metadata: what metric types exist?
for (const ds of ['otel', 'metrics', 'main']) {
  const r = await mq('.metadata', { dataset: ds });
  const byType = {};
  for (const row of r.rows) if (row._kind === 'metadata') { const t = String(row._type ?? '?'); byType[t] = (byType[t] ?? 0) + 1; }
  console.log(`datasetId=${ds}: status=${jobStatus(r)} types=${JSON.stringify(byType)}`);
}
const meta = await mq('.metadata', { dataset: 'otel' });
const metaRows = meta.rows.filter((x) => x._kind === 'metadata');
const H = metaRows.find((x) => /hist/i.test(String(x._type ?? '')))?.__name__;
const M = metaRows[0]?.__name__;

// 2. read-time aggregation probes
const probes = [];
if (H) {
  probes.push(['histogram_quantile p95 (rate le)', `histogram_quantile(0.95, sum(rate(${H}[5m])) by (le))`, { step: 60 }]);
  probes.push(['histogram_quantile p95 (bare, by le)', `histogram_quantile(0.95, sum by (le) (${H}))`, { step: 60 }]);
}
if (M) {
  probes.push(['sum by', `sum(${M}) by (__name__)`, {}]);
  probes.push(['rate', `rate(${M}[5m])`, { step: 60 }]);
  probes.push(['topk', `topk(3, ${M})`, {}]);
  probes.push(['label_replace (expect FAIL)', `label_replace(${M}, "x", "$1", "__name__", "(.*)")`, {}]);
}
for (const [label, q, opts] of probes) {
  const r = await mq(q, { dataset: 'otel', ...opts });
  const status = jobStatus(r);
  const ok = status === 'completed' && r.httpOk;
  console.log(`${ok ? '✓' : '✗'} ${label} -> ${status} | ${ok ? `rows=${r.rows.length}` : r.raw.slice(0, 200).replace(/\s+/g, ' ')}`);
}
```

## Phase 0 write-path validation — BLOCKED (2026-07-23, live on staging)

Attempted the first implementation step: prove a saved search can
`export to metrics` and be read back via the fast PromQL engine. It does
**not** work with any syntax I could find, and the investigation surfaced
a load-bearing architectural fact the plan had assumed away.

**There are two separate metric stores, and OTel telemetry is in the
slow one.**

| Store | Dataset(s) | How written | How read | Contents (staging) |
|---|---|---|---|---|
| **Fast PromQL store** | `metrics` (type `cribl_search`, `eventStorageSchemaVersion`) | Prometheus scraper / remote-write (`cribl_edge_prometheus_scraper`, `grafana_prom`) | synchronous `searchJobSource=metrics` GET — **no search job** | **922** host/infra metrics only: `apt go net node nvme process prometheus promhttp pve scrape smartmon unpoller up` |
| **Lakehouse events** | `otel` (type `cribl_search`) | OTel collector → lake | KQL search job (`$vt_results`-style, slow) | **15.9M** `generic_metrics` events: `system.cpu.time`, `traces.span.metrics.{calls,duration}`, `postgresql.*`, `k8s.*`, `otelcol_*` |

Verified the two are disjoint: querying real OTel metric names
(`traces.span.metrics.calls`, `otelcol_processor_incoming_items`,
`system.cpu.utilization`, …) through the PromQL engine returns **0 rows**;
they exist only as `generic_metrics` events (fields `_metric`, `_value`,
`_metric_type`, `_metric_dims`) read via KQL. The PromQL engine returns
the same 922 host metrics regardless of `datasetId` (`otel`/`metrics`/
`main`) — it appears bound to the built-in `metrics` store, not the
lakehouse dataset.

**`export to metrics` did not land data anywhere queryable.** Tested from
ad-hoc jobs (OAuth client-creds token, `criblapm_test_*` prefix):
- The user's example param set (`timeField/nameField/valueField/typeField/
  labelFields`) — job `status=completed`, but **nothing** appears in the
  PromQL store (`.metadata` unchanged at 922) nor as `generic_metrics` in
  `otel`/`metrics`/`default_metrics`/`cribl_metrics`.
- `metricFields=…` / `dimensions=…` variants → `KustoError` ("unknown
  parameter for export operator: metricFields" / "does not accept a field
  list"). So the operator parses params but rejects these; the real
  grammar is undocumented (public `export` docs cover only
  `to lake`/`to search`/`to lookup`).
- The Cribl blog "Transform Logs into Metrics" shows the Search pattern as
  `| send` (with `_destination`, `_time`) routing **through Cribl Stream
  to an external destination** (Grafana/Prometheus) — i.e. Search's
  logs→metrics story publishes *out*, it doesn't populate an internal
  queryable store.

**Implication for the project.** The concurrency/speed win requires our
span-derived RED aggregates to physically live in the fast `metrics`
store. On this workspace I cannot get a saved search to put them there.
Either (a) there is a correct but undocumented `export to metrics` target/
syntax (or a version/feature gate) I haven't found, or (b) the fast store
is ingestion-fed only (scraper / remote-write) and span→metric conversion
must happen at the **pipeline/ingest layer** (the `otel-demo-criblcloud`
Stream/Edge config), not from the app. This is a genuine fork that only
platform knowledge can resolve — see the decision at the end.

Evidence scripts (session scratchpad): `write-probe.mjs`, `diag.mjs`…
`diag5.mjs`. Read path remains fully proven; only the *write* path is
blocked.

### Resolution (user, 2026-07-23)

Clint confirmed: **`export to metrics` does generate PromQL-queryable
metrics and the syntax I was given is correct.** The reason nothing landed
is that **exporting metrics from OTel input is not yet supported — it's
coming in a future release.** Follow-up testing showed the export also
no-ops from a supported input (`cribl_search_sample`) on this staging
workspace, so the whole `export to metrics → internal store` path reads as
**dormant on staging today**; treat the syntax as correct-for-ship, not
validatable here yet.

**Net posture:** the read path (fast PromQL query, `histogram_quantile`,
host metrics) is real and testable now; the write path (span→metrics
emit) is a forthcoming-platform dependency. Implementation therefore
splits into: (1) foundation + migration/upgrade design we can land now,
and (2) emitters + panel re-pointing that go live when the feature ships.
See `docs/metrics-migration-plan.md`.

## Phase 0 write-path — VALIDATED (2026-07-23, supersedes "BLOCKED" above)

The earlier "blocked / dormant future-release" conclusion was **wrong** —
it was two syntax bugs of mine. With Clint's corrections, `export to
metrics` works end-to-end from OTel spans: **counter, gauge, AND
histogram all land with zero drops and read back via the fast PromQL
engine.**

**Bug 1 — time field.** After `summarize … by bin(_time, 1m)` the time
column is named `bin_time_1m`, not `_time`. `timeField=_time` pointed at a
missing field, so the export silently produced 0 usable points (the metric
name registered but had no samples). Fix: `| project-rename _time=bin_time_1m`
(or use `timestats span=… value=…`, which emits `_time` already-named).

**Bug 2 — histogram type.** `typeField=type` validates only `counter`/
`gauge`; a field value of `"histogram"` (or `hist_default`/`timer`/
`distribution`/`summary`) drops 100% of events as `invalid_type`. The
histogram type must be passed as the **literal parameter `type=histogram`**,
not via `typeField`.

**Always read the export output table** (`tee=true`, or the job's result
rows): it reports `eventsOut / eventsDropped / dropReasons`. That table is
what surfaced `dropReasons: {invalid_type: 50000}` — the drop was invisible
from job status alone (status = `completed`).

### Confirmed recipes (live, 0 dropped)

Counter (per-bin request count):
```kusto
dataset="otel" | where isnotnull(end_time_unix_nano)
| extend svc=tostring(resource.attributes['service.name'])
| where isnotempty(svc)
| summarize value=count() by bin(_time, 1m), svc
| project-rename _time=bin_time_1m
| extend name="criblapm_request_total"
| export to metrics type=counter timeField=_time nameField=name valueField=value labelFields=[svc]
```
Read: `sum(rate(criblapm_request_total[5m])) by (svc)`.

Histogram (latency) — feed **raw per-span values** (many rows share the
1-minute `_time`, `name`, labels); the store buckets them into a
`hist_default`:
```kusto
dataset="otel" | where isnotnull(end_time_unix_nano)
| extend svc=tostring(resource.attributes['service.name']),
         dur_ms=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000000.0,
         _time=bin(_time, 1m)
| where isnotempty(svc) and dur_ms >= 0
| project _time, svc, dur_ms
| extend name="criblapm_request_duration_ms"
| export to metrics type=histogram timeField=_time nameField=name valueField=dur_ms labelFields=[svc]
```
Read: `histogram_quantile(0.95, sum(rate(criblapm_request_duration_ms[5m])) by (le, svc))`
→ verified real per-service p95 (frontend-proxy ≈ 2590 ms, quote ≈ 0.38 ms).
Note: a histogram metric is **not** queryable as a bare selector — always
via `histogram_quantile`.

### Remaining semantics item (not a blocker)

Counter emit is a per-bin `count()` (a delta), exported as `type=counter`.
`rate()` readback gave plausible per-second numbers, but confirm the store
treats repeated counter samples as cumulative vs delta (sets `rate` vs
`sum_over_time`) before trusting production dashboards. Also decide raw
per-span histogram emit vs. sampling for volume (per-span hits the 50k row
cap on busy windows; the store aggregates, but the *input* scan is capped).

**Net:** the migration is unblocked. `docs/metrics-migration-plan.md`
Phase-0 gate is met; emitters can be authored for real.

## Counter semantics + type-API asymmetry (2026-07-23, validated)

**`export to metrics` type API is asymmetric** (verified by error messages):
- **Histogram** → literal param `type=histogram` (the ONLY value the literal
  `type=` param accepts: "expected export parameter type to be one of:
  histogram").
- **Counter / gauge** → `typeField=<field>` where the field holds
  `"counter"`/`"gauge"`. (Passing `"histogram"` via `typeField` drops 100%
  as `invalid_type`.)

**Counter storage is DELTA, not cumulative.** Emitting per-bin `count()` as
`type=counter`, the store keeps the emitted values verbatim — read-back of
raw samples matched ground-truth per-bin counts (non-monotonic), and
`sum_over_time(m[20m])` ≈ the ground-truth total. `rate()` / `increase()`
returned nonsense (they assume a cumulative monotonic counter). Therefore:

- **Total:** `sum(sum_over_time(criblapm_requests_total[<range>])) by (svc)`
- **Per-second rate:** that `/ <range_seconds>`
- **Error rate:** `…{outcome="error"} / …` (emit one counter labeled by
  `outcome` ∈ {ok,error} rather than two metrics)
- **Do NOT use `rate()`/`increase()`** on these delta counters.

Latency stays on the histogram: `histogram_quantile(0.95,
sum(rate(criblapm_request_duration_ms[5m])) by (le, svc))` (rate() IS
correct inside histogram_quantile — that's the standard idiom and the
store handles the bucket series accordingly).

## Interactivity / perf pass (2026-07-24, 0.13.0 → 0.13.1)

After the migration deployed, interactive rendering was "faster, not
dramatic." Investigation (drive the live app, log every search call)
found the real bottlenecks and one deploy-process trap:

1. **`histogram_quantile` is ~700-800ms EACH on this engine** (counters
   are ~114ms). The catalog fired 3 quantiles (p50/p95/p99) × 3 panels,
   stacked under browser concurrency → 5-10s. `le` buckets are not
   queryable, so client-side quantiles are impossible.
2. **Pages blocked on the slow `$vt_results` batch** and the metrics
   override ran *after* it (additive latency).
3. **Deploys silently no-op'd**: Cribl skips same-version installs
   ("Deployment passed (already installed)"), so the interactivity /
   query-reduction / counts-first builds — all `0.13.0` — never reached
   the app. Every measurement was the *first* 0.13.0. **Bump the version
   every deploy.**

Fixes (all in 0.13.1):
- **Non-blocking render**: each panel renders when its own data lands;
  the metrics-backed RED panels are never gated by the slow
  `$vt_results` panels (alerts / slow traces / error classes), which load
  non-blocking. Removed the bundled metrics-override in `panelCache`.
- **Combined counter query**: requests + errors in one query via the
  `outcome` label (2 reads → 1).
- **Counts-first catalog**: the service table renders from the ~114ms
  counter read; p50/p95/p99 enrich asynchronously from the histogram
  reads so the slow percentiles never block the table
  (`readServiceCounts` + `readServiceLatencies`, `listServiceCounts` +
  `listServiceLatencies`).
- **Resilient reads**: a slow/failed sub-query no longer collapses the
  whole read to a ~10s live span-scan fallback (only a failed *counter*
  falls back).
- Catalog sparklines drop p50/p99 (keep p95); Service Detail keeps full
  quantiles. Services page: **22 metrics queries → 9**, and the slow
  queries left the critical (marker) path.

### Before / after (content-after-nav, excludes ~5-7s iframe boot)

| Page | 0.12.1 | 0.13.1 |
|---|---|---|
| Home | 2.0s | ~0.0s |
| **Services** | **7.2s** | **~0.9s** (8×) |
| Service Detail | 0.9s | ~1.0s |
| System Arch | 0.5s | ~0.3s |
| Errors | 5.5s | ~5s (raw error spans — not metric-shaped) |

Numbers are contention-noisy (staging was hammered by an all-night deploy/
benchmark loop); the isolated combined-counter read is **114ms**, which is
the real floor the catalog now waits on. Baselines saved under
`docs/sessions/perf/`. **Errors** stays slow because its error-span table
is raw drill-down rows, not a metric — reducing it is separate (M5-adjacent).

---

## Regression: nav-cancellation → live-KQL cascade (fixed in 0.13.5)

0.13.4 added `newQueryGeneration()` on every page fetch to cancel the
prior page's in-flight reads. On the Services page this made SPA nav
**worse and escalating** — nav #1 1.5s, #2 12s, #3 14s, #4 22s.

**Root cause.** When `newQueryGeneration()` aborted an in-flight metrics
read, the reader's `catch` returned `null`, which the source function
(`listServiceCounts`, `getDependencies`, …) treated as "metrics miss" and
**fell back to a live KQL span scan** — an uncancellable search job. Each
nav aborted ~20 metrics reads → spawned ~20 live span scans → they
accumulated across navs → escalation.

**Fixes (0.13.5):**

1. **No fallback-on-abort.** When metrics-read is ON (`getMetricsRead()`),
   a null/aborted metrics result returns `[]` instead of cascading to a
   live span scan. Live KQL is kept ONLY as the genuine metrics-OFF
   fallback. Applied to all six metrics-first source functions
   (`listServiceSummaries`, `listServiceCounts`, `getServiceTimeSeries`,
   `getDependencies`, `listOperationSummaries`, `listOperationAnomalies`).

2. **KQL jobs now actually cancel on nav.** The framework's
   `runSearchJob` already supported a `signal` (poll-loop abort + DELETE
   to free the worker slot), but the app's `runQuery` wrapper never
   passed one. Rewrote `src/api/cribl.ts` to inject the navigation
   generation signal — so KQL search jobs abort their poll loop, release
   the worker-pool slot, and drop their browser connection on nav. The
   cancellation DELETE deliberately runs *without* the signal so it
   survives the abort that triggered it.

3. **Stale-write guard.** Each page's fetch captures
   `captureQueryGeneration()` and guards every async `setState` with it,
   so an aborted read that resolves late (now to `[]`) can't blank a
   panel belonging to the newer navigation. (SystemArch already had an
   equivalent per-fetch `cancelled` flag via effect cleanup.)

4. **Feature-detect opt-out.** `flatFieldsAvailable()` is session-scoped
   and idempotent; its probe now uses a never-abort signal so a nav can't
   cancel it and cache a poisoned `false` (which would force every
   live-KQL fallback onto the slow dotted path for the session).

---

## The real escalation cause: server-side metrics backlog (fixed in 0.13.6)

The 0.13.5 anti-cascade fix removed the live-KQL fallback, but a
dedicated **SPA-nav escalation harness** (`tests/nav-escalation.spec.ts`
— boots once, drives the in-app sidebar through repeat Services visits in
ONE JS context) showed Services *still* climbing: **1069 → 2077 → 3112 →
4040 → 4564ms** across five visits, while Map/Overview stayed flat at
~200ms.

Instrumenting in-flight request depth was the key: **client-side pending
requests stayed flat at ~14** the entire run — nothing was accumulating in
the browser. The backlog was **server-side**. Metrics reads are pure GETs
against the PromQL engine; some are expensive (`histogram_quantile`, and
the 24h operation-level anomaly baseline). Aborting the fetch on nav
closes the client socket but **the engine keeps computing the query**. So
each rapid Services visit *re-fired* identical expensive queries, piling
abandoned-but-running computations onto the engine — later cheap reads
(the counts marker) queued behind that backlog.

Client cancellation was actively *hurting* here: it threw away a result
then recomputed it next visit.

**Fix (0.13.6): `src/api/metricsCache.ts`.** For idempotent metrics reads,
don't cancel — **dedupe + briefly cache** instead:
- **In-flight dedup**: a second request for an identical query (same
  PromQL + window + step + dataset) reuses the one in-flight promise.
- **Short TTL (12s)**: a repeat nav within the window reuses the recent
  result instead of recomputing. Metrics are minute-binned, so a few
  seconds of staleness is invisible; the page's own auto-refresh still
  sees fresh data.
- **Signal dropped**: reads run to completion so their result can be
  reused. Stale late-resolving reads are harmless — the page's
  `captureQueryGeneration()` guard drops them before they touch the UI.

KQL search jobs stay cancellable (they hold worker-pool slots worth
releasing); only the idempotent metrics GETs switched to
dedupe-and-cache.

### Result — escalation eliminated

Services SPA nav (in-context, repeat visits):

| Visit | 0.13.4/0.13.5 (climbing) | 0.13.6 (cached) |
|---|---|---|
| #1 | 1069ms | 248ms |
| #2 | 2077ms | 205ms |
| #3 | 3112ms | 202ms |
| #4 | 4040ms | 194ms |
| #5 | 4564ms | 184ms |

Flat ~200ms, no climb. Total API requests for the 9-step sweep dropped
from **249 → 121** (dedup+cache halved query volume). Every page is now
sub-250ms SPA nav. Guarded by `tests/nav-escalation.spec.ts`.

---

## Service Detail: real load (0.13.7–0.13.9)

The nav-escalation harness measured time-to-first-*heading*, which hid the
truth: Service Detail's heading appeared in ~200ms but the page took ~15s
to actually settle, and Spotlight was broken. A proper diagnostic (click
into a service, count KQL `POST /jobs`, measure settle as pending→0) found:

- **45 KQL search jobs on one load, ~12s to settle.**
- **Spotlight "completely broken"** — a child component whose effect runs
  BEFORE the parent's `fetchAll`, so its ~27 attribute span-scans bound to
  the nav generation signal and were aborted the instant `fetchAll` called
  `newQueryGeneration()`. The generation controller was too coarse: it
  killed sibling components' in-flight queries, not just the prior page's.
- **~20 of the 45 jobs** were the below-the-fold runtime/container metric
  cards firing one OTel-lakehouse (`generic_metrics`) probe per metric row.
  A live probe confirmed `process.runtime.*` / `k8s.container.*` are NOT in
  the fast PromQL store (0 events) — so these can't move to metrics; they
  must be lazy.

Fixes (0.13.7–0.13.9):
1. **SpotlightSection owns its abort scope** (per-effect `AbortController`
   threaded through `getSpotlightDiff → runQuery`), NOT the global nav
   generation — so the parent's fetch can't abort it. This fixed "broken."
2. **Spotlight is lazy** (IntersectionObserver, fetch on scroll-into-view)
   and uses a **curated 9-attr subset** (`SPOTLIGHT_ATTRIBUTES_SERVICE_DETAIL`)
   instead of the full ~27.
3. **Metric cards are lazy** — the observed container stays mounted as a
   sentinel; the `MetricsCard` components (and their per-row `delta` KQL
   probes) mount only once scrolled into view.
4. **Metrics-first ordering** — the page now `await`s the fast metric
   summary before firing the heavy KQL panels (status mix, error traces,
   instances, uptime), so they don't contend with first paint.

### Result

| metric | before | 0.13.9 |
|---|---|---|
| first content | ~200ms* | 176–262ms |
| **KQL jobs on initial load** | **~45** | **9** |
| **settle** | **~12–15s** | **~7.4s** |
| Spotlight | broken (aborted) | works; lazy; 9 curated attrs |
| metric cards | 20 eager lakehouse probes | 0 on load (lazy) |

*first content was always ~200ms — it was never the problem; the eager
below-fold fan-out was. Guarded by `tests/svcdetail-load-budget.spec.ts`
(first content <3s, initial KQL jobs <16).

---

## Every page: fast-first-paint + defer/lazy-load slow work (0.13.10)

Applied the Service Detail pattern to the whole app. Parallel code-audits
mapped each page's eager fetches; then per page: primary (metric-backed or
the page's core content) fires first, and heavy/below-the-fold KQL defers
behind it or lazy-loads on scroll.

- **SearchPage (Traces)** — the facet/Spotlight rail fired a ~24-job KQL
  fan-out on mount, racing the trace search. Now: gated behind the primary
  `findTraces` (`!loading`) AND scroll-into-view (IntersectionObserver on
  the rail), and curated to 9 attributes. **~24 → 1 KQL job on load.**
- **OverviewPage** — the one live-KQL job (`alertHistory`) moved to fire
  after the awaited primary metric counts instead of before.
- **AlertsPage** — the active-alerts table (primary) paints first; the
  alert-history job (timeline/incidents) is deferred behind it. Added
  `newQueryGeneration()` + `captureQueryGeneration()` (nav-cancel + stale
  guard) — this page previously had neither. **2 → 1 job on load.**
- **LogsPage** — the service-filter dropdown catalog (`listLogServices`)
  is deferred until after the primary log results load once.
- **ErrorsPage** — already well-behaved (Spotlight only on row-expand, now
  lazy via the shared SpotlightSection fix); switched its embedded
  Spotlight to the curated 9-attr subset.
- **SystemArchPage / ServicesListPage** — already fast (all metric-backed /
  already gate KQL behind the awaited primary); left as-is.
- **MetricsPage** — the metrics explorer; its catalog paints first and the
  selected-metric chart follows, so it's already primary-first. Left as-is.

### Result (SPA nav, per page)

| page | first content | KQL jobs on load |
|---|---|---|
| Overview | 78ms | 2 |
| **Traces** | fast | **1 (was ~24)** |
| Alerts | 117ms | 1–2 (was 2 concurrent) |
| Logs | 197ms | 2 |
| Errors | ~1.5s (single primary table) | 1 |
| Metrics | 138ms | 1 |

Guarded by `tests/page-load-budget.spec.ts` (per-page initial-KQL-job
budget) + `tests/svcdetail-load-budget.spec.ts` + `tests/nav-escalation.spec.ts`.

---

## The duration chart was EMPTY, not slow (fixed in 0.13.13)

User reported the Service Detail rate/error/duration charts "take 3–4s to
fill," then "Duration is a flat line at zero — don't think it's working."

Two separate issues, found by measuring:

1. **Counts-first (0.13.11):** the time-series reader `Promise.all`'d the
   cheap counter (591ms) with the expensive latency quantiles, so the rate
   + error charts waited on latency. Split so the counter emits first via
   an `onPartial` callback → rate/error charts fill at ~1.5s. Also deferred
   the ops table + prev-window delta (each 3 more `histogram_quantile`
   queries) behind the hero RED reads to cut metrics-engine contention.

2. **The real bug — the duration RANGE query returned NO rows.** A live
   probe of the fast store was conclusive:
   - instant `histogram_quantile(0.95, sum(rate(dur_ms[5m])) by (le,svc))` → 16 rows ✓
   - range   `histogram_quantile(0.95, sum(rate(dur_ms[60s])) by (le,svc))` step 60 → **0 rows** ✗
   - range   with `rate(dur_ms[5m])` → 207 rows ✓

   Our metrics are emitted **once per minute**. `rate()` needs ≥2 samples
   inside its range-vector window; a window tied to the fine bin (`[60s]`
   at 1h) almost always captured <2 samples → empty result → the duration
   chart drew a flat line at 0. (The summary CARDS worked because they use
   an *instant* quantile over the full lookback window, which always has
   enough samples.)

   **Fix:** floor the latency series' rate-vector window at 5m
   (`rateWin = max(binSeconds, 300)s`) while keeping the fine `step` for
   resolution; the COUNTER keeps its bin (`sum_over_time` needs only 1
   sample). Verified: the fixed query returns 966 rows and the duration
   chart now plots real p50/p95/p99. This also un-breaks the all-services
   catalog p95 sparklines, which had the same empty-at-1h bug.

---

## RED scoped to entry-point spans (0.13.14)

Investigating "payment latency is ~500ns" (actually ~500µs — payment is a
sub-ms mock, confirmed correct) surfaced a real, pre-existing methodology
bug: RED **duration** and **requests** aggregated EVERY span kind, so
client-heavy services read far too low. Raw server-span p95 vs all-span:

| service | true server p95 | all-span (old) |
|---|---|---|
| checkout | 4.4s | ~0.28s (14k client spans @277ms) |
| cart | 48ms | ~1ms |
| payment | 0.61ms | 0.36ms |

Fix: `entrySpanKindClause()` = `| where tostring(kind) in ("2","5")` —
keep only SERVER (2) and CONSUMER (5) spans (the request the service
handles), drop CLIENT/PRODUCER/INTERNAL. CONSUMER is required for pure
message-driven services (accounting, fraud-detection have only kind 5).
Applied to both emitters (`metricRequestsExport`, `metricDurationExport`)
and the KQL RED fallbacks (`serviceTimeSeries`, `serviceOperations`,
`serviceInstances`, `allServiceOperations`) so both read paths agree.

Verified entry-span RED is now correct: checkout 4.4s, cart 48ms, payment
0.61ms, accounting/fraud-detection appear via consumer spans; load-generator
+ product-reviews (no request-handling spans) correctly drop out.

**No backfill** (per constraint — the metrics store is non-idempotent, so
re-emitting would double-count). The change is forward-only: new minutes
are entry-span-scoped; historical all-span minutes age out of the window
over the next ~24h, so RED numbers blend during the transition and then
self-correct. The emitter change doesn't re-emit, so no double-count.

---

## Trailing zero-bucket from emitter jitter (0.13.15)

After 0.13.14, frontend's request-rate chart dropped to ZERO for the last
couple minutes. Root cause: the RED time-series reader fires two separate
metrics queries — the counter (`criblapm__metric_requests`) and the
duration histogram (`criblapm__metric_duration`) — which are INDEPENDENT
scheduled searches with their own schedule jitter. The 0.13.13 latency fix
widened the duration query's rate window to 5m, so it returns a point for a
trailing minute the counter hasn't summarized yet. The reader's latency
loop then CREATED a bucket for that minute with `requests = 0` (latency set,
count absent) → a phantom zero at the right edge. The 0.13.14 redeploy
re-jittered the two searches so their emit offsets diverged, surfacing it.

Fix (read-side, no emitter/backfill): latency ENRICHES existing counter
buckets only — it never creates its own. The counter is the source of truth
for "was this minute summarized," and `summarize count()` never emits an
empty bucket, so every counter bucket has requests ≥ 1. Trailing
not-yet-emitted minutes simply don't appear (the line ends cleanly) instead
of drawing a zero. Robust to any jitter between the two emitters.

---

## Status-code mix migrated to metrics (0.13.18)

The Service Detail "Status mix" chart was the last metric-shaped panel on a
live KQL span scan. Migrated to a new counter `criblapm_status_class_total`
labelled (svc, status_class ∈ {ok,4xx,500,502,503,504,other_5xx,grpc_err}),
same entry-span scope + status_class case as the KQL `serviceStatusCodeMix`.

- Emitter: `metricStatusClassExport()` (per-minute delta counter). Live
  scheduled search `criblapm__metric_status_class` + backfill entry
  (counter kind).
- Read: `promStatusClassSeries` + `readServiceStatusMixViaMetrics`;
  `getServiceStatusCodeMix` is now metrics-first (KQL fallback when metrics
  off / non-current window).
- This is also the **live validation of backfill v2's per-metric
  idempotency**: on deploy, the 6 existing metrics skip and ONLY the new
  `criblapm_status_class_total` backfills its 24h history.

---

## Latency percentiles: histogram → precomputed gauges (0.13.21)

Investigating "Service Detail takes 15s" found TWO problems with the
`histogram_quantile` latency reads:

1. **Slow.** A controlled experiment (emit a test histogram at full vs
   1/16 sample, time the read) showed `histogram_quantile` is a ~710ms
   FIXED per-query cost — independent of datapoint count (sampling the
   input speeds the WRITE, not the READ). Service Detail fires ~12 of them
   at once → the engine serialises them to 2–3.6s each → ~15s.
2. **Wrong.** frontend's latency is bimodal (p50=4.6ms, p90=20ms,
   p95=3068ms — a huge empty gap). Cribl's auto-bucketed histogram can't
   resolve the gap: a quantile sweep showed the histogram reports
   p95≈19.5ms / p99≈20.5ms — it drops the entire slow tail. The chart
   showed p95/p99 swinging 20ms↔3s (the "drops to zero"); raw
   `percentile()` per 5-min bin is a stable ~3s.

Fix: **precompute the percentiles.** New scheduled searches compute
`percentile(dur_ms, {50,95,99})` from raw entry spans per (svc[,operation])
per minute and emit GAUGES (`criblapm_request_latency_ms`,
`criblapm_op_latency_ms`, labelled `quantile`). One search per (family,
quantile) — Cribl's `export to metrics` drops rows when 3 percentiles are
unioned/wide-exported, but a single-percentile export is clean. Reads
switch from `histogram_quantile` to `avg_over_time` of the gauge (~114ms,
and the TRUE percentile). Every fixed-percentile read migrated: service
cards + duration chart + Top Operations + operation-anomaly baseline.
(Edge + messaging p95 on System Arch still use the histogram — same
pattern, follow-up.) Backfilled per-metric-idempotently (only the 6 new
gauges). The old `criblapm_request_duration_ms` histogram stays for now
but is no longer read for RED latency.

---

## Retire histograms + lazy KQL panels (0.13.23)

Follow-up to the percentile-gauge migration, three changes:

1. **Dropped all three duration histograms.** After the gauge migration
   nothing read `criblapm_request_duration_ms` (the single heaviest
   emitter — the only per-span export), yet it was still emitted + backfilled
   every minute. Removed its scheduled search + backfill entry; same for the
   edge/messaging duration histograms.
2. **Edge + messaging p95 → gauges** (`criblapm_edge_latency_ms`,
   `criblapm_msg_latency_ms`), the last two `histogram_quantile` reads. Now
   NO histogram is emitted or read anywhere — every latency number is a
   fast, correct percentile gauge.
3. **Lazy Service Detail KQL panels.** With latency off the critical path,
   a breakdown showed the remaining ~13s settle was the below-fold KQL
   search jobs (Recent errors, per-instance RED, pod uptime). Moved them to
   a scroll-into-view effect (sentinel just below the RED hero) so they no
   longer fire on load.

Net: Service Detail first content ~170ms, the RED hero (cards + charts +
ops + status mix) is all fast gauges/counters, and the heavy KQL only runs
when scrolled to. The alert-status badge (small, polled) stays eager.
