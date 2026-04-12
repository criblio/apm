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

### 1. AI-powered investigations (Copilot Investigator) — **IN PROGRESS**

Cribl Search ships a "Run an Investigation" feature (Copilot
Investigator) that takes a natural-language prompt about a problem,
runs AI-guided queries against the data, and produces a structured
finding. We're embedding this capability throughout Cribl APM so
users can drill into problems with one click.

**Status snapshot:**

- ✅ API spike + protocol docs
  ([`docs/research/copilot-investigator.md`](docs/research/copilot-investigator.md))
- ✅ A/B comparison confirming context pre-fill dramatically
  improves accuracy and time-to-root-cause
- ✅ Foundation + standalone `/investigate` route (PR #14, branch
  `copilot-investigator`). Agent client, context builder, tool
  dispatcher, loop orchestrator, chat UI — all shipped.
- ✅ Verified end-to-end: agent runs real searches via `run_search`,
  uses our field mappings correctly, found `payment-786d4cc9bd-k56jj`
  Invalid-token exception to `charge.js:37:13` in ~2 min
- 🟡 `present_investigation_summary` renders as raw `{% ... %}` text
  in the transcript — needs dedicated "Final Report" card
- ⬜ Integration points (each a follow-up PR):
  - "Investigate" button on Home catalog rows (service + health
    bucket + delta signals)
  - "Investigate" on System Architecture edges (parent+child +
    call count + error rate)
  - "Investigate" on System Architecture nodes (service-level)
  - "Investigate" on Service Detail (service + top anomalous ops)
  - "Investigate" on Trace Detail (trace ID + error spans)
  - Anomaly widget row click → pre-filled investigation

This leapfrogs the "Natural language / AI query" roadmap item
previously listed as a side note — we get it by building on Cribl's
existing AI infrastructure rather than wiring up our own LLM
integration.

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
