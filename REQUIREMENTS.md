# Cribl APM — Requirements

This document captures what is necessary to recreate Cribl APM from
scratch: (1) the functional requirements, (2) the Cribl App Platform
development learnings that make the app performant and resilient, and
(3) the non-functional requirements. It condenses the codebase, the
session logs (`docs/sessions/`), the research docs (`docs/research/`),
`HEURISTICS.md`, `FAILURE-SCENARIOS.md`, and `docs/cribl-app-skill/skill.md`
as of 2026-08-19. Where a rule exists because something broke, the
failure is named.

Two principles govern every requirement below:

1. **Lean on Cribl Search.** The platform already provides saved
   searches, scheduled searches, alerts/notifications, KQL, and a
   pack-scoped KV store. Build a domain UI on top of those primitives.
   Do not reinvent them. Users must not need to know a KQL editor is
   underneath; power users get an escape hatch.
2. **The platform must not fail silently.** Every layer that can
   corrupt quietly — KQL generation, provisioning, lookup exports,
   generated-event contracts — gets a tripwire. Empty data must render
   as "unknown", never as "healthy".

---

## 1. Functional requirements

### 1.1 Product definition

- A Vite + React + TypeScript SPA, packaged as a versioned Cribl App
  pack (`apm-X.Y.Z.tgz`), running in a sandboxed iframe inside a Cribl
  Cloud workspace.
- Read-only UI over telemetry that already exists in a Cribl Search
  dataset (default `otel`). The app ingests nothing and stores no
  telemetry.
- Data contract: OTel spans with `end_time_unix_nano` populated; logs
  with a `body` field; metrics rows with `datatype == "generic_metrics"`.
- Target: customer-installable on arbitrary Cribl Cloud workspaces. The
  OTel demo is the test fixture, not the product boundary. No service,
  operation, or flag names in `src/` or provisioned queries.
- Onboarding: land OTel data → install pack → set dataset → run
  Configuration → Setup (provision scheduled searches, apply dataset
  acceleration) → wait one cadence → open Overview. A Setup status card
  must show green when both provisioning steps complete.

### 1.2 Pages

All routes wrap in a resilience boundary. Route table:

| Route | Function |
|---|---|
| `/` | Overview: detected issues, KPI tiles, services-needing-attention table, recent alert events, quick links. |
| `/services` | Service catalog: sortable table with rate/error/percentiles, sparklines, delta chips vs prior window, health tint; slowest trace classes; error classes; operation anomalies; auto-refresh selector. |
| `/map` | Service map: force-directed dependency graph with per-node health halo, log-scaled node size, edge health, messaging (Kafka) edges, ghost nodes for silent services, pan/zoom, pinnable tooltips, isometric variant. |
| `/traces` | Trace search: typed filter builder, raw KQL predicate escape hatch, faceted rail, Spotlight rail (default tab); full state round-trips through the URL. |
| `/trace/:id` | Trace detail: waterfall span tree, span detail, correlated logs tab, Investigate button seeded with the trace. |
| `/compare/:a/:b` | Structural trace diff: added/removed/changed spans with duration deltas. |
| `/logs` | Log explorer: service, severity tier (OTel 1–24 scale), body text, lookback, limit. |
| `/metrics` | Metrics explorer: catalog-driven picker, type detection (counter/gauge/histogram), smart default aggregation, client-side rate for counters, group-by top-N series. |
| `/alerts` | Incidents section (drill-in layer), brush-selectable alert timeline, alert episodes (paired firing→resolved), currently-active table; 30 s silent refresh. |
| `/incident/:id` | Warroom: deterministic summary narrative, investigation findings, member services with per-signal detail, interleaved timeline, note composer, status/severity/close/reopen controls. |
| `/errors` | Grouped error classes (service/operation/message) with inline Spotlight expansion scoped to the failing operation; click-through to pre-filtered trace search. |
| `/investigate` | Investigator. Client mode: in-browser agent chat. Server mode (flag): recall sidebar, replayable server investigations, follow-up composer. |
| `/configuration` | Settings (must NOT be at `/settings` — host intercepts it). |
| `*` | Not-found page with recovery link; legacy-route redirects. |

Service Detail (`/service/:name`) is a hub, not a dead end: RED hero,
operations table, dependencies, error classes, per-instance breakdown,
Spotlight, alert badge with 30 s polling, Investigate button.

### 1.3 Cross-cutting UI systems

- **Time range**: shared `?range=` URL param across all views; each
  range defines its chart bin width; `previousWindow()` derives the
  comparison baseline. Drill-downs preserve the window.
- **Non-destructive refresh**: keep existing data visible during
  refetch; skeletons only on first load; per-panel in-place updates;
  thin progress indicator. Never set all loading flags true on refresh.
- **Query generations**: every page fetch starts a new generation that
  aborts the prior generation's in-flight search jobs (frees worker
  slots) and guards all async `setState` against staleness.
- **Graph stability**: recreate the force simulation only when a
  topology key (node ids + link endpoints) changes; data-only updates
  mutate in place.
- **Health vocabulary**: one shared bucket set — healthy / watch (<1%)
  / warn (1–5%) / critical (>5%) / idle / silent / traffic_drop /
  latency_anomaly — with fixed precedence, one color each, used
  identically on every surface.
- **Delta chips**: current window vs previous window for rate, error
  rate, p95, p99. Rate drops ≥50% render red, not neutral; surges
  render neutral (informative, not bad).
- **Stale-data honesty**: cached panels show a "last updated N ago"
  chip past 3× cadence; rows whose newest span is older than 25% of the
  lookback get a stale pill; failed panels render "unavailable" with
  Retry, with the copy "empty values are not evidence of health."
- **Root-cause hints**: catalog rows aggregate outgoing edges and
  render "→ likely <child>", so a propagation cascade reads in seconds.
- **Service identity color**: deterministic hash hue per service name,
  used for every link, node, and chart series.
- **Investigate affordance**: a seed-carrying button on every surface
  (catalog rows, errors, traces, alerts, incidents, graph tooltips).
  Seeds carry known signals so the agent starts with the anomaly, not
  discovery.
- **Cross-linking everywhere**: alert → service, error → trace, trace
  → investigation. One job per view; load order matches display order.

### 1.4 Spotlight (attribute analysis)

- Purpose: given a selection of spans (e.g. errors), rank the
  attributes whose value distribution most separates selection from
  baseline. Equivalent to Honeycomb BubbleUp; do not use that name.
- Metric per value: selection rate = `selN / (selN + baseN)` — one
  number, rendered as a bar whose width is the rate. No sel/base/diff
  jargon, no histograms.
- Attribute score: `max over values of |valueRate − overallRate| ×
  log1p(valueTotal)` — L∞ deviation, evidence-weighted. This beats
  volume-weighted variance because the typical signal is one small but
  extreme value ("one pod is broken").
- The baseline must be scoped to the same service/operation as the
  selection. An unscoped baseline answers "what makes this service
  different from other services", which is the wrong question.
- Stream results per attribute as each query returns; do not wait for
  the full fan-out. Cap concurrency (semaphore of 4). Use a curated
  ~9-attribute set on embedded surfaces; the full ~27 set only on the
  dedicated Traces rail. Gate the fan-out on a real predicate and on
  scroll-into-view.
- Include origin attributes (`k8s.pod.name`, `peer.service`,
  `error.type`, top-level `name` and `kind`). Exclude response status
  codes when the selection is errors (tautological).
- Every value gets a "Search →" link into pre-filtered trace search.
- Empty result copy must say "everything matches between failing and
  healthy", not "nothing found".

### 1.5 Scheduled searches (the compute layer)

All server-side compute is provisioned scheduled searches with a
reserved ID prefix (`criblapm__`), reconciled from a declarative plan.
Cadence is user-configurable (default 5 min); dependent searches offset
by +1 to +4 minutes so outputs land in order (evaluator +1, notify +2,
incident grouper +3, incident fold +4).

Required search families:

1. **Panel caches** (→ `$vt_results`, read back in one batched query):
   per-service summary, time series, slow traces, error spans, error
   propagation rollup, RPC dependencies, messaging dependencies,
   per-operation rollup, metric catalog (hourly), 7-day alert history,
   daily noise budget.
2. **Alert pipeline**: previous-window baseline (→ lookup), evaluator
   (state machine, commits immutable events via `export tee=true to
   search`), notify search (flag-gated, feeds the cell).
3. **Incident pipeline**: grouper (firing transitions → opened/attached
   events), incremental state fold, lookup export.
4. **Lookup producers**: operation baselines (24 h percentiles, 6 h
   cadence), trace originators (hourly), attribute catalog (split
   compute + export steps), 6-day error-rate history (daily, pivoted to
   one row per service), deploy events (new service+version tuples).
5. **Metric emitters** (flag-gated): request/edge/messaging counters
   labeled by outcome, status-class counter (7 classes), and
   precomputed percentile gauges (one search per family × quantile).
   Windows must be minute-aligned and strictly disjoint — the metrics
   store is not idempotent.
6. **Seed lookups**: pre-create every lookup with a sentinel row before
   any search references it. Seeds start with `print`, not a dataset
   scan (an empty scan writes a header-only or missing CSV).

### 1.6 Detection heuristics

Heuristics are product semantics. Backend, metrics, alerts, and UI must
agree: a rule that filters noise from a panel must filter the same
noise from the metrics that feed alerts. The anti-pattern is "filter
the rows the panel displays."

- **Trace-originator classification**: classify each trace-root service
  as user / service / unknown (user-agent regexes, `messaging.system`,
  span-name patterns; ≥50% majority with ≥10 roots). Manual overrides
  in settings. Unknown is never filtered (conservative bias).
- **Error filter rules** (shipped enabled, per-rule toggles): drop user
  -trace HTTP 4xx; drop user-trace gRPC caller-fault codes (keep
  UNAVAILABLE/DEADLINE_EXCEEDED/INTERNAL always); drop propagation
  non-leaf errors (`has_error_child` via self-join on
  `parent_span_id`). Rules require an explicit scope ("for whom?").
- **Entry-span scoping**: RED aggregates use SERVER + CONSUMER spans
  only. CONSUMER is required — pure message-driven services emit only
  kind 5. Aggregating all kinds understated checkout p95 by 15×.
- **Stream/noise filter**: suppress idle-wait span shapes (>30 s root,
  child ratio <10%) from percentile aggregates, with an operation-name
  exemption for Kafka consumer patterns (matched on operation, never
  service — the filter was suppressing the Kafka scenario's own signal).
- **Errors attribute to the server side of a span**, so the loudest red
  row is usually a caller, not the cause. Root-cause hints and the
  graph exist to correct for this.
- **Ghost nodes**: a service that goes dark must stay on the map with
  a "no traffic" treatment. Each node is judged against its own
  baseline; there is no important-services list.
- **Per-instance breakdown** (`service.instance.id`) is required for
  single-pod failure modes; one leaking pod dilutes into the service
  aggregate.
- **Status-code mix** is a first-class diagnostic: bucket into
  503/504/502/500/other-5xx/4xx/grpc per minute. 503 → capacity;
  504 → upstream timeout; 500 → upstream bug. Shifts in the mix are
  themselves evidence.
- **Slope/drift detection** is the only mechanism that catches smooth
  climbs (0→50% over 11 days). Use linear fit slope + R², not ML.
  Threshold loosening was proven three times to be the wrong tool for
  gradual onset.
- **Cardinality watch**: hourly `dcount()` over fingerprint-prone
  attributes (`session.id`, `user.id`, …) into a lookup with slope and
  linearity. Never computed at page-load time.
- All thresholds are ratios and deltas against learned baselines, never
  absolutes tied to one service. A `if (service === 'payment')` branch
  means the approach is wrong.

### 1.7 Alerting

- **Zero-configuration auto-alerts** derived per evaluation cycle:
  error rate, traffic drop, silent service, latency regression
  (service-level and per-operation), with an opt-in low-volume arm.
- **Detection window is -15 m against a -2h..-1h baseline.** A -1 h
  window dilutes a fresh burst below threshold; this single change
  moved five eval scenarios at once.
- Production-tuned error thresholds: ≥5% absolute at ≥20 requests; or
  ≥2% at 3× baseline with ≥100 baseline requests; or ≥10 errors on a
  previously clean service. Low-volume arm: ≥2 errors and ≥1% with a
  clean baseline (the baseline gate makes the low floor safe).
- Latency arm: `curr_p95 ≥ 3 × prev_p95 AND curr_p95 ≥ 100 ms`
  service-level (floor chosen from live probe data); 250 ms floor
  per-operation. Known gap: a sustained regression normalizes into the
  rolling baseline after ~2 h; the fix is a sticky baseline frozen
  while firing.
- **State machine**: `ok → pending → firing → resolving → ok`,
  fireAfter=2, clearAfter=3, plus pending→ok (flap, no resolved event)
  and resolving→firing (relapse, no fire_count increment). Alert id is
  `auto:health:<svc>` — stable per service, not per signal, or the
  resolving walk never completes.
- **Exactly-once**: one immutable evaluator snapshot per cycle with an
  `evaluation_id`; prior state is read from the newest committed event,
  never a mutable lookup; a retry inside the same cadence bucket is
  detected and dropped. Never run multiple copies of the state machine
  against shared mutable state on one cron.
- **Generated-event contract**: every event written back to the
  dataset carries `schema_version`, a stable `event_id`, `producer`,
  and a `record_kind` discriminator (`evaluation` / `incident` /
  `investigation` / `deploy`) so reader families are blind to each
  other. Readers dual-read the platform's stored field name
  (`data_datatype`) and the legacy name.
- `is_persistent` (chronic baseline error rate) is informational —
  marks, never suppresses detection.

### 1.8 Incidents

- An incident is a lightweight warroom above alerts, not a new
  top-level concept. It must work with the server investigator off:
  event-sourced in the dataset, grouped by a saved search, current
  state materialized to a lookup. Never store incident state in app KV
  (browser-only writer; unreadable by machine tokens).
- **Grouping**: a firing transition attaches to a live incident by
  member-service lookup, else by single-hop dependency-graph adjacency
  — but adjacency only to OPEN incidents opened within the last 60 min
  (both guards learned live: a resolved incident was resurrected by a
  neighbor's flap; a long-open incident absorbed unrelated faults).
  Otherwise open a new incident with a deterministic time-binned id
  (`inc:<bin(fire_time, 15m)>`) so retries collapse. Over-coalescing is
  the deliberate bias; a supervisor can split later.
- **State fold** is incremental: previous own `$vt_results` output +
  a 1 h event delta, deduped by event_id, gated by per-member
  high-water `_time` marks. Carried state is authoritative for title,
  root, and `opened_at` (late members otherwise corrupt them).
  Liveness joins the evaluator's latest run per member.
- **Lifecycle**: open → investigating → identified → mitigated →
  resolved → closed. All-clear + 10 min debounce → resolved; 24 h
  quiet → closed; a member refire reopens; only closed permits a new
  incident. Derived resolution supersedes a stale human status; human
  severity overrides always win.
- **Warroom writes** (notes, status, severity, close/reopen) commit as
  dataset events from the browser — no cell dependency. Human event
  ids carry a nonce (two identical notes are two notes);
  `investigation_linked` ids are deterministic (relink is a no-op).
  The UI updates optimistically and states plainly that folded state
  lags one cadence.
- The incident page windows its event scan from the incident's own
  age, never a fixed wide range.

### 1.9 Investigator

- **Client mode**: an agent chat embedded in the app, using read-only
  tools (`run_search`, `run_metrics_query`, `render_trace`,
  `update_context`, `present_investigation_summary`), rendered through
  a pure `applyLoopEvent` reducer with custom result cards (trace
  waterfall, metrics chart).
- **Context is the product.** Pre-fill: dataset description ("pre-
  parsed JSON — do not regex `_raw`"), field mappings from the query
  layer, service topology, current anomalies, and KQL dialect notes.
  The A/B spike: bare agent never completed; enriched agent completed
  in 472 s with a deeper root cause. Every surface's Investigate
  button injects its known signals into the seed.
- **Playbook requirements** (each added after a live failure): open
  with traffic-drop checks and per-minute error histograms; hold
  "origin vs propagation" as an explicit concept; a latency-anomaly
  branch (p99 vs p95, bimodal patterns, stalled consumers); a leak-
  fingerprint branch (monotonic slope + old pod + healthy downstream);
  deploy-boundary confounder enumeration weighted by hot-path overlap;
  pod uptime is a leak signal only when the pod predates the trend;
  rank all viable hypotheses with relative confidence rather than
  single-picking; fail fast after two zero-row drill-downs; stop
  validating once the answer is found. Summaries must state a
  predicted effect with magnitude and metric, plus a verification step
  and a re-invoke instruction if disconfirmed. No auto-remediation.
- `maxTurns = 12`: an unconverged investigation is circling, and long
  histories push LLM time-to-first-byte past the proxy's 30 s limit.
- **Server mode (cell)**: a Worker + Durable Objects service (celld)
  that runs the same investigation autonomously when an alert fires.
  Requirements:
  - A singleton coordinator admits triggers, dedupes on `event_id`
    (SQLite UNIQUE), caps concurrency (1 autonomous) and per-hour
    volume, and polls the firing-alert query on a durable alarm
    (webhook delivery is retained but proved unreliable platform-side).
  - One DO per investigation; the agent loop is alarm-driven — one
    turn per alarm (celld kills handlers at 300 s; per-turn commits
    survive SIGKILL and resume on a fresh node).
  - Seed parity by construction: the cell imports the same seed
    builder, preflight, and tool executors as the browser.
  - Rendering parity by construction: the cell maps agent events onto
    the same `LoopEvent` union with the same `ui` payloads; the UI
    replays via `?since=seq` polling.
  - The Alerts page never contacts the cell: lifecycle events
    (`started`/`investigated`/`investigation_failed`) are committed to
    the dataset and badges render from dataset reads.
  - Interactive mode: investigations park at `idle`, resume on user
    messages, never auto-conclude; user turns are persisted so replays
    show both sides.
  - Code tools (server-only, read-only): lazy tarball checkout plus a
    generated recent-commits file, list/read/grep, with size and file
    caps, streaming untar, and yields to the request queue. Prompt
    addendum: consult code only after telemetry names a service; cite
    file paths and line numbers.
  - Persisted event caps (series, points, rows, bytes) — unbounded
    tool payloads eventually wedge the DO's SQLite reads.
  - Fail closed on missing auth secrets; per-node `DISABLED` kill
    switch answers 202-and-drop so the sender does not retry.

### 1.10 Settings and provisioning

- Settings sections in order: Setup (provisioning panel, dataset
  acceleration, metrics backfill) at the top; Workspace (dataset,
  cadence, low-volume mode, server-investigations config incl. cell
  URL/tokens/source repos); Filtering & heuristics; Diagnostics
  (originator classification audit, collapsed).
- Settings persist to pack-scoped KV (PUT as `text/plain`). Flags are
  module stores exposed via `useSyncExternalStore`. Two flag classes:
  provision-time (baked into search KQL — dataset, cadence, low-volume,
  metrics emit, server investigations; changing them requires
  re-provision, and the UI must say so) and read-time (immediate).
- The provisioner diffs the declarative plan against the server and
  creates/updates/noops/deletes only prefix-owned searches. UI
  provisioning and CLI provisioning must run identical code — a shared
  module invoked by both (divergence shipped a search with no
  notification binding).
- The CLI cannot read app-scoped KV. It must infer flag-gated searches
  from server state when no explicit override is set — a defaulted
  flag deleted the notify search out from under a flag-on UI.
- Deploy = build + package + upload + reconcile + guard + canary, one
  command.

### 1.11 Eval harness

- A scenario-driven detection eval (`npm run eval`): flip a flagd
  fault flag, wait for telemetry, drive the deployed UI headless,
  assert surface locators and server-side KQL state, optionally score
  the Investigator, flip off, cool down. Scenarios are ~40-line
  declarations; the engine contains no service or flag names.
- Score = surface 0.7 + investigator 0.3. Investigator scoring is
  LLM-output-vs-regex: 1.0 completed + root cause matched, 0.5
  completed, 0 otherwise. Signal-type-aware checks (a traffic surge
  scenario must not assert error alerts).
- Scenario isolation is mandatory: close all open incidents before
  each scenario; reset alert state between runs; flip flags off in
  `finally`; enforce cooldowns (a full lookback of quiet). Residual
  state both inflates scores and masks regressions.
- Results are events in a dedicated Cribl dataset, trended in a Search
  notebook; also logged locally as JSONL so a failed ingest never
  loses a run.
- The eval's purpose is trend over time (did this change move scenario
  X), not pass/fail gating. It does not run in CI.
- Keep negative controls: an all-flags-off run (hallucination check)
  and undetectable scenarios (semantic wrongness, client-side-only)
  scored as limitations, not targets.

---

## 2. Cribl platform learnings

What the App Platform provides, and every trap found while building on
it. Items marked ⚠ fail silently.

### 2.1 App platform surface

- Host injects `window.CRIBL_API_URL` and `window.CRIBL_BASE_PATH`;
  React Router must use `basename={CRIBL_BASE_PATH}`. Without the
  shell both are unset and no route matches (blank `#root`).
- The platform wraps and locks `window.fetch`: it injects the auth
  bearer, scopes KV and proxy URLs to the app, and routes external
  domains through the proxy per `proxies.yml`. The app never handles
  tokens.
- Proxy limits: 30 s time-to-first-byte per request (the stream runs
  to completion once started — this is what caps LLM turn latency),
  100 requests/min per app, HTTPS only, SSRF-guarded, hop-by-hop auth
  headers always stripped (inject auth via `headers.inject`, including
  `kv.<key>` lookups against encrypted KV).
- ⚠ Undeclared-domain calls return a JSON error body, not a network
  error.
- ⚠ `proxies.yml` has a server-side `local/` override keyed to the app
  id. It shadows the packaged file, survives redeploys and even
  delete+reinstall, and is not API-writable. Symptom: "domain not
  declared" while the pack is correct. Prove with a throwaway app id;
  fix by clearing server-side state.
- Iframe sandbox: no downloads, no popups, no `blob:` images (use
  `data:`), no cross-origin frame access. Document CSP is
  `connect-src 'self'` — **WebSockets from the iframe are blocked and
  proxies.yml cannot loosen it.** Any streaming need becomes short
  polling through the fetch proxy (proxied fetches are same-origin
  after rewrite, hence CSP-clean).
- Routing: never use a route containing `settings` (host intercepts).
  The platform serves the SPA only at its base path — deep links 404
  as JSON; navigation must happen in-app. Ship a root error boundary
  and a wildcard recovery route.
- KV store: pack-scoped; PUT values as `text/plain` (⚠ JSON
  content-type serves back `[object Object]`); GET of a missing key is
  404 (treat as null). ⚠ App-scoped KV is unreadable by machine tokens
  ("App context required") — nothing server-side or CLI-side may
  depend on reading app settings.
- All `/search/*` endpoints require the `default_search` group prefix
  (`/m/default_search/...`).
- ⚠ Pack install no-ops when the installed version equals the pack
  version. Every deploy that must land requires a version bump.
  Browsers also cache the bundle across deploys.
- There is no install-time hook and no official TypeScript SDK for
  Search saved searches; provision via REST from a first-run panel and
  a CLI.

### 2.2 KQL caveats

Crashes:

- `(?i)` inline regex flag crashes complex pipelines (summarize +
  extend + nested negation). Use character-class alternation
  (`[Cc]onsume`).
- `summarize → summarize max(iff(...))` crashes on real data (passes
  on synthetic rows). Split into separate searches joined via lookups.
- `countif(not <bool>)` trips a parser bug. Scientific notation and
  inline math inside function args fail to parse — compute in a prior
  `extend`.
- `| send group="default_search"` crashes; use `group="search"`.

Silent corruption (⚠ all of these report success):

- `(?i)` upstream of `export to lookup` writes an unjoinable CSV.
- `mv-expand` upstream of `export to lookup` breaks the write. Split
  into a compute search plus an export search that reads `$vt_results`.
- A trailing `| sort` after a deep join pipeline returns zero rows.
  Folds and exports never sort; readers sort client-side.
- `project/extend _time=<column>` after a `union` nulls `_time` on the
  subquery branch. Put a materializing sort barrier between them.
- `leftouter` join truncates matches at scale (implicit row cap on the
  right side). Use `inner`, or pre-aggregate the right side.
- Naive error-propagation self-joins inflate counts with fan-out;
  pre-aggregate by `(trace_id, parent)` first.

Unsupported / dialect:

- `summarize` not `stats`; `sort by` not `order by`; no `any()` (use
  `max()`); no `percentileif()`; no dynamic field access
  (`attributes[col]`); `lookup` returns one row per key (pack series
  into columns of a single row); `foldkeys` output is untypeable (use
  `_raw` regex for field discovery); `| send "URL"` is silently
  unsupported; documented `jobName=[...]` array literals do not parse
  (use `where jobName in (...)`).
- Dotted OTel fields must be bracket-quoted:
  `tostring(resource.attributes['service.name'])`. `status.code` is
  the string `"2"`. Top-level columns (`name`, `kind`) are not under
  `attributes`. `status.message` may live on the caller's client span,
  not the erroring server span — fall back to the parent. HTTP status
  is split across `http.status_code` and `http.response.status_code` —
  coalesce both.
- Cumulative-temporality histograms store running sums;
  `percentile()` over them is nonsense. Metrics are wide-column
  (bracket-quoted field per metric name).

### 2.3 Persistence primitives

Three mechanisms, allocated by role:

| Primitive | Role | Key facts |
|---|---|---|
| `$vt_results` | Panel caches; carried fold state | Free to write, ~1 s to read regardless of source cost; retention keepLastN=2; reading is itself a search job; readers MUST narrow to the newest jobId (⚠ stale runs double-render and hold wrong state). |
| `export to lookup` | Join targets, baselines, current-state read models | Sub-millisecond joins inside running queries; 10 k row cap; atomic overwrite; must exist at search-creation time (seed first); ⚠ the export "consumes" rows (they do not also reach `$vt_results`). |
| `export tee=true to search` | Durable event logs (alerts, incidents, investigations, deploys) | One commit is both the durable event and the UI-readable row; append-only; searched as a normal dataset. |

Patterns that must be reproduced:

- **Sentinel-first union**: `print <sentinel> | union (<pipeline>) |
  export …` — ⚠ the planner skips the export tail when the base scan
  returns zero rows.
- **Incremental folds**: read your own previous output (max-jobId
  self-join — the epoch-millis prefix makes string max the newest),
  merge a short delta window, dedupe on event_id, gate on per-key
  high-water `_time` marks. A full-history refold re-saturates the
  worker pool. Carried state is only visible within the search window;
  a longer pause restarts the fold from the delta (a daily
  reconciliation search is the durable fix).
- **CQRS**: events are the write log and audit; hot pages read a
  materialized lookup; history is searched on demand; ad-hoc
  exploration is live search; numeric series belong in the metrics
  store.

Metrics store (`export to metrics` / PromQL):

- Two disjoint stores exist: the fast PromQL store and lakehouse
  `generic_metrics` events. OTel metrics land in the slow one; the
  PromQL engine binds only to the fast store. Emit your own metrics to
  get fast reads.
- Metrics reads are synchronous GETs — no search job, no worker-pool
  slot. This is the reason to migrate hot panels to metrics.
- ⚠ The store is not idempotent: re-emitting a bin double-counts.
  Emitter windows must be minute-aligned and disjoint; backfill must
  derive gaps from the store itself (probe earliest coverage, fill
  newest→oldest), never from a side marker.
- ⚠ `typeField` accepts counter/gauge only; histogram must be the
  literal `type=histogram` param — otherwise 100% of events drop as
  `invalid_type` while the job reports completed. Always read the
  export output table (`eventsOut` / `dropReasons`).
- ⚠ After `summarize ... by bin(_time, 1m)` the time column is
  `bin_time_1m`; a wrong `timeField` registers the metric with zero
  samples. Rename to `_time` first.
- Counters store per-bin deltas: read with `sum_over_time`, never
  `rate()`/`increase()` (except inside `histogram_quantile`).
- Auto-bucketed histograms cannot resolve bimodal latency (p95 read
  19 ms when the truth was 3 s). Emit precomputed percentile gauges
  per (family, quantile) — one search each, since multi-percentile
  exports drop rows — and read with `avg_over_time`. Averaging
  percentiles across bins is an accepted approximation; document it.
- `rate()` needs ≥2 samples in its window: floor range-vector windows
  at 5 m for 1-minute-emitted series. `histogram_quantile` costs
  ~710 ms fixed per query; counter reads ~114 ms — design page loads
  around counts-first.
- ⚠ Aborting a metrics GET does not stop the server computing it.
  Cancel KQL search jobs (frees a worker slot); dedupe + short-TTL
  cache idempotent metrics GETs instead of cancelling them.

### 2.4 Saved searches, notifications, alerts-as-searches

- Saved searches ARE scheduled searches ARE alerts: `schedule.enabled`
  plus a notification makes an alert. All responses are wrapped
  `{items, count}` — including by-id GETs.
- ⚠ A by-id GET of a missing object returns `200 {items:[], count:0}`,
  not 404. Check `count`, or you will PATCH a ghost.
- ⚠ `schedule.notifications` written on the search body is silently
  dropped (server stores `{}`). Notifications are a separate resource
  (`/m/<group>/notifications`); the binding requires `id`, `disabled`,
  `conf.savedQueryId`, and `targetConfigs[].id` — omit one and the
  item silently vanishes.
- Notification targets are workspace-level, API-manageable with a
  machine token, and support JS-expression payload templating — shape
  the POST at the target, not the receiver. ⚠ The API echoes webhook
  bearer tokens in plaintext to admins: scope such bearers to one
  idempotent, kill-switchable endpoint.
- ⚠ Webhook delivery can break silently platform-wide with no log
  surface (observed 2026-08-15; a pre-existing unrelated notification
  also died). Never make push delivery the only trigger path: pair it
  with a poll over the same admission/dedup path, and dedupe on a
  stable event id at the receiver so both paths coexist.
- ⚠ Webhook bearer drift (receiver redeploy rotates the secret) is a
  silent 401. Provision the secret from one source of truth.

### 2.5 Capacity and scheduling

- The workspace has a ~20-concurrent-search-job ceiling; the tail gets
  429s. Queue wait dominates runtime (0.7 s searches waited 20 s+;
  observed waits up to 22 minutes). Configured cadence is not the
  delivered freshness.
- Consequences: batch all panel-cache reads into one query; cap
  client fan-out with a semaphore; run one live query per page before
  anything heavy; gate below-the-fold work on scroll; audit cadences
  (don't recompute immutable history hourly); consolidate searches
  that scan the same window into one wide aggregation plus cheap
  derived readers.
- Resource exhaustion presents as Cribl-internal errors ("Unexpected
  'reset' signal") that only occur on the scheduled path under load —
  the same KQL succeeds ad hoc. Reduce input volume (row-explosion
  pipelines like `bag_keys`+`mv-expand` multiply ~20×) before blaming
  the query.
- ⚠ A poisoned baseline silently disables a detector: baselines
  computed during an incident capture the incident as normal. A newly
  slowed cadence leaves its lookup empty until first run — consumers
  need an explicit "baselines still computing" state.

### 2.6 Provisioning discipline

- Reconcile from a declarative plan; own only prefix-named searches;
  seed lookups first; run a **provision guard** (pure string checks,
  gates every deploy): non-empty `dataset=` clauses, no `(?i)` or
  `mv-expand` upstream of an export, no empty lookup names, valid
  saved-search names. Strip KQL comments before checking; make checks
  positional (only upstream of the export).
- Run a **post-reconcile canary** for what static checks cannot see:
  sentinel `$vt_results` has rows; a known lookup actually joins (the
  June 2026 outage shipped an unjoinable CSV that reported success at
  every layer); the generated-event contract round-trips through the
  same query each consumer uses.
- ⚠ The dataset store defaults to empty string. An unreachable KV once
  baked `dataset=""` into 17 searches with green output at every step.
  Default the dataset before planning; guard the plan.

---

## 3. Non-functional requirements

### 3.1 Resilience

- Every route and major panel isolates failures in a boundary with
  Retry. A failed query renders "unavailable/unknown" — never an empty
  collection that looks healthy. Stale requests must not win; missing
  data must not present as healthy.
- Every cached surface carries freshness metadata (source job, age,
  last error) and serves last-known-good with a stale badge. Cache
  misses fall back to a live query — for that panel only, over a tight
  window (-15 m), not the user's full range.
- Detect zero-row, missed, queued, failed, stale, and schema-invalid
  scheduled jobs individually; one sentinel is insufficient.
- Migrations are dual-read and forward-only where the store is not
  idempotent; every phase independently shippable and revertible;
  side-by-side agreement gates deletion of the old path.
- State machines that matter exist as pure TypeScript with transition
  tests pinning the KQL behavior.
- Server components: alarm-driven work units with per-unit durable
  commits (survive SIGKILL and node replacement); dedupe at admission
  on stable ids; graceful shutdown; streaming over buffering with caps
  and yields in single-threaded runtimes; treat the durable dataset
  commit as the record of truth, not local state.

### 3.2 Security

- One read-only KQL boundary: typed serializers for every untrusted
  value entering a query (datasets, strings, identifiers, numbers,
  times, trace/span ids, predicates). The advanced editor accepts a
  predicate only; pipeline and side-effect operators are rejected.
- Agent tools are guarded at execution time (`assertReadOnlyKql`),
  never by an approval prompt or a model-controlled flag. Treat
  telemetry values as data, not instructions; cap result bytes and
  rows; hostile-string and prompt-injection tests.
- Least privilege and product honesty: ship a pinned proxies manifest
  (release tooling diffs the packaged file against a committed
  expected copy and fails on any extra domain/path/header); no dead
  settings; never claim dispatch a feature does not perform.
- Secrets: cell-side secrets in the cell's secret store; the UI→cell
  bearer in encrypted KV injected by the proxy; nothing sensitive in
  the repo or the packaged app; the server directory is asserted
  absent from the archive.
- Fail closed on missing auth configuration.

### 3.3 Performance

- Budgets (regression-tested): page first content <3 s on the cached
  path; initial KQL job count per page capped (Service Detail <16;
  most pages 1–2); repeat SPA navigation ~200 ms via dedupe + TTL
  cache.
- Load strategy on every page: counts-first (the ~114 ms metrics read)
  renders the primary table; latency enriches asynchronously and never
  creates its own buckets (the counter is the source of truth for
  which minutes exist); secondary reads defer behind the primary;
  heavy KQL lazy-loads on scroll; each panel renders when its own data
  lands.
- Abort scoping matches ownership: page-level generation for page
  fetches; self-owned controllers for independent panels (a global
  controller killed Spotlight's queries the instant the page fetch
  started); feature-detect probes use a never-abort signal (an aborted
  probe caches a poisoned negative for the session).
- Measure honestly: settle = in-flight jobs reaching zero, not
  time-to-first-heading. Keep raw measurement JSON with the session
  logs.

### 3.4 Testing

- Layers: unit (Vitest) with golden-file snapshots of every KQL
  builder plus a coverage meta-test for unregistered exports;
  type-check and zero-warning lint on every push; Playwright e2e
  against the deployed pack with cached Auth0 state and injected host
  globals; live scenario specs (dev-time, hard assertions,
  deterministic surfaces only); the eval harness (trend, not gate).
- Every user-visible change is validated with Playwright against the
  deployed staging app before it is reported done. Staging is the
  validation surface, not screenshots.
- Scenario runs are sequential, never parallel (worker-pool
  saturation reads as test failure), with decay time between runs.
  Distinguish cluster-side failures from detection failures before
  reading a score movement as real.
- Smoke-test every fault-injection flag end to end before trusting the
  catalog; validate collector emissions before scoring (one missing
  receiver silently changes a scenario's difficulty class).
- Test-harness gotchas that recur: drive deep routes by clicking (the
  host 404s them); nav items are buttons, not links; dismiss the
  workspace announcement modal; anchor row-name regexes; harnesses
  that reuse one JS context to catch escalation bugs.
- Audit documented gaps against source before planning work; most
  "known gaps" were already fixed and never marked done.

### 3.5 Release engineering

- The shared framework is consumed via a `file:` reference pinned by a
  recorded 40-char SHA that CI and release both read. Extraction rule:
  push code down into the framework only when a second consumer
  exists.
- Build once, promote that exact artifact: byte-identical rebuild
  check, SHA-256 checksums, SBOM, archive inspection (rejects
  unexpected proxy grants, scripts, dependencies, server code),
  install the produced tgz before publishing.
- Releases are tag-triggered; the tag must match `package.json`; a
  lint failure on the tagged commit publishes nothing. Run lint, unit
  tests, type-check, and package locally before tagging.
- Small stacked PRs, one story each, reviewable on a phone; session
  logs and screenshots live in the repo and are linked by raw URLs;
  push all branches before ending a session.
- Design reversibility in: shared-infrastructure changes carry
  independent justification so a failed experiment writes off only its
  own directory.

### 3.6 Working method

- Spike the risky assumptions first (transport CSP, runtime budgets,
  API manageability) before building on them; sequence work so a
  failed spike is known before dependent code exists.
- Verify KQL constructs live (MCP/ad-hoc queries) before betting a
  design on them; running the panel's exact query is the fastest way
  to split "UI bug" from "query bug".
- Encode every hard-won lesson where it executes: a preamble line, a
  guard rule, a canary check, a regression test — not only in a doc.
  Preamble entries are added after a live failure and carry the
  verified working pattern.
- Convert eval findings into product fixes, not test relaxations; but
  tune thresholds on both recall (chaos scenarios) and precision (a
  noise budget on real traffic) — eval-tuned floors were provably
  over-sensitive in production and had to be reversed.
- Known accepted debt is written down where the next reader will look
  (the caller-fault metric blind spot, latency baseline absorption,
  accessibility), so a future review reads it as a decision, not an
  oversight.
