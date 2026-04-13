# Cribl APM — Roadmap

This document is the canonical priority list for the `oteldemo/` Cribl
Search App. It captures the competitive gap analysis we ran against
Datadog, Honeycomb, Dash0, Kloudfuse, Grafana Tempo/Loki, New Relic,
and Sentry, plus the architectural insight that we're built on top of
Cribl Search and should lean on its primitives (saved searches,
alerts, query language, federation) rather than reinvent them.

> **Refer to this doc as `ROADMAP.md`** (or `/ROADMAP.md` from the repo
> root). Companion docs: `FAILURE-SCENARIOS.md` for the flagd flag
> catalog and test plan; `CLAUDE.md` for repo-wide coding rules;
> `oteldemo/AGENTS.md` for the Cribl App Platform developer guide.

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

- "Alerting" → a **"Create alert"** button on Home catalog rows,
  ServiceDetail, and arch graph that builds a saved-search + alert
  definition under the hood, then calls the Cribl API to persist it
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

### ~~1. AI-powered investigations (Copilot Investigator)~~ — **DONE (foundation)**

Foundation and all integration points shipped in PR #14. See
`docs/research/copilot-investigator.md` for the API spike and A/B
comparison, and `docs/sessions/2026-04-12-copilot-implementation.md`
for the implementation log.

### 1a. Copilot Investigator — accuracy follow-ups (NEW, from scenario eval)

The 2026-04-12 scenario evaluation
(`docs/sessions/2026-04-12-scenario-evaluation.md`) ran five error-
injection flags paired against the UI and Investigator. The Investigator
nailed `cartFailure` (131s, exact Redis error + rendered trace) but
**missed `paymentUnreachable`** — the UI surfaces it cleanly (94% rate
drop, ▲+88023% p95) while the agent got anchored on stale cart data and
self-inflicted flagd-bounce noise. Three gaps, impact-ordered:

1. **Traffic-drop detection pass.** Today the agent only looks at error
   *rates* and *counts*. For unreachable-service scenarios the loudest
   signal is a service whose per-minute rate collapsed to near-zero.
   Add a client-side anomaly preflight that runs before the first LLM
   turn: compute per-service rate deltas vs the prior window, inject
   "services with traffic drops ≥50%" into the preamble as known
   signals. Home already does this for its `traffic_drop` health bucket;
   reuse that query.

2. **Time-window discipline.** Sequential tests bleed into each other
   because the 15-minute lookback swallows prior failures. Fix at two
   levels:
   - **Prompt:** add a "run an error histogram per minute first,
     distinguish recent from old signal" instruction to
     `agentContext.ts`. Landing in this PR.
   - **Code:** when the user prompt says "right now" or "in the last
     N minutes", the first `run_search` should tighten `earliest`
     accordingly instead of inheriting `-15m`.

3. **Filter flagd EventStream disconnects as noise.** Every time
   `flagd-set.sh` bounces the flagd deployment, 6+ services emit
   `14 UNAVAILABLE: Connection dropped` spans on the EventStream
   long-poll, and the agent reads that as a fanned-out outage. Two
   options: filter
   `grpc.flagd.evaluation.v1.Service/EventStream` at dataset ingest,
   or add a preamble paragraph explicitly marking those as expected
   noise. Start with the preamble paragraph (landing in this PR).

### 1b. UI gaps surfaced by the scenario eval

Three concrete UI bugs from the same session:

1. **Ghost nodes for silently-gone services on System Architecture.**
   When a service drops below N% of its baseline span volume, keep
   its node on the graph with a dashed outline and a "no traffic"
   badge, clickable through to its last-known Service Detail page.
   Today it vanishes from the graph, so `paymentUnreachable` has no
   clickable target. Catches any blast-radius scenario where the root
   service goes fully dark (`failedReadinessProbe`, pod crashloops,
   etc.).

2. **Red "DOWN" state on the Home rate-column DeltaChip.** The chip
   is currently `relNeutral` so a 94% rate drop renders the same
   blue color as a 94% surge. A dedicated red treatment for rate
   drops ≥50% would make payment's row scream in `paymentUnreachable`
   instead of mumbling.

3. **Root-cause hint on Home rows.** Home currently tints
   `frontend-proxy` red when `cartFailure` fires because errors
   attribute to the caller's outgoing-span side. The actual failing
   service (`cart`) still shows 0% because its own server-side spans
   aren't errored — cart's `EmptyCart` returns over a broken Redis
   connection inside the span duration. Add a "likely root: `<svc>`"
   hint derived from same-trace span-link analysis on anomalous rows.
   The Investigator already runs this query; Home should render it
   without asking.

### 1c. FAILURE-SCENARIOS.md smoke test

The 2026-04-12 eval found **three of five tested flags produce zero
`status.code=2` errors on their targeted service** (`adFailure`,
`productCatalogFailure`, `llmRateLimitError`). Verified via direct
KQL — not an observer-side problem. Either the upstream OTel demo's
flag wiring has regressed or the flags require specific UI actions
to activate. Either way, `FAILURE-SCENARIOS.md` is stale on those
rows and can't be trusted as a regression harness. Fix: ship a
scheduled saved search that counts errors per flagged service on a
rolling window and alerts when a known-enabled flag emits nothing.

### 2. User-facing alerts (via Cribl Saved Searches)

- "Create alert" button on Home catalog rows, Service Detail, edges,
  and logs — captures the current filter context and surfaces a
  plain-language threshold form ("error rate > 5%", "p95 > 2s",
  "request rate drops by 50%", "op p95 > N× baseline")
- Under the hood the app generates a KQL saved search, creates a
  Cribl alert against it via the same provisioning pipeline, and
  stores app-level metadata (alert name, owning view, UI context)
- Rendered on an "Alerts" page that lists all app-managed alerts,
  their current state, recent firings, and a link back to the view
  where they were created

### 3. SLO budgets

Thin layer on top of alerts. An SLO is a saved search that tracks
(success count / total count) over a 28-day rolling window, plus a
budget burn rate. Same provisioning plumbing, different threshold
semantics and UI (error budget remaining, burn alerts at 1h / 6h /
24h windows).

### 4. Error tracking / Errors Inbox

We already have an "Error classes" panel that groups by
`(service, operation, first-line-of-message)`. Upgrade it into a
first-class feature surface:

- Better grouping key: `(service, operation, exception.type,
  normalized stack frame hash)` — Sentry-style fingerprinting
- First-seen / last-seen / count sparkline per fingerprint
- State: new / investigating / resolved / ignored, stored in the
  pack-scoped KV
- Regression detection: alert when a resolved fingerprint reappears
- Sample traces + sample logs attached to each fingerprint
- Assignment (freeform user string for now)

### 5. Saved views and dashboards (via Cribl Saved Searches)

Users need to bookmark a filter configuration and return to it. Today
we have zero persistence; every Search or Logs session starts empty.

- "Save this view" button on Home / Search / Logs / ServiceDetail /
  SystemArch — writes the current filter state to a Cribl saved
  search with a pack tag
- A "Saved views" menu in the navbar that lists them, groups by tag
- Composable dashboards: a page that renders multiple saved views as
  widgets

### 6. Ad-hoc span/log query with faceted exploration

Today the Search form is fixed-shape: service, operation, tags as
free text, min/max duration, limit. Every commercial APM lets users
query on arbitrary attributes with autocomplete.

- Typed filter builder: pick an attribute name from an autocomplete
  list of known attributes, pick an operator, pick a value
- Multi-condition AND/OR with grouping
- Attribute value facets — show the top values of a dimension with
  counts, click to filter
- Cardinality-aware autocomplete (don't load 50k distinct values)
- "Edit as KQL" escape hatch that shows the underlying Cribl query
  for power users

The facet UX mirrors BubbleUp / Datadog facets / Honeycomb queries.
Since Cribl KQL already has the query language, this is purely a UI
layer.

### 7. Flame graph + critical path on Trace detail

The current trace detail is a Gantt waterfall. Add:

- **Flame graph / icicle chart** — stacked rectangles showing
  self-time per call path; better for spotting hot subtrees in a
  50+-span trace
- **Critical-path highlighting** — marks the spans whose latency
  drove the trace's end-to-end duration (ignores parallel siblings)
- **Latency histogram** on the span detail panel for the operation's
  distribution in the current range (reveals bimodality that
  percentile lines hide)

### 8. Live tail

Streaming logs and recent spans as they arrive, like `kubectl logs -f`
or Datadog Live Tail. Cribl Search supports streaming query results;
wire it into the Logs page as a "Tail" button that switches from
paginated results to an auto-scrolling live view.

### 9. Continuous profiling (whole new category)

CPU / memory / lock profiling via eBPF or pprof, rendered as flame
graphs, linked to trace spans via profiling IDs. Pyroscope-compatible
if Cribl can ingest that format. Lower priority — entire new data
shape.

### 10. Real User Monitoring (whole new category)

Browser / mobile SDKs, page load timings, JS errors, session replay,
web vitals, user journeys. Would let us detect things like
`imageSlowLoad` that are invisible to backend APMs. Significant scope.

### 11. Synthetics / uptime (whole new category)

Scheduled HTTP + browser checks from multiple regions with alerting.
Could potentially be a scheduled saved search that uses Cribl's HTTP
collector as the probe target. Lower priority but also not huge.

### 12. Service catalog / ownership / team metadata

Tag services with owning team, oncall, runbook URL, repository link,
on-call schedule. Route alerts by ownership. Store in pack-scoped KV.
Backstage-style but lightweight.

### 13. Database query performance

Top slow queries, query fingerprints with execution plans, linked to
traces via `db.statement` / `db.system`. Requires schema support in
the query layer but otherwise rides on existing span data.

---

## Smaller gaps (cheap wins, not a roadmap priority)

- Span attribute autocomplete on the Search tags field
- Trace export (JSON / OTLP)
- Copy-as-URL shareable view links
- Latency histogram column on Top Operations
- Annotations / notes on traces
- First-run dialog for provisioning (currently manual via Settings page)

## Things we have that ARE competitive

Being honest about the wins too:

- **Baseline delta chips** — surfacing regressions against previous
  window directly on catalog rows; most cheaper competitors don't do
  this
- **Messaging edges on the arch graph** — reconstructed from OTel
  `messaging.*` attributes. Most backends only show RPC edges.
- **Noise filter** on trace aggregates — hides streaming /
  idle-wait spans from percentiles. Novel.
- **Edge-level health** on the graph, not just node-level
- **Lazy-loaded hover details** on arch nodes (top operations, erroring
  operations) with a module-level cache

---

## Completed

### ~~AI-powered investigations (Copilot Investigator)~~ — DONE

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
- **Investigate buttons** on:
  - Home catalog rows (service + health + delta signals)
  - Service Detail hero (service + top erroring/slow operations)
  - Trace Detail header (trace_id + error spans; seeds the agent
    to call `render_trace` first)
  - System Architecture node tooltip
  - System Architecture edges (click an edge line to investigate
    parent→child with call count + error rate)
  - Latency anomaly widget rows (p95 ratio + baseline context)

### ~~Metrics support~~ — DONE

The app now covers spans, logs, and metrics. The Metrics explorer tab
supports metric type detection (counter/gauge/histogram), smart
aggregation defaults (counter→rate, histogram→p95), group-by dimension
picker, multi-series line charts, and rate derivation for counters.

### ~~Durable baselines + panel caching~~ — DONE

#### Research (2a) — DONE

Detailed findings in
[`docs/research/cribl-saved-searches.md`](docs/research/cribl-saved-searches.md).
The REST surface, persistence mechanism, POST shape, notification
target collection, and idempotent-naming path are all resolved.

Key findings:
- Saved search provisioning API at `/api/v1/m/default_search/search/saved`
- Client-chosen `id` is respected — enables idempotent naming
- Auth: platform fetch proxy injects Bearer JWT automatically
- Three persistence mechanisms confirmed: `$vt_results` (auto-retained
  7 days), `export to lookup` (hash-join, sub-ms reads, 10k row cap),
  `| send` (no cap, heavier setup)
- Notification targets at `GET /api/v1/notification-targets` (cross-product)
- Convention: prefix app-managed IDs with `criblapm__`

#### Durable baselines (2b.1) — DONE

Scheduled search computes per-(service, operation) p50/p95/p99 over
a rolling 24h window, exports to `lookup criblapm_op_baselines`.
The anomaly detector reads baselines via lookup hash-join. Graceful
degradation when lookup doesn't exist yet.

#### Panel caching (2b.2) — DONE

Home and System Architecture pages read precomputed panel data from
`$vt_results` cache via batched single-query reads. Reduces Home
page load from ~8s (5-7 independent queries) to ~1-2s (one
`$vt_results` read). Scheduled searches provisioned:

| Saved search ID | Cron |
|---|---|
| `criblapm__home_service_summary` | `*/5 * * * *` |
| `criblapm__home_service_time_series` | `*/5 * * * *` |
| `criblapm__home_slow_traces` | `*/5 * * * *` |
| `criblapm__home_error_spans` | `*/5 * * * *` |
| `criblapm__sysarch_dependencies` | `*/5 * * * *` |
| `criblapm__sysarch_messaging_deps` | `*/5 * * * *` |
| `criblapm__op_baselines` | `0 * * * *` |

#### Provisioning workflow (2e) — DONE (basic)

Settings page includes a provisioning panel that reconciles scheduled
saved searches (preview → apply workflow with create/update/delete/noop
actions). Stores `provisioned-version` in KV. First-run dialog
not yet implemented (manual trigger from Settings for now).

### ~~Core APM surfaces~~ — DONE (shipped on `jaeger-clone`)

- Home: service catalog with rate / error / p50/p95/p99 columns, delta
  chips vs. previous window, error classes, slowest trace classes,
  latency anomalies widget (ops ≥5× baseline p95), sortable columns
- Health buckets: error-rate (watch/warn/critical) + traffic_drop
  (rate fell ≥50% vs prior window) + latency_anomaly (op p95 ≥5×
  baseline). Precedence: critical > warn > latency_anomaly >
  traffic_drop > watch > healthy > idle. Row tints on Home catalog,
  halo rings on System Architecture nodes.
- Search: fixed-shape form with service / operation / tags / duration
  / limit / lookback; results table; stream-noise trace filter
- Logs: standalone log search tab with service / severity / body / limit
  / range filters; sticky facet sidebar; fills vertical viewport
- Metrics: Datadog-style explorer with metric picker, group-by
  dimensions, rate-of-counter derivation, histogram percentile
- Compare: two-trace structural diff
- System Architecture: force-directed + isometric graphs, pan+zoom,
  edge-level health, messaging edges, node hover tooltip with
  lazy-loaded operations breakdown + traffic-drop delta
- Service Detail: RED charts (rate, error, p50/p95/p99), top
  operations, recent errors, dependencies, p99 delta chip, dependency
  latencies / runtime health / infrastructure metric cards (batched)
- Trace detail: waterfall, span detail with attributes / events /
  logs / process tags / exception stack traces, trace logs tab
- Settings: dataset selection + stream-filter toggle + provisioning
  panel, persisted in pack-scoped KV
