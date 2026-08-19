# 2026-08-18 — code-investigation UX + incidents design

**Summary.** Landed the alert-fired source-code investigation thread
(PR #141) — repos for autonomous runs, streaming/interruptible checkout,
a stop button, ref pinning, and a syntax-highlighted, drill-in file viewer
— then designed the next big rock: **Incidents** above investigations
(archival + cross-service coalescing), with the constraint that they work
with the server investigator **off**.

## Shipped (PR #141 — "source repos for alert-fired investigations + …")

Grew from "repos for autonomous investigations" into the whole
code-investigation UX. Commits, in order:

- **Autonomous repos**: coordinator stores a provisioned default
  (`/config/repos`), threaded into every alert-fired `/start`. The cell
  can't read the app KV, so the Settings page and `scripts/provision.ts`
  push the list (new `CELL_UI_BEARER`, then `CELL_REPOS_JSON` after we
  found provisioning couldn't read the app-scoped KV either —
  "App context required").
- **Checkout hardening**: two bugs. First a wedge (synchronous 6000-file
  store loop blocked the single-threaded DO → 502s); fixed with filtering
  + caps + yield + abort. Then an **OOM that killed celld** (buffering the
  whole decompressed tarball); fixed by making the untar fully streaming
  (decompress → parse → store one file at a time, bounded memory).
- **Stop button**: `POST /investigations/:id/cancel` aborts the in-flight
  turn (LLM + checkout) and marks `cancelled`.
- **Ref pinning**: per-repo `branch/tag/SHA` in Settings, threaded end to
  end (`/tarball/<ref>`).
- **Code-tool cards**: the framework only renders a tool card when the
  result carries a `ui`; the code tools had none, so they rendered
  nothing. Cell now attaches a `{kind:'code'}` payload; app renders a
  collapsible card. Then the cards were invisible at **2px height** —
  `overflow:hidden` zeroes a flex item's auto min-height in the flex-column
  transcript; `flex-shrink:0` fixed it. (Not a stale bundle — a real CSS
  collapse; verified via Playwright DOM probe.)
- **Syntax-highlighted file viewer**: highlight.js (lazy chunk, CSP-clean),
  line numbers, **grep-matched lines emphasized** (built from `grep_code`
  matches across the transcript), and a **modal** for the whole file. New
  `src/components/SourceFileView.tsx`.

Validated live throughout with Playwright against staging (deep-link:
`/apps/a/apm/investigate?investigation=<id>` — the shell syncs the route).
`inv-743d4da6` is the reference code investigation; pre-payload runs like
`inv-9d392229` stay blank for code steps (frozen without the `ui`).

## flagd scenario swap

Turned **off** `paymentFailure` (and all others), turned **on**
`recommendationCacheFailure` — a richer chase for the investigator
(intermittent errors **and** p95 latency creep from cache misses, plus a
clear code root cause). Left to fire on its own.

## Designed: Incidents & investigation lifecycle (P4.4)

Two problems — close/archive old investigations, and one-root-cause /
many-erroring-services — are the same missing layer: a first-class
**Incident** above investigations. Key decisions:

- **Incident = lightweight warroom**: state machine (`open →
  investigating → identified → mitigated → resolved → closed`), severity,
  a timestamped **timeline** (agent + human notes), and an
  **auto-generated markdown summary**.
- **Cribl-Search-native, cell-independent** (Clint's constraint):
  incidents are event-sourced in the dataset (`record_kind:'incident'`),
  grouped by a saved search (window + service graph → deterministic
  `incident_id`), managed by the app — so they work with the investigator
  **off**. The investigator, when on, is pure enrichment (automated
  investigations as children + supervisor-authored root cause). App KV is
  out — the cell can't read it.
- **Alerts↔incidents**: standard aggregation — many alerts roll into one
  stateful incident; all-cleared (+ debounce) → resolved; re-fire while
  open → reopen; new fire only after closed.
- **Archival**: lazy derived `WHERE` (zero background work) + a
  self-re-arming coordinator sweep alarm as "cron" until celld 0.3.0;
  cron's real job is retention (drop transcripts, keep summaries).
- **Coalescing**: (A) admission-time attach-vs-spawn via the dependency
  graph (`/config/graph`), then (B) an agent-of-agents supervisor.

Full design: `docs/research/server-investigations/incidents-and-lifecycle.md`.
Roadmap: **P4.4**. Phases 1–3 ship the cell-independent core; 4–6 are
flag-on enrichment.

## Materialized read models for hot pages (P4.5)

Clint's observation: the Alerts page "takes forever" running searches over
24h of events. It generalized into a principle — **events are the write
log / source of truth; hot pages read a materialized lookup, not a live
search over history** (CQRS read models). The codebase is already halfway
there (panel-cache lookups, the metrics-store migration). It also *reduces*
search-pool load (the saturation that flaked #141's CI) by replacing
many page-load searches with a few schedulable maintainers.

**Investigated the two pages (2026-08-18):**

- **AlertsPage.tsx** — active table already reads a cached scheduled
  result (`dataset="$vt_results" | where jobName="criblapm__home_alerts"`,
  `-1h`), fast. The slow parts are the **secondary/tertiary live 24h event
  searches**: `Q.alertHistory` (the "Alert incidents" firing→resolved
  timeline) and `Q.investigationEvents` (badges). The history section *is*
  incident pairing → **the P4.4 incident lookup subsumes it** (first
  payoff of incidents).
- **ErrorsPage.tsx** — caches only `-1h` + stream-filter
  (`listCachedErrorClasses`); **every other window runs `listErrorClasses`
  live over raw error spans** (`src/api/search.ts:720`) — heaviest of the
  lot. Fix: a scheduled **error-class rollup lookup** for common windows
  (24h), live search only for custom ranges.

**Store decision (from the KV discussion):** current state → a Cribl
lookup row (group-scoped, writable by the scheduled-search engine,
readable fast, works flag-off); **not** app-platform KV (UI-only writer,
not continuous, cell/CLI can't reach it — "App context required"); **not**
refold-events-on-read. Timeline/history stays append-only events.

**Plan / sequencing:** Alerts history → folds into P4.4 Phase 1 (the
incident lookup). Errors rollup → a standalone read-model lookup, same
machinery, can land independently. Guardrails: selective maintainers (one
lookup per hot surface), the `export to lookup` KQL traps, cadence
staleness + lookup size limits. Roadmap: **P4.5**.

## Checkpoint — resume state (end of 2026-08-19 session)

### Merged to master this session
- **#141** — code-investigation UX (autonomous repos, streaming/interruptible
  checkout, stop button, ref pinning, syntax-highlighted file viewer + modal
  + grep-line highlight). App **0.13.44**.
- **#142** — incidents & lifecycle **design** (P4.4) + ROADMAP P4.4/P4.5.
- **#143** — incident event **contract** (P4.4 Phase 1): `record_kind:'incident'`,
  `incidentEventCommitQuery()`, status/severity enums + contract test.
- **#144** — Alerts **read-model** (P4.5): `criblapm__alert_history` scheduled
  search; AlertsPage reads the panel cache for ≤7d windows instead of a live
  24h search. App **0.13.45 deployed**.

### Next (in priority order)
1. **P4.4 incidents Phase 1 (continue)** — `criblapm_incidents` lookup
   (current-state row), the alerts→incidents **grouping saved search**
   (window + service graph → deterministic `incident_id` → `export to
   lookup`), incident list/detail read path. All Cribl-Search-native
   (flag-off). Then Phases 4–6 (cell enrichment: coalescing, supervisor).
   Design: `docs/research/server-investigations/incidents-and-lifecycle.md`.
2. **P4.5 read models (finish)** — investigation-events badge cache
   (flag-gated); **Errors 24h rollup** (raw spans → incremental rolling
   lookup or slower-cadence, so it doesn't add pool load).
3. **Detection gap — latency alerting (NEW, high value)** — the alert
   evaluator (`Q.alertEvaluator`, `src/api/queries.ts:640-647`) fires only on
   **error-rate / silent / traffic-drop**; it has **no latency condition**.
   `p95_us` + `prev_p95_us` (baseline) are already computed but never gate
   `is_bad`. So `recommendationCacheFailure` (latency-dominant + intermittent
   sub-5% errors) never fired an alert despite being visible in metrics
   (Clint confirmed). Fix: add a **p95-regression arm**
   (`curr_p95 >= prev_p95 * K and curr_p95 >= floor` → `signal_type="latency"`),
   the data's already there. ROADMAP P2 detection-quality.

### Environment state (for resume)
- **flagd**: `recommendationCacheFailure` ON, all else off (port-forward runs
  on Clint's box — `kubectl -n otel-demo port-forward svc/flagd 4000:4000`;
  `scripts/flagd-set.sh --status` to check).
- **Cell**: deployed with the code-investigation features + `/config/repos` =
  `opentelemetry-demo@2.2.0`. No autonomous investigations from the current
  scenario because no alert fires (see the detection gap).
- **App**: 0.13.45.
- **Branches**: everything merged to master; `feat/incidents-p4.4` +
  `feat/read-models-p4.5` are merged and can be deleted.
- **Known flake**: `tests/live-generated-events.spec.ts` times out on search
  jobs when staging is saturated — #142/#143/#144 were admin-merged past it
  (all own gates green). Not a regression.
