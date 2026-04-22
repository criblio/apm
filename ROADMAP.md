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

### 1. Copilot Investigator — accuracy follow-ups

The 2026-04-12 scenario evaluation
(`docs/sessions/2026-04-12-scenario-evaluation.md`) ran five error-
injection flags paired against the UI and Investigator. The Investigator
nailed `cartFailure` (131s, exact Redis error + rendered trace) but
**missed `paymentUnreachable`** — the UI surfaces it cleanly (94% rate
drop, +88023% p95) while the agent got anchored on stale cart data and
self-inflicted flagd-bounce noise. Three gaps, impact-ordered:

1. **Traffic-drop detection pass.** Today the agent only looks at error
   *rates* and *counts*. For unreachable-service scenarios the loudest
   signal is a service whose per-minute rate collapsed to near-zero.
   Add a client-side anomaly preflight that runs before the first LLM
   turn: compute per-service rate deltas vs the prior window, inject
   "services with traffic drops >=50%" into the preamble as known
   signals. Home already does this for its `traffic_drop` health bucket;
   reuse that query.

2. **Time-window discipline.** Sequential tests bleed into each other
   because the 15-minute lookback swallows prior failures. Fix at two
   levels:
   - **Prompt:** add a "run an error histogram per minute first,
     distinguish recent from old signal" instruction to
     `agentContext.ts`.
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
   noise.

### 2. Home page: alerts surface + architecture-first layout

The home page should be the place you go to answer "what's wrong
right now?" Today the signals are there (health buckets, delta chips,
root-cause hints) but they're spread across row tints and small
pills in a table. This item reshapes the home page into an
**alerts-first experience** with the system architecture graph as
the primary visual.

#### 2a. Home page layout + Services nav item

**Home page** becomes a single scrollable page with three sections,
top to bottom:

1. **Detected issues panel** (2b) — alerts/warnings at the very top
2. **System Architecture graph** — force-directed / isometric view
   with edge-level health, messaging edges, ghost nodes, node hover
   tooltips. This is the primary visual — it answers "what does the
   system look like right now?" at a glance.
3. **Service list table** — the current catalog with rate / error /
   p50 / p95 / p99 columns, delta chips, sparklines, and investigate
   buttons. Detailed numeric view below the graph.

**"Services" nav item** — a new top-level menu entry after Home,
with a mouseover dropdown:

- **List** (default) — navigates to a standalone service list page
  (same table as section 3 of Home, but full-page for focused
  exploration, filtering, and later expansion)
- **Architecture** — navigates to a standalone System Architecture
  page (same graph as section 2 of Home, full-page for pan/zoom
  exploration)

The current separate "System Architecture" nav entry goes away,
replaced by the Services dropdown. Both standalone pages share the
same time range and health data as Home. The Home page is the
"dashboard at a glance" that shows everything together; the Services
pages are the drill-down views for when you want to focus on one
representation.

#### 2b. Detected issues panel (warnings / alerts)

When any service is in a non-healthy state, show a **detected issues
panel** prominently at the top of the home page (above both graph
and list). Each row is one detected issue:

| Signal type | Trigger | Example detail |
|---|---|---|
| **Error rate critical** | >5% error rate | `payment` error rate 12.3% (was 0.2%) |
| **Error rate warn** | 1-5% error rate | `product-catalog` error rate 2.1% (was 0.0%) |
| **Traffic drop** | Rate fell >=50% vs prior window | `payment` request rate dropped 94% |
| **Latency anomaly** | Operation p95 >= 5x baseline | `fraud-detection consume` p95 48s (baseline 0.8s) |
| **Service silent** | Was active, now zero traffic | `email` no traffic in last 15m (was 12 req/min) |

Each row shows: severity indicator, service name, signal type,
detail with before/after numbers, root-cause hint (if downstream
edge attribution is available), and an Investigate button.

**Backend**: a new scheduled search (`criblapm__home_alerts`)
materializes the current set of detected issues every 5 minutes.
It joins the existing service summary, previous-window comparison,
and operation anomaly data into a single result set of active
alerts. The panel reads from `$vt_results` cache (same pattern as
the existing home panels). When the panel is empty (all services
healthy), it collapses to a single "All services healthy" line.

Sorted by severity (critical > silent > traffic_drop >
latency_anomaly > warn), then by magnitude of change within each
severity tier.

#### 2c. Alerting system

Full design: [`docs/research/alerting-design.md`](docs/research/alerting-design.md).

Two categories of alerts working together:

- **Auto-alerts** — generated automatically from detected issues.
  No configuration needed to detect; one global setting in Settings
  to route notifications (Slack, email, PagerDuty), with per-alert
  overrides on the Alerts page. The system tracks each detected
  issue through a state machine (ok → pending → firing → resolving
  → ok) with debounce at each transition to prevent flapping.
- **User-created alerts** — persistent thresholds created via the
  UI. Each becomes a Cribl saved search with a notification target
  (Slack, email, PagerDuty, webhook). "Create alert" button on
  detected issue rows, Service Detail, and edges.

Key features:
- **Debounce**: `fireAfter` consecutive bad evaluations before
  firing (default 2), `clearAfter` consecutive good before
  clearing (default 3). Prevents flapping.
- **Suppression**: don't re-notify every cycle while still firing.
  Configurable re-notify interval (default 30m).
- **Clear messages**: when an alert resolves, send a "resolved"
  notification with total duration.
- **Alerts page**: lists all alerts (auto + user) with status,
  duration, last fired, notification target, edit/silence actions.
- **Status on Detected Issues**: each row shows alert state
  (new/firing/resolving) so you can see at a glance what's been
  alerted on vs what's still pending confirmation.

Implementation phases:
1. Alert state machine + state tracking in KV + Alerts page
2. Create Alert dialog + notification dispatch via Cribl API
3. Polish: silence/snooze, alert grouping, history, server-side
   evaluation (fires without the browser open)

#### 2d. Eval suite: detected issues + alerts validation

Before declaring item 2 complete, enhance the eval harness
(`npm run eval`) to validate the full detection-to-alerting
lifecycle:

1. Flip a failure flag → wait for 2+ cadence cycles
2. Assert detected issue appears in the panel
3. Assert alert state transitions to `firing`
4. Revert the flag → wait for 3+ cadence cycles
5. Assert alert state transitions back to `ok`
6. Assert a "resolved" event was recorded

This validates: detection → alerting → debounce → resolution
across the failure scenarios in `FAILURE-SCENARIOS.md`.

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

- "Save this view" button on Home / Search / Logs / ServiceDetail —
  writes the current filter state to a Cribl saved search with a pack
  tag
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

Items below shipped and are kept for historical reference. See git
log and linked PRs for implementation details.

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
