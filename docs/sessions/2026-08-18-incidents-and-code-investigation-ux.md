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
