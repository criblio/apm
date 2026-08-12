# 2026-08-10 — Server-side agent investigations: spec session

**Outcome**: full design spec for server-side, alert-triggered agent
investigations, captured in
[`docs/research/server-investigations/design.md`](../research/server-investigations/design.md),
plus a new ROADMAP item (P4.3). Docs only — no feature code this
session. The point of this doc set is that a future session can be
told "start on server-side investigations" and begin at PR 1/PR 2
with zero re-discovery.

## What was asked

When an alert fires, investigate it server-side with the same
state/seed we'd pass when a user clicks "Investigate". Host the
compute on celld with Cloudflare Computer backing a pi agent
configured like our existing client-side loop (search + metrics
tools, plus bash-type tools and read-only repo access). Stream state
back to the UI so it renders exactly like today's investigation.
Maintain investigation state server-side; when the agent concludes,
mark the alert investigated so users can drill back into the
finished investigation. Feature-flagged, off by default, easy to
turn off.

## What was explored

Three parallel codebase sweeps (client agent loop, alerting
subsystem, platform surface) plus external research on the three new
components. Load-bearing findings:

- The client Investigator has **no LLM key** — it posts to Cribl's
  hosted agent (`/ai/q/agents/local_search`) authenticated by the
  browser session. A server-side agent therefore needs its own model
  path.
- Investigations have **zero persistence** today — transcript is
  component-local React state; the only "export" is a PNG.
- The rendering seam is clean: everything renders through the pure
  reducer `applyLoopEvent` over the `LoopEvent` union — any emitter
  of that union renders identically.
- The tool/context modules are already mostly transport-agnostic
  (ROADMAP P4.1 asked for exactly this); only
  `search.ts`/`agentPreflight.ts` bottom out in the browser fetch.
- Alert state is **append-only events in the dataset**
  (`criblapm_alert` via `export tee=true to search`) with no
  acknowledged/investigated state — new
  `record_kind:'investigation'` events are invisible to all existing
  readers, a clean insertion point.
- Scheduled searches **can fire webhook notification targets**
  (results attached); the framework's `ProvisionedSearch.schedule`
  type just doesn't expose the field yet. `| send "URL"` remains a
  trap.
- Machine OAuth (client-credentials) already runs searches and reads
  the app's KV from Node (`scripts/provision.ts`) — the cell can use
  the identical path for tools, event commits, and the kill switch.
- The platform fetch proxy can authenticate HTTPS calls to the cell
  via `kv.<key>` header injection, but WebSocket is not `fetch` —
  only the iframe CSP decides whether raw WS works (spike S1).

## Decisions made (Clint)

1. **celld** ([github.com/denoland/celld](https://github.com/denoland/celld))
   — Ryan Dahl's self-hosted Durable Objects daemon — runs the
   investigator, written as a Worker + DO Wrangler bundle (portable
   to Cloudflare). **Cloudflare Computer**
   ([blog](https://blog.cloudflare.com/cloudflare-computer/)) is the
   workspace backend for bash/git/file tools.
2. **Agent harness**: [pi-agent-core](https://github.com/earendil-works/pi)
   (open to alternatives; Flue was mentioned), with LLM calls going
   **directly to an OpenAI-compatible endpoint** (key as a cell
   secret) — not Cribl's hosted agent.
3. **Trigger**: alert firing → HTTP call to the cell; the UI then
   opens a **WebSocket** to the cell to stream agent progress.
   SSE/short-poll fallback if the iframe CSP blocks WS. Using
   `proxies.yml` for the cell domain is sanctioned ("that's what
   it's for") — the empty-proxies invariant becomes a
   pinned-manifest contract.
4. **Repo access**: single hardcoded demo repo (OTel Demo),
   read-only, for v1.

## Design highlights (full detail in the design doc)

- **Alerts page never contacts the cell** — the cell commits
  `started`/`investigated`/`investigation_failed` events into the
  dataset and AlertsPage badges/drill-ins render from dataset reads
  alone. The cell is only touched on transcript drill-in.
- **Identical rendering by construction** — the cell maps pi events
  onto the existing `LoopEvent` union (with the same tool-result
  `ui` payloads) and the UI replays them through `applyLoopEvent`,
  with since-seq resume over WS or polling.
- **Flag with three enforcement points** — provision-time (notify
  search only planned when on), UI (badges/drill-in), and a
  cell-side kill switch that re-reads the app's KV so toggling off
  stops new investigations within ~a minute.
- **Reversibility** — all three framework changes (proxies-manifest
  tooling, `schedule.notifications`, InvestigatorChat view/driver
  split) have independent roadmap justification (RG.5, P3.1, P4.1);
  the only true write-offs on a failed spike are `cell/` and the
  transport shim.
- **Spikes gate the build** — S1 (WS from iframe CSP), S2 (celld
  viability), S4 (notification-target payload) before dependent
  work; S3 (Cloudflare Computer reachability from celld) gates only
  the code-tools phase, which is deliberately off the critical path.

## Execution sequence

13 small PRs (repo convention: one coherent story each, stacked OK):
spikes+doc → shared-code injection refactor → flag plumbing →
proxies-manifest tooling (framework+app) → cell scaffold with stub
agent → real pi loop + event contract → trigger
(framework notifications field + notify search) → UI
(framework view/driver split + transport/replay/badges) → code
tools (contingent on S3) → hardening. Full table with validation
steps per PR is in the design doc.

## Artifacts

- `docs/research/server-investigations/design.md` — the spec.
- `ROADMAP.md` — new **P4.3 Server-side agent investigations**
  entry cross-referencing P4.1/P3.1/RG.5.
- No screenshots — docs-only session (no UI changes).
