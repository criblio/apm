# Cribl APM — Roadmap

This document is the canonical priority list for the Cribl APM
Search App. It captures the competitive gap analysis we ran against
Datadog, Honeycomb, Dash0, Kloudfuse, Grafana Tempo/Loki, New Relic,
and Sentry, plus the architectural insight that we're built on top of
Cribl Search and should lean on its primitives (saved searches,
alerts, query language, federation) rather than reinvent them.

> **Refer to this doc as `ROADMAP.md`** (or `/ROADMAP.md` from the repo
> root). Companion docs: `FAILURE-SCENARIOS.md` for the flagd flag
> catalog and test plan; `CLAUDE.md` for repo-wide coding rules;
> `AGENTS.md` for the Cribl App Platform developer guide.

## Guiding principle: lean on Cribl Search

The Cribl APM runs *inside* Cribl Search. Cribl Search already
provides:

- **Saved searches** — named, shareable KQL queries with persistence
- **Scheduled searches** — run a query on a cron and act on the result
- **Alerts / notifications** — monitor a saved search and trigger
  webhooks, Slack, email, PagerDuty
- **KQL** — rich query language for slicing spans, logs, and metrics
- **Federation** — queries can fan out across multiple datasets and
  worker groups
- **Pack-scoped KV store** — for app-level settings and state

So we do **not** need to reinvent alerting, dashboards, saved searches,
or a query language from scratch. What we need is a **domain-specific
UI on top of those primitives** that speaks traces / logs / metrics
rather than raw KQL. Users of our app should never have to know they
can drop into a KQL editor — the app should translate their
intentions into saved searches and alerts behind the scenes.

Concretely, that shapes every roadmap item:

- "Detected issues" → the health-bucket signals we already compute
  (error rate thresholds, traffic drops, latency anomalies) should be
  **materialized by scheduled searches** and rendered as a prominent
  alerts panel on the home page — not buried in row tints
- "User-created alerts" → a **"Create alert"** button that builds a
  saved-search + alert definition under the hood, then calls the Cribl
  API to persist it
- "Saved views" → Cribl saved searches owned by the app, tagged with
  a `criblapm:view` tag so we can list and render them
- "Dashboards" → a set of saved searches composed into a page; still
  backed by Cribl, rendered by us
- "Query language" → we keep the guided forms as the primary surface
  but expose an optional "Edit as KQL" escape hatch for power users

The rest of this document groups features by the Cribl Search
capability they'd ride on.

---

## Priorities (in rough order)

See [`docs/research/ux-competitive-analysis.md`](docs/research/ux-competitive-analysis.md)
for the full competitive analysis against Datadog, New Relic,
Dynatrace, and Grafana that drives this priority order.

### 1. Performance: reclaim search-worker headroom

**This is the only priority on this list that's currently blocking
the rest of the roadmap.** Background scheduled searches now
saturate the workspace's `max: 20` concurrent search queue (see
the corresponding entry in "Blocked on Cribl"). Investigator
queries and ad-hoc operator searches sit in the queue for
~56-57 seconds — long enough that every multi-turn
investigation runs out the per-turn budget before it can read
any data. The 2026-05-12 `leakFingerprint` eval transcript is
the concrete artifact: the agent followed the playbook to the
letter and never got a query through.

**Two orthogonal levers** (both worth pulling):

1. **Acceleration at the dataset level.** Cribl Lakehouse Indexed
   Fields and Parquet predicate-pushdown both pull JSON-nested
   fields up to top-level columns so filters and group-bys don't
   have to deserialize the whole record. Up to **5 indexed
   fields per Lake Dataset** plus **3 partitions**. (The deprecated
   "Dataset Acceleration" prescan feature is gone; the
   replacement is Lakehouse.) Field-access inventory from
   `src/api/queries.ts` (uses of each as predicate or
   group-by key):

   | Field | Uses | Why it matters |
   |---|---:|---|
   | `resource.attributes['service.name']` | 28 | filtered/grouped by ~every query |
   | `status.code` | many | error predicate |
   | `kind` | 19 | server/client/internal filter |
   | `name` | 171 (mostly proj; ~10 as predicate) | operation grouping |
   | `end_time_unix_nano` | 19 | "is this a span?" filter |
   | `parent_span_id` | 12 | trace topology, leaf detection |
   | `trace_id` | 23 | trace scoping, self-joins |
   | `span_id` | 9 | trace topology |
   | `attributes['http.response.status_code']` | 3 | filter rules |
   | `attributes['rpc.grpc.status_code']` | 3 | filter rules |

   Proposed 5 indexed-field picks (subject to Cribl Lake migration
   plan): `service.name`, `status.code`, `kind`, `name`,
   `parent_span_id`. The HTTP/gRPC status fields are used by
   fewer queries; once the top-five are accelerated, those
   queries are already cheap.

2. **Reduce the steady-state search load.** Today the workspace
   runs 16 `criblapm__*` scheduled searches; many fire every 5
   minutes on -1h windows scanning the same span set. Audit
   targets:

   - **Cadence drops** for searches whose data doesn't move every
     5 min: `criblapm__trace_originators`, `criblapm__metric_catalog`
     could be hourly. `criblapm__svc_operations` could be every
     15 min.
   - **Consolidate** searches that scan the same -1h span window
     and emit related aggregations. The home_service_summary,
     sysarch_dependencies, sysarch_messaging_deps, svc_operations
     all derive from the same input — a "wide aggregation"
     pattern that emits multiple lookups in one pass would
     eliminate redundant scans. Limitation: `| export` consumes
     rows, so a single search can write to only one lookup. The
     workaround is to land the wide aggregation in `$vt_results`
     and have lookup-emit searches read FROM `$vt_results`
     rather than spans.
   - **Tighter windows where possible** — some searches widen
     to -1h to compute averages; for "current state" panels,
     -10m or -15m is plenty and dramatically cheaper.

**Detailed implementation plan**:
[`docs/research/search-perf-plan.md`](docs/research/search-perf-plan.md).

**Out of scope**: replacing the Cribl Lake dataset with another
storage backend, or building an in-app query cache. The fix is
within Cribl's existing primitives.

### 2. Faceted trace search

The current Search form is fixed-shape. Every commercial APM lets
users query on arbitrary attributes with autocomplete and facets.

- Typed filter builder: attribute name autocomplete → operator → value
- Multi-condition AND/OR with grouping
- Attribute value facets with counts, click to filter
- Cardinality-aware autocomplete
- "Edit as KQL" escape hatch for power users

### 3. User-created alerts + notification dispatch

Phase 2 of alerting: "Create alert" button that persists a threshold
as a Cribl saved search with notification targets. Full design in
[`docs/research/alerting-design.md`](docs/research/alerting-design.md).

### 4. SLO budgets

Thin layer on top of alerts. SLO = saved search tracking
(success / total) over a 28-day window, plus budget burn rate
alerts at 1h / 6h / 24h windows.

### 5. Dashboards (via Cribl Saved Searches)

User-created dashboards composing multiple saved views as widgets.
"Save this view" button on Traces / Logs / Metrics / ServiceDetail.

### 6. Flame graph + critical path on Trace detail

- Flame graph / icicle chart for self-time visualization
- Critical-path highlighting (spans that drove end-to-end duration)
- Latency histogram per operation

### 7. Service catalog / ownership

Tag services with team, oncall, runbook URL, repository link.
Route alerts by ownership. Backstage-style but lightweight.

### 8. Database query performance

Top slow queries, fingerprints, execution plans. Linked to traces
via `db.statement` / `db.system`.

### 9. Live tail

Streaming logs and spans as they arrive. "Tail" button on the
Logs page.

### 10. Leak-fingerprint detection — hardening

The 2026-05-12 session shipped the architecture for detecting smooth-
climb / memory-leak / cardinality-leak failures that the named flagd
scenarios don't cover. Foundations are in (Investigator playbook,
attribute catalog, daily error-rate snapshot, pod uptime feed into
knownSignals, origin attribution in trace view). The
`leakFingerprint` eval scores 0.70 (3/3 surface checks; Investigator
times out on cluster queue saturation, not on misdiagnosis — the
transcript shows the agent correctly opens with the leak hypothesis
and follows the playbook step by step).

Three follow-ups to take the eval to 1.0:

- **Cardinality dcount search** (the actual per-(svc, attr_name)
  growth signal). Today only the attribute *catalog* ships; computing
  dcount needs KQL that's regenerated at provision time from the
  catalog contents (each attribute baked into the query as a static
  name, since Cribl KQL doesn't support `attributes[col]` dynamic
  indexing). Requires a provisioner change to read the catalog
  lookup before building the plan. Bigger plumbing change held back
  in the foundation commit.

- **`lookup` semantics: returns one row per key**. The
  `criblapm_error_rate_daily` lookup has 7 daily rows per service,
  but `| project svc="frontend" | lookup criblapm_error_rate_daily
  on svc` returns only ONE row — the first match. Playbook's "read
  the 7-day slope in one query" pattern only delivers one data
  point. Workaround: restructure the lookup as one row per service
  with the daily history as a list field (`days_json`, or seven
  columns `d0_pct .. d6_pct`). Tracked as a Cribl ergonomic issue
  in "Blocked on Cribl" below.

- **Eval `runInvestigator` plumbing**: today the eval clicks the
  top-nav "Investigate" link, which lands on the free-form composer
  with no `knownSignals` seeded. The C work plumbs pod uptime into
  `buildServiceSeed` on Service Detail — but the eval doesn't route
  through Service Detail, so those signals never reach the agent.
  Two options: (a) change `runInvestigator` to navigate Service
  Detail and click ITS Investigate button (changes the prompt
  contract for the eval), or (b) wire the free-form composer to
  auto-fetch known signals when the user's prompt mentions a service
  name. Option (b) is the better product change.

Additional polish that didn't land in the foundation commits:

- **Drift alert state-machine wiring.** The 7-day daily error-rate
  history lookup exists; the alert evaluator doesn't yet emit a
  `drift` signal type from it. State machine + UI sparkline +
  "errors trending up: X% → Y%" affordance on service rows are
  separate features.
- **Pod-uptime timeline overlay on Service Detail.** Today the
  uptime feeds `knownSignals` and renders in the Investigator
  context, but there's no visible chip or timeline marker on the
  Service Detail page itself.
- **`tests/scenarios/payment-failure.spec.ts` iframe migration.**
  Iframe-nav fix updated `apm-smoke.spec.ts` and the eval engine,
  but payment-failure.spec.ts still uses `page.getByRole(...)` on
  the main frame and would fail the same way the smoke test did
  before. Mechanical update — copy the `apmFrame(page)` pattern.
- **Extract `attributeOrigin` from `SpanDetail.tsx`** to its own
  utility module and unit-test it. The function is pure and the
  branching logic deserves the same coverage `errorFilter.ts`
  rules get.
- **Cluster capacity / scheduled-search load.** The workspace now
  has ~16 `criblapm__*` scheduled searches; with `max: 20`
  concurrent search jobs, the queue is consistently full and live
  Investigator queries are stuck behind 56-57s queue waits. Some
  scheduled searches could move to longer cadences without losing
  value (op-baselines is hourly already; the per-5-min cadence on
  several panel caches is probably aggressive). Audit + reduce.

### 11. Universal data mapping (schema-agnostic APM)

The APM currently depends on OpenTelemetry's field naming conventions
(`resource.attributes['service.name']`, `status.code`, `end_time_unix_nano`, etc.).
This limits the app to OTel-instrumented workloads.

**Vision:** any data in Cribl Search should be mappable to the APM's
service model — Cribl internal logs/metrics, custom application logs,
legacy monitoring data. The same dashboards, alerts, and investigations
would work regardless of the source schema.

**Design questions:**
- **Configuration UI** — a mapping editor that lets users define
  "service name is field X", "error indicator is field Y == value Z",
  "latency is field W". Store mappings in KV per dataset.
- **LLM-assisted mapping** — given a sample of records from a dataset,
  use an LLM to suggest field mappings automatically. "This looks like
  `hostname` maps to service, `response_time_ms` maps to duration,
  `status >= 400` maps to error."
- **Copilot Investigator tool** — a `create_field_mapping` tool that
  the Investigator can call to build mappings interactively during an
  investigation. "I see this dataset uses `app_name` for the service
  identifier — let me configure that for you."
- **Query abstraction** — all query builders in queries.ts should read
  from the mapping config instead of hardcoding OTel field paths.
  A `fieldResolver(dataset, 'service.name')` function that returns
  the mapped field path.

**Scope:** this is a foundational architecture change that affects
every query, every panel, and every scheduled search. It should be
designed carefully and implemented incrementally — start with the
mapping config UI + one query builder, validate the abstraction,
then roll out to all queries.

### Blocked on Cribl

- **Metrics: `_metric_name` in wide-column format** — Cribl's
  wide-column metric storage flattens the metric value and its
  numeric attributes into top-level fields with no way to
  distinguish them. Fields like `http.status_code` (a dimension)
  are indistinguishable from `http.server.duration` (the metric).
  We use a blocklist of known numeric attributes as a workaround.
  Feature request submitted to Cribl to preserve `_metric_name`
  (or equivalent) in the wide-column ingest pipeline.

- **`summarize → summarize max(iff(...))`** — Cribl KQL crashes
  on real data when a second `summarize` uses `max(iff(...))` on
  output from a prior `summarize`. Workaround: split into separate
  scheduled searches joined via lookups. Bug report pending.

- **`lookup` returns only one row per key.** When a lookup table
  has multiple rows for the same key, `| project key="X" | lookup
  T on key` returns only the first match — not all matches.
  Confirmed against `criblapm_error_rate_daily` which holds 7
  daily rows per service: the join collapses to one. This shapes
  every "read a series from a lookup" pattern (drift, daily
  history, per-attribute cardinality over time, etc.).
  Workarounds today: pack the series into one row (CSV string,
  array column, or N parallel columns). A real fix lets the
  consumer say "return all matching rows."

- **Dynamic field access `attributes[col_name]` is rejected.**
  KQL parses `attributes['session.id']` (static string) fine but
  fails on `attributes[some_column]` where `some_column` holds a
  value chosen at query time. This is the constraint that makes
  per-(svc, attr_name) cardinality search require KQL generated at
  provision time rather than a single dynamic search reading from
  the catalog lookup at query time. `bag_keys` discovers names;
  `bag_values` doesn't exist either, so even pairing keys with
  their values per row inside one query isn't possible. The most
  natural fix is dynamic indexing or a `bag_values` companion.

- **Long-window aggregations (-7d hourly bins, -10d any bins)
  routinely exceed the 60s search-job timeout.** Workaround: run
  shorter windows in sequence and aggregate client-side, or use
  daily bins instead of hourly (still ~60-70s on -7d but
  completes). Affects every "show me the multi-day trend" feature.

- **Concurrent search queue limit (`max: 20`).** With the app's
  ~16 scheduled searches firing on their cadences, a user-issued
  investigation routinely waits >56s for each query to dequeue.
  Either the per-pack quota needs raising or scheduled searches
  need to share workers more efficiently.

### Future categories (whole new signal types)

- **Continuous profiling** — CPU/memory/lock via eBPF/pprof
- **Real User Monitoring** — browser SDKs, web vitals, session replay
- **Synthetics / uptime** — scheduled HTTP + browser checks

---

## Things we have that ARE competitive

- **Server-side alert state machine** — debounce, clear messages,
  alert history in the dataset. Most cheaper APMs don't have this.
- **Baseline delta chips** — regressions vs previous window on
  catalog rows
- **Messaging edges on the arch graph** — OTel `messaging.*`
  attributes. Most backends only show RPC edges.
- **Noise filter** on trace aggregates — hides streaming/idle-wait
  spans from percentiles. Novel.
- **Edge-level health** on the graph, not just node-level
- **Copilot Investigator** — AI root-cause analysis embedded
  throughout the UI with pre-filled context
- **Configurable detection cadence** — user controls the speed/cost
  tradeoff for scheduled searches

---

## Completed

Items below shipped and are kept for historical reference. See git
log and linked PRs for implementation details.

### Navigation overhaul + focused views (v0.7.0) — DONE

PR #30. Driven by competitive analysis against Datadog, New Relic,
Dynatrace, and Grafana.

- **Left sidebar navigation** — collapsible sidebar with 10 nav items,
  section dividers, icon-only collapse mode. Replaces horizontal nav.
- **Overview page** — focused "is anything wrong?" dashboard: Detected
  Issues, Key Metrics row, Services Needing Attention, Recent Alerts.
- **Errors Inbox** — first-class error tracking page with error groups
  by (service, operation, message), count badges, sample traces,
  Investigate buttons.
- **Service Detail tabs** — Overview / Traces / Logs / Errors /
  Dependencies, URL-driven via `?tab=` param.
- **Alert timeline** — stacked service bars with drag-to-select
  filtering, incident pairing (firing→resolved with duration), time
  range picker (1h–30d), 30s auto-refresh.
- **Metric catalog cleanup** — blocklist for numeric OTel attributes
  misclassified as metrics.
- **Eval framework** — updated for new views, SPA sidebar navigation,
  Pending/Firing alert checks. Mean score 0.71 (5/13 fully detected).

### AI-powered investigations (Copilot Investigator) — DONE

Cribl Search ships a "Run an Investigation" feature (Copilot
Investigator) — a chat-based AI agent that runs KQL queries, reads
dataset schemas, and produces structured findings. We embedded it
throughout Cribl APM so users can drill into problems with one click.

**What shipped** (PR #14, branch `copilot-investigator`):

- **API spike + protocol docs** in
  [`docs/research/copilot-investigator.md`](docs/research/copilot-investigator.md)
  — streaming NDJSON protocol, tool-use loop, A/B comparison
  confirming pre-filled APM context dramatically improves accuracy
  and time-to-root-cause (bare prompt never completed; context-enriched
  found `ECONNREFUSED` and `Invalid token` root causes in minutes)
- **Agent client** (`src/api/agent.ts`) — streaming NDJSON reader +
  frame parser
- **Context builder** (`src/api/agentContext.ts`) — pre-fills dataset
  shape, field mappings, KQL dialect notes (including the bracket-
  quoted dotted-field rule), service topology, ISO-8601 timestamp
  requirement, trace-vs-span semantics, and example working queries
- **Tool dispatcher** (`src/api/agentTools.ts`) — implements
  `run_search` against the existing `runQuery`, `render_trace`
  against `getTrace`, `present_investigation_summary` with a
  structured UI payload
- **Loop orchestrator** (`src/api/agentLoop.ts`) — conversation
  state machine emitting typed events to the UI reducer
- **Chat UI** (`src/routes/InvestigatePage.tsx`) — streaming
  transcript, inline Run Query approval cards, result tables,
  rendered trace waterfall (reuses the existing `SpanTree`
  component), and a dedicated Final Report card
- **Investigate buttons** on Home catalog rows, Service Detail hero,
  Trace Detail header, System Architecture nodes and edges, and
  Latency anomaly widget rows

### Eval harness (Autoresearch loop) — DONE

Manual Autoresearch eval tool shipped as `npm run eval` (PR #19).
Design: `docs/research/eval-harness/design.md`. Three starter
scenarios (paymentFailure, kafkaQueueProblems, paymentUnreachable)
covering the three most distinct failure shapes: error injection,
consumer lag, and hard downtime.

First improvement loop completed (PR #20). Ran 4 rounds, fixed
every failure, brought mean score from **0.71 -> 1.00**:

| Fix | What it addressed |
|---|---|
| Investigator latency-anomaly preflight | Copilot couldn't diagnose kafka lag (latency-only, no errors) |
| ServiceDetail Recent errors -15m fallback | Panel too slow during fresh incidents (62s -> 18s) |
| Cribl KQL `(?i)` regex crash | Entire rawSlowestTraces query silently returned zero results |
| `npm run provision` automation | No more manual Settings clicks after deploy |

Full 13-scenario matrix completed (PRs #22-#23). 10 of 13
fully detected (1.00), 3 at 0.77 with cluster-specific causes
(adHighCpu flag effectiveness, cartFailure error attribution,
flaky Copilot latency).

### Scenario detection & test harness (1b-1d) — DONE

- **UI gaps** (1b) — ghost nodes, red rate-drop chip, root-cause
  hint: all three shipped. Verified against source in the 2026-04-16
  coverage audit.
- **Flagd smoke test** (1c) — PR #10
  `tests/scenarios/flagd-catalog-validation.spec.ts`. Also surfaced
  `adFailure`'s 10% Bernoulli rate (upstream `AdService.java`).
- **Detection coverage gaps** (1d) — mapped all 15
  `FAILURE-SCENARIOS.md` flags to current UI capability. Result:
  **9 fully detected, 3 partially detected, 1 design-limited,
  2 out of scope.** All four proposed fixes shipped (PRs #13-#17).

### Metrics wide-column migration — DONE

Cribl Search changed the metrics schema on 2026-04-15 from
`_metric`/`_value` pair format to wide-column (each metric is
its own top-level field). PR #24 rewrites all 14 query functions
and 9 search functions to use bracket-quoted field references.

- Metric discovery via regex on `_raw`, pre-computed by the
  `criblapm__metric_catalog` scheduled search
- Metrics picker redesigned: fuzzy search, prefix grouping,
  inline type badges (C/G/H), alphabetical sort
- Search results table: full 32-char trace IDs, compact layout

**Known limitation:** histogram metrics with cumulative
temporality (.NET SDK) store running sums — `percentile()`
over these is nonsensical. Needs delta-based aggregation or
temporality detection.

### Metrics support — DONE

The app now covers spans, logs, and metrics. The Metrics explorer tab
supports metric type detection (counter/gauge/histogram), smart
aggregation defaults (counter->rate, histogram->p95), group-by
dimension picker, multi-series line charts, and rate derivation for
counters.

### Durable baselines + panel caching — DONE

- **Research** — saved search provisioning API, persistence
  mechanisms (`$vt_results`, `export to lookup`, `| send`),
  notification targets, idempotent `criblapm__` naming. See
  [`docs/research/cribl-saved-searches.md`](docs/research/cribl-saved-searches.md).
- **Durable baselines** — scheduled search computes per-(service,
  operation) p50/p95/p99 over a rolling 24h window, exports to
  `lookup criblapm_op_baselines`. Anomaly detector reads via
  hash-join. Graceful degradation when lookup doesn't exist yet.
- **Panel caching** — Home and System Architecture read precomputed
  data from `$vt_results` in one batched query (~1-2s). Scheduled
  searches: `criblapm__home_service_summary`,
  `criblapm__home_service_time_series`, `criblapm__home_slow_traces`,
  `criblapm__home_error_spans`, `criblapm__sysarch_dependencies`,
  `criblapm__sysarch_messaging_deps`, `criblapm__op_baselines`,
  `criblapm__svc_operations`, `criblapm__metric_catalog`.
- **Provisioning workflow** — Settings page reconciles scheduled
  saved searches (preview -> apply). `npm run provision` for CLI.
  `npm run deploy` auto-reconciles.

### Core APM surfaces — DONE

- Home: service catalog with rate / error / p50/p95/p99 columns,
  delta chips, error classes, slowest trace classes, latency anomalies
- Health buckets: error-rate + traffic_drop + latency_anomaly with
  precedence ordering. Row tints on catalog, halos on arch graph.
- Search: fixed-shape form with results table and stream-noise filter
- Logs: service / severity / body / range filters, sticky facet sidebar
- Metrics: explorer with picker, group-by, rate derivation, percentile
- Compare: two-trace structural diff
- System Architecture: force-directed + isometric, edge-level health,
  messaging edges, ghost nodes, node hover tooltips
- Service Detail: RED charts, top operations, recent errors,
  dependencies, instances, metric cards (batched)
- Trace detail: waterfall, span detail with attributes / events /
  logs / process tags / exception stack traces, trace logs tab
- Settings: dataset selection + stream-filter toggle + provisioning

### Infrastructure & testing — DONE

- **ServiceDetail panel caching** — PR #15. Mirrors Home panel
  cache for ServiceDetail (~1-2s vs 10-20s).
- **Kafka consumer stream-filter exemption** — PR #14. Consumer
  ops bypass idle-wait filter for kafka lag scenarios.
- **Home panel cache-miss fallback** — PR #8. Live query fallback
  with "cache Nm stale" indicator.
- **Trace waterfall clock-skew resilience** — PR #9. Root-span
  anchoring for clock-skewed children.
- **Playwright e2e framework** — PRs #4-#7, #13. Auth0 login,
  host-global injection, flagd-ui client, Cribl Search helper,
  scenario specs.
- **Documentation consolidation** — PR #12.
- **Search results table density** — PR #24.
