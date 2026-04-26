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

### 1. Left sidebar navigation

**The single biggest UX gap vs every competitor.** Replace the
horizontal top nav with a collapsible left sidebar with icons.
Every major APM (Datadog, New Relic, Dynatrace, Grafana) uses a
vertical sidebar. Our horizontal nav is out of space, hides
primary surfaces behind dropdowns, and feels like a website.

```
┌─────────────────────────┐
│ 🔍 Search (Cmd+K)      │
│                         │
│ ◉  Overview            │
│ 📋 Services            │
│ 🗺️  Service Map        │
│ ─────────────           │
│ 🔍 Traces              │
│ 📝 Logs                │
│ 📊 Metrics             │
│ ─────────────           │
│ 🔴 Alerts              │
│ ❌ Errors              │
│ ─────────────           │
│ 🤖 Investigate         │
│ ⚙️  Settings            │
└─────────────────────────┘
```

Collapsible to icon-only mode. No dropdowns. 10 items fit
comfortably. Active item highlighted. Persistent across views.

### 2. Overview page (replace Home)

The current Home page crams 6 panels into one scroll. Competitors
split these into focused views. The new Overview answers one
question: "is anything wrong right now?"

1. Detected Issues panel (compact — just the firing alerts)
2. Key metrics row: total services, req/min, global error rate, p95
3. Mini service health table (only services with issues, not all 18)
4. Recent alert events (last 5 transitions)

NOT the full service catalog (that's Services), NOT the system
architecture graph (that's Service Map), NOT slow traces/error
classes (those belong in Traces and Errors).

### 3. Errors Inbox (top-level view)

**Every competitor has this. We don't.** Promote from a Home panel
to a first-class page.

- Error groups: `(service, operation, exception.type, normalized
  stack frame hash)` — Sentry-style fingerprinting
- First-seen / last-seen / count sparkline per fingerprint
- State: new / acknowledged / resolved / ignored (stored in KV)
- Regression detection: alert when a resolved fingerprint reappears
- Sample traces + sample logs per error group
- Click through to trace detail / service detail

### 4. Service Detail tabs

The current Service Detail is a dead end — charts and tables but
no way to pivot to traces, logs, or errors for that service.
Competitors make the service page a **hub with tabs**:

- **Overview**: RED charts, summary stats, top operations, instances
  (current layout)
- **Traces**: filtered trace search scoped to this service
- **Logs**: filtered log search scoped to this service
- **Errors**: error classes for this service
- **Metrics**: service-specific metric cards
- **Dependencies**: upstream/downstream with edge health
- **Alerts**: alert history for this service

### 5. Faceted trace search

The current Search form is fixed-shape. Every commercial APM lets
users query on arbitrary attributes with autocomplete and facets.

- Typed filter builder: attribute name autocomplete → operator → value
- Multi-condition AND/OR with grouping
- Attribute value facets with counts, click to filter
- Cardinality-aware autocomplete
- "Edit as KQL" escape hatch for power users

### 6. Alert timeline with time range selection

Alerts page gains a visual timechart showing alert events over
time. Users can highlight/drag-select a time range on the chart
to filter the events table below to that window — "what was
firing between 2am and 4am?" Backed by the alert history events
in the otel dataset (`data_datatype == "criblapm_alert"`).

### 7. User-created alerts + notification dispatch

Phase 2 of alerting: "Create alert" button that persists a threshold
as a Cribl saved search with notification targets. Full design in
[`docs/research/alerting-design.md`](docs/research/alerting-design.md).

### 7. SLO budgets

Thin layer on top of alerts. SLO = saved search tracking
(success / total) over a 28-day window, plus budget burn rate
alerts at 1h / 6h / 24h windows.

### 8. Dashboards (via Cribl Saved Searches)

User-created dashboards composing multiple saved views as widgets.
"Save this view" button on Traces / Logs / Metrics / ServiceDetail.

### 9. Flame graph + critical path on Trace detail

- Flame graph / icicle chart for self-time visualization
- Critical-path highlighting (spans that drove end-to-end duration)
- Latency histogram per operation

### 10. Service catalog / ownership

Tag services with team, oncall, runbook URL, repository link.
Route alerts by ownership. Backstage-style but lightweight.

### 11. Database query performance

Top slow queries, fingerprints, execution plans. Linked to traces
via `db.statement` / `db.system`.

### 12. Live tail

Streaming logs and spans as they arrive. "Tail" button on the
Logs page.

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
