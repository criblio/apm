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

### ~~1b. UI gaps surfaced by the scenario eval~~ — **DONE**

All three items shipped (verified in the 2026-04-16 detection
coverage audit against current source):

1. **Ghost nodes** — `SystemArchPage.tsx:199-290`. `traffic_drop`
   and `silent` health buckets render dashed/outlined nodes with a
   "no traffic" badge; clickable through to Service Detail.
2. **Red rate-drop chip** — `DeltaChip.tsx` `rateDrop` mode with
   `RATE_DROP_THRESHOLD = 0.5`. Wired on Home catalog rate column.
3. **Root-cause hint** — `HomePage.tsx:378-407`. `rootCauseHints`
   map derived from outgoing RPC edges; renders `→ likely <child>`
   on anomalous rows.

### ~~1c. FAILURE-SCENARIOS.md smoke test~~ — **DONE**

PR #10 (`tests/scenarios/flagd-catalog-validation.spec.ts`) validates
`adFailure`, `productCatalogFailure`, and `llmRateLimitError`
end-to-end against the deployed pack's Cribl Search endpoint. All
three flags produce post-flip error spans. Key finding: `adFailure`
is a 10% Bernoulli trial in upstream `AdService.java`
(`random.nextInt(10) == 0`), not the hard-error pattern §6 of
`FAILURE-SCENARIOS.md` originally described. §6 has been rewritten
with a ⚠️ marker and the upstream source link.

### ~~1d. Detection coverage gaps~~ — **DONE**

The detection coverage audit (`docs/sessions/2026-04-16-detection-
coverage-and-fix-plan.md`) mapped all 15 `FAILURE-SCENARIOS.md` flags
to current UI capability. Result: **9 fully detected, 3 partially
detected, 1 design-limited, 2 out of scope.** All four proposed
fixes shipped:

| # | PR | Status |
|---|---|---|
| 1 | PR #13 `test: bump scenario 1 Recent errors timeout` | ✅ merged |
| 2 | PR #14 `fix: exempt kafka consumer ops from stream filter` | ✅ merged |
| 3 | PR #15 `perf: ServiceDetail panel caching` | ✅ merged |
| 4 | PR #17 `feat: Instances section on ServiceDetail` | ✅ merged |

Every theoretically-detectable scenario (12 of 15) now has a working
UI surface. The remaining 3 are documented limitations: `adFailure`
(10% Bernoulli rate), `llmInaccurateResponse` (semantic), and
`imageSlowLoad` (client-side / RUM).

**Operational note:** after deploying a pack version that adds new
scheduled searches, you must re-provision via Settings → Provisioning
(or a future `npm run provision` script). The deploy step only
replaces the bundle — scheduled searches are created by the
provisioner, not by the deploy.

### 1e. Eval harness design (from 2026-04-15 scoping)

Nightly off-Actions eval suite that flips flagd scenarios, drives
the deployed app headlessly, and scores detection efficacy as a
trend over time. Design scoped in `docs/sessions/2026-04-15-cicd-
and-eval-harness.md`. Open questions before implementation:

- Orchestrator host (clintdev vs. dedicated VPS)
- Dedicated Lakehouse workspace + otel-demo deployment
- Scenario list for v1 (the 9 fully-detected ✅ rows from the §1d
  coverage table)
- Result storage + trending (flat JSON in `apm-evals` sibling repo)
- Trigger + reporting (GitHub Actions cron → Checks API)
- Investigator scoring: LLM-as-judge, not local Playwright
- Scoring rule schema: parameterized, no service names in engine

**Deliverable:** `docs/research/eval-harness/design.md`. Orchestrator
code comes after review.

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

### ~~Scenario detection & test harness (1b-1d)~~ — DONE

- **UI gaps** (§1b) — ghost nodes, red rate-drop chip, root-cause
  hint: all three shipped. Verified against source in the 2026-04-16
  coverage audit.
- **Flagd smoke test** (§1c) — PR #10
  `tests/scenarios/flagd-catalog-validation.spec.ts`. Also surfaced
  `adFailure`'s 10% Bernoulli rate (upstream `AdService.java`).
- **Home panel cache-miss fallback** — PR #8. When the scheduled
  search for Error classes returns empty, fires a live query
  fallback; adds a "cache Nm stale" chip on the panel header.
- **Trace waterfall clock-skew resilience** — PR #9. `buildTimeline`
  now anchors the chart scale to the root span so a single clock-
  skewed child (e.g. the PHP quote service's ~1s offset) doesn't
  blow the waterfall scale. Out-of-window spans render as warning
  rows instead of invisible negative-offset bars. Root cause
  diagnosed as the PHP OTel SDK's `SystemClock::now()` caching a
  stale `microtime()` reference after an NTP step.
- **ServiceDetail panel caching** — PR #15. Mirrors the Home panel
  cache pattern for ServiceDetail: reads top-operations, recent
  errors, summary, time series, and dependencies from `$vt_results`
  in one batched query (~1-2s) instead of six uncached live queries
  (10-20s). Only one new scheduled search (`criblapm__svc_operations`)
  — the other five panels reuse existing Home + SysArch caches.
- **Kafka consumer stream-filter exemption** — PR #14. Operations
  matching `consumed|Consume` bypass the idle-wait stream filter so
  kafka lag traces surface in the Slowest trace classes panel during
  `kafkaQueueProblems` scenarios.
- **Playwright e2e framework** — PRs #4-#7, #13. Auth0 login,
  host-global injection, flagd-ui client, Cribl Search helper,
  scenario 1 spec with cache-path exercise at `-1h`, flagd catalog
  validation spec with post-flip `_time` filter.
- **Documentation consolidation** — PR #12. ROADMAP.md is the single
  source of truth; six session docs marked stale; FAILURE-SCENARIOS
  known-gaps table pruned of three already-shipped items.

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
