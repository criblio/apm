# Server-Side Agent Investigations — Design

**Status**: Spec approved 2026-08-10; not yet implemented. Off by
default behind a `serverInvestigations` feature flag when built.
**Session log**: `docs/sessions/2026-08-10-server-investigations-spec.md`
**Roadmap item**: P4.3 (cross-references P4.1 Investigator v2).

## Problem

Investigations only happen when a human clicks "Investigate". The
agent loop runs in the browser, transcript state is component-local
React state with zero persistence, and alerts that fire while nobody
is watching go uninvestigated. The seed passed from an alert today is
thin (service, signal type, one error-rate number, hardcoded
`-1h/now` window), and there is no way to revisit a finished
investigation.

This feature adds a server-side investigator: when an alert fires, an
HTTP call wakes a Durable-Object-hosted agent that runs the same
investigation autonomously, persists state server-side, streams
progress to the UI (rendering identically to today's Investigator),
and marks the alert "investigated" so users can drill back into the
finished transcript from the Alerts page.

## Decided stack

| Component | Choice | Why |
|---|---|---|
| Orchestrator | Worker + Durable Object (Wrangler bundle) on [celld](https://github.com/denoland/celld) | Ryan Dahl's self-hosted DO daemon: embeds V8, runs Wrangler bundles, each DO = a SQLite DB replicated to an S3 bucket you own, supports live host WebSockets. Self-hostable, portable to Cloudflare. |
| Agent harness | [pi-agent-core](https://github.com/earendil-works/pi) + pi-ai | Agent runtime with tool calling + state management; pi-ai abstracts providers behind one interface. MIT. |
| LLM | Direct OpenAI-compatible endpoint | Key stored as a cell secret. NOT Cribl's hosted `/ai/q/agents/local_search` (browser-session-authenticated; machine-token support unverified; we want control over model/turns/timeouts). |
| Workspace (bash/git/files) | [Cloudflare Computer](https://blog.cloudflare.com/cloudflare-computer/) behind a `WorkspaceBackend` interface | SQLite-backed virtual FS shared between isolates and on-demand Linux containers, with read/write/edit/ls/exec and git tools. **Risk: it's a Workers-platform binding and may not be reachable from self-hosted celld — kept off the critical path (Phase 8).** |
| Trigger | Alert firing → HTTP call to the cell | Then the UI opens a WebSocket to the cell to stream progress; SSE/short-poll fallback if the iframe CSP blocks raw WS. |
| Code investigation | Single hardcoded demo repo (OTel Demo), read-only clone | Generalize the service→repo mapping later. |

## Codebase facts this design rests on

Verified during the 2026-08-10 exploration:

- **The client Investigator has no LLM key.** It posts to Cribl's
  hosted agent (`POST {apiUrl()}/ai/q/agents/local_search`,
  NDJSON streaming, OpenAI-style tool loop) via the framework
  `agent-loop.ts` (`runInvestigation`, maxTurns 12). Auth rides the
  parent Cribl browser session through the iframe fetch proxy.
- **The rendering seam is clean.** The transcript reducer is the
  exported pure function `applyLoopEvent(prev, ev)` over a
  `LoopEvent` union (`assistantText | assistantDone | toolCall |
  toolResult | notification | error | done`) — framework
  `agent-loop.ts:35-69`, `InvestigatorChat.tsx:968`. Anything that
  emits that union renders identically. Tool results carry `ui`
  payloads (`RunSearchUi`, `MetricsQueryUi`, `RenderTraceUi`,
  `SummaryUi`) that drive the cards.
- **The tool seam mostly exists.** `agentContext.ts`,
  `agentToolDefs.ts`, `kqlSafety.ts` are browser-free pure TS;
  `agentTools.ts` is injection-shaped (framework
  `createRunSearchTool({runQuery, assertSafe, datasetId})`). Only
  `search.ts`/`agentPreflight.ts` bottom out in the browser
  `runQuery`. ROADMAP P4.1 explicitly asked for this
  transport-agnosticism.
- **Alert state is append-only events in the dataset** — datatype
  `criblapm_alert` committed via `| export tee=true to search`
  (contract: `src/api/generatedEventContract.ts`). Existing readers
  filter `record_kind:'evaluation'` / `event_type in
  ("firing","resolved")`, so new `record_kind:'investigation'`
  events are invisible to every existing reader — a clean insertion
  point. There is no acknowledged/investigated state today.
- **The evaluator emits `transitioned_to`** and every event has a
  stable `event_id` (RG.1) — dedupe on `event_id`, not
  alert_id+window.
- **Scheduled searches can fire webhook notification targets**
  (`schedule.notifications.items[]`, `includeResults`;
  `docs/research/cribl-saved-searches.md:97-115`). The framework
  `ProvisionedSearch.schedule` type doesn't have the field yet.
  `| send "URL"` is a known trap — silently unsupported; never use
  it for delivery.
- **Machine auth to Cribl works** — OAuth2 client-credentials
  (framework `auth.ts`) → Bearer on `{base}/api/v1`; search jobs via
  `POST /m/default_search/search/jobs` (job id at
  `items[0].id`; NDJSON results, schema line 0). `scripts/
  provision.ts:74-94` already reads the app's KV (`settings/app`)
  with machine creds — proving the cell can read the feature flag
  the same way.
- **Platform proxy constraints**: `config/proxies.yml` per-domain
  path allowlists, `headers.inject` with encrypted `kv.<key>`
  secrets, timeout max 120s, HTTPS only, 100 req/min per app,
  `authorization` always stripped from the original request.
  Currently enforced empty by `--require-empty-proxies` in 4 places.
  WebSocket is not `fetch`, so the proxy neither rewrites nor
  authenticates it — only the iframe CSP can block it (spike S1).
- **Search capacity**: concurrent search queue max 20; scheduled
  searches already queue 8s–22min at peak. The agent must be
  rate-capped.

## Architecture

```
criblapm__home_alerts (evaluator, ~5m)            Cribl dataset (criblapm_alert events)
        │ export tee=true to search                     ▲                ▲
        ▼                                               │ started/       │ AlertsPage reads
criblapm__alert_notify (flag-gated, +2min offset)       │ investigated   │ (badge + drill-in)
        │ webhook notification target (includeResults)  │
        ▼                                               │
celld: Worker ── CoordinatorDO (event_id dedupe, queue, concurrency=1)
                    └─▶ InvestigationDO per investigation
                          • pi-agent-core loop → OpenAI-compatible endpoint
                          • tools: run_search / run_metrics_query / render_trace /
                            update_context / present_investigation_summary
                            (Cribl REST via OAuth client-credentials, shared kqlSafety)
                          • SQLite: investigation, transcript_events(seq, LoopEvent JSON),
                            agent_messages (raw pi history — enables future follow-ups)
                          • WS fanout + since-seq replay
        ▲                            ▲
        │ webhook bearer             │ wss ticket (or proxied short-poll fallback)
UI: AlertsPage badge ─▶ /investigate?investigation=<id> ─▶ applyLoopEvent replay
```

### Key principles

- **The Alerts page never contacts the cell.** The cell commits
  `record_kind:'investigation'` events (`started` / `investigated` /
  `investigation_failed`) to the dataset via
  `print … | export tee=true to search` search jobs; AlertsPage
  renders "Investigating…"/"Investigated" badges purely from dataset
  reads (join to incidents by `alert_id` + event time within the
  incident window). The cell is only touched when a user drills into
  a transcript — so Alerts-page availability is decoupled from cell
  availability.
- **Identical rendering by construction.** The cell maps
  pi-agent-core events onto the existing `LoopEvent` union; the UI
  feeds frames through `applyLoopEvent`. Cell tool executors attach
  the same `ui` payloads so cards render, not plain text.
- **Same seed as clicking Investigate.** Extract
  `buildAlertSeed(incident)` from the `AlertsPage.tsx:298-305`
  literal into `src/api/agentContext.ts`, used by both AlertsPage
  and the cell. The cell runs `agentPreflight` itself via the Cribl
  API before the first LLM turn.
- **`/alerts/fire` always 202s immediately and runs async** —
  webhook and proxy timeouts are short; never run preflight in the
  webhook handler.
- **Keep `maxTurns: 12` initially** — parity with the client first;
  the server has no 30s TTFB constraint, so tune later.

## Trigger path

New provisioned search `criblapm__alert_notify` (query builder
`Q.alertNotify()` in `src/api/queries.ts`): reads the dataset for
`record_kind=='evaluation' && event_type=='firing'` rows in the last
15m (3× cadence overlap to tolerate missed runs), projecting
`event_id, alert_id, svc, signal_type, curr_error_rate, fire_count,
_time` — everything the seed needs, so the cell needn't run an extra
query. Scheduled on `getSearchCadenceCron` offset +2min (after the
evaluator's +1). Notification: webhook target
(`criblapm_cell_webhook`, URL = cell `/alerts/fire`, bearer header)
with `triggerType:'resultsCount' > 0` and
`targetConfigs[].conf.includeResults: true`.

The cell dedupes on `event_id` (SQLite UNIQUE), builds the seed via
the shared `buildAlertSeed()`, runs preflight, then starts the loop.

Target creation: `scripts/provision.ts` gains an
"ensure notification target" step (machine creds; URL/bearer from
local `.env`, never packaged). Fallbacks if spike S4 shows targets
aren't API-creatable: document one-time manual creation in the
runbook; second fallback: drop the webhook entirely and have the
cell poll the dataset once per cadence (one cheap search / 5m).

## DO state model

Two DO classes:

- **CoordinatorDO** (singleton): SQLite
  `seen_events(event_id PK, investigation_id, received_at)` + queue;
  enforces global concurrency (start at 1) and a per-hour
  investigation cap; routes the `/investigations` list.
- **InvestigationDO** (one per investigation, id `inv-<ulid>`):

```sql
CREATE TABLE investigation (
  id TEXT PRIMARY KEY, alert_id TEXT NOT NULL, trigger_event_id TEXT NOT NULL,
  incident_key TEXT NOT NULL,            -- svc:signal_type
  status TEXT NOT NULL,                  -- queued|running|concluded|failed|cancelled
  seed_json TEXT NOT NULL, conclusion_json TEXT, error TEXT,
  created_at INTEGER, started_at INTEGER, concluded_at INTEGER,
  schema_version INTEGER NOT NULL
);
CREATE TABLE transcript_events (
  seq INTEGER PRIMARY KEY,               -- monotonic
  ev_json TEXT NOT NULL,                 -- WireLoopEvent
  created_at INTEGER
);
CREATE TABLE agent_messages (            -- raw pi history, enables future follow-ups
  seq INTEGER PRIMARY KEY, message_json TEXT NOT NULL
);
```

## Wire protocol

```ts
type WireLoopEvent = LoopEvent  // with error flattened to {kind:'error', message:string}
type ServerFrame =
  | { type:'hello', investigation:{id,status,seed,alertId,createdAt,concludedAt},
      latestSeq:number, protocolVersion:number }
  | { type:'event',  seq:number, ev:WireLoopEvent }
  | { type:'status', status:'queued'|'running'|'concluded'|'failed'|'cancelled' }
  | { type:'ping' }
```

- **WS path**: UI fetches `GET /ws-ticket?investigation=<id>`
  through the platform fetch proxy (auth injected via proxies.yml
  `headers.inject: "'Bearer ' + kv.cellToken"`); the cell returns an
  HMAC ticket (60s TTL, scoped to the investigation id); UI opens
  `new WebSocket('wss://<cell>/investigations/<id>/ws?since=N&ticket=…')`.
- **Poll fallback**: `GET /investigations/:id/events?since=N` every
  ~2.5s while the page is visible (well under the 100 req/min proxy
  cap). Same frames; the transport is invisible above
  `subscribeInvestigation(id, sinceSeq, onFrame)`
  (`src/api/investigationTransport.ts`).
- **pi → LoopEvent mapping** lives in
  `cell/src/agent/loopEventMap.ts` with table tests:

| pi-agent-core event | LoopEvent |
|---|---|
| assistant text delta | `{kind:'assistantText', turnId, chunk}` |
| assistant message end | `{kind:'assistantDone', turnId}` |
| tool call issued | `{kind:'toolCall', turnId, call:{id, type:'function', function:{name, arguments:JSON.stringify(args)}}, needsApproval:false}` |
| tool result | `{kind:'toolResult', turnId, result:{id, name, content, ui}}` |
| thinking/reasoning | `{kind:'notification', turnId, content}` (or drop — decide in spike) |
| loop complete | `{kind:'done', reason:'complete'}` |
| loop error / turn cap | `{kind:'error', message}` |

`turnId` is minted server-side per assistant turn; `needsApproval`
is always false (no human in the loop). Unknown pi events → no-op.

## Tool surface

`cell/src/agent/tools.ts` instantiates
`createApmToolExecutors({ client: cellSearchClient, dataset })` —
the same 5 tool definitions from `APM_TOOL_DEFINITIONS`
(`run_search`, `run_metrics_query`, `render_trace`,
`update_context`, `present_investigation_summary`), the same
`assertReadOnlyKql`. `cellSearchClient` wraps framework `auth.ts`
(client-credentials) + `search-job.ts`.

Rate caps: ≤2 concurrent search jobs per investigation, ≤30 total
per investigation (search-queue protection).

Code tools (Phase 8, contingent on spike S3, behind
`WorkspaceBackend`): read-only only in v1 — `bash`, `read_file`,
`list_dir`, `git_log`/`git_show`; no write/edit (shrinks the safety
surface). Workspace init clones a pinned OTel Demo ref. A
server-only prompt addendum (`cell/src/agent/codePrompt.ts`,
appended to `buildSeedPrompt()` output) describes the workspace and
instructs: consult code only after telemetry has narrowed to a
service/operation; cite file paths and line ranges in the summary.
The client prompt is unchanged.

## Concluding and alert-state update

On `present_investigation_summary`: the DO stores
`conclusion_json`, sets status `concluded`, then commits via a
search job:

```
print datatype="criblapm_alert", schema_version=tolong(1),
      event_id="<inv-id>:investigated", producer="criblapm_cell_investigator",
      record_kind="investigation", event_type="investigated",
      alert_id="…", investigation_id="<inv-id>", trigger_event_id="…",
      svc="…", signal_type="…", conclusion="<escaped ≤1KB snippet>"
| export tee=true to search "<dataset>"
```

Same shape with `event_type:'started'` at accept-time and
`'investigation_failed'` on error/turn-cap. Contract work: add
`InvestigationEvent` to `src/api/generatedEventContract.ts`; extend
the post-reconcile contract canary to the third shape; add
`Q.investigationEvents(range)`.

Drill-in (`/investigate?investigation=<id>`) is **replay-read-only
in v1**. Follow-up questions on a finished investigation are
deferred, but the raw pi message history stored in `agent_messages`
keeps that door open without redesign.

## Feature flag (off by default)

`serverInvestigations?: boolean` on `AppSettings`
(`src/api/appSettings.ts`); module `src/api/serverInvestigations.ts`
cloned from `metricsRead.ts` **but `let enabled = false`** (the
metricsEmit/metricsRead modules have a documented default-true
discrepancy — don't copy it); hydration in `DatasetProvider.tsx`
with the `typeof === 'boolean'` guard; Settings toggle card noting
the re-provision requirement. Three enforcement points:

1. **Provision-time**: `scripts/provision.ts` loads it from KV;
   `getProvisioningPlan()` pushes `criblapm__alert_notify` only when
   true (pattern: the `metricsEmit` gate).
2. **UI**: badges/links/drill-in render only when true.
3. **Cell kill switch**: the cell re-reads `settings/app` KV
   (machine creds) with ~60s cache on every `/alerts/fire`; false →
   202-and-drop. Plus a cell-local `DISABLED` env override. Flipping
   the toggle stops new investigations within a minute, before
   re-provision removes the notify search.

## Secrets

| Secret | Lives | Purpose |
|---|---|---|
| OpenAI-compatible API key | celld secret | pi-ai LLM calls |
| `CRIBL_CLIENT_ID/SECRET` | celld secret | OAuth → search jobs, KV read, event commits |
| `WEBHOOK_BEARER` | celld secret + notification target (set by provision from local `.env`) | authenticate `/alerts/fire` |
| `TICKET_SIGNING_KEY` | celld secret | HMAC WS tickets |
| CF Computer credentials (if Phase 8 ships) | celld secret | workspace backend |
| `cellToken` | app-platform encrypted KV (admin runbook step) | proxies.yml header injection |

Nothing in the repo or the packaged app; `cell/` is excluded from
the app archive (enforced by an archive-inspection assertion).

## proxies.yml transition

The empty-proxies release invariant becomes a **pinned-manifest
contract** (RG.5's spirit: reviewed contract + archive test on
unexpected domains):

- Framework `@cribl/app-tooling`: new `--proxies-manifest <path>`
  option in `inspect.mjs` / `deploy.mjs` / `release-evidence.mjs` —
  parse the packaged `proxies.yml`, normalize, deep-compare against
  the committed expected manifest; any extra domain/path/header
  fails.
- App: replace `--require-empty-proxies` at the 3 package.json
  scripts (`release:evidence`, `inspect:pack`, `deploy`) with
  `--proxies-manifest config/proxies.expected.yml`; commit the real
  `config/proxies.yml` (cell domain, paths `/ws-ticket` +
  `/investigations/*`, `kv.cellToken` header inject, timeout) and an
  identical expected manifest; add a repo unit test pinning the
  parsed manifest and an archive test that `cell/` is not packaged.
- This lands early: while the manifest is empty, the pinned test
  degenerates to today's invariant.

## PR sequence

| PR | Repo | Content |
|---|---|---|
| 1 | app (docs) | Spike results appended to this doc. **S1** WS-from-iframe CSP (stub echo server, temp staging proxies.yml — decides WS vs poll-primary). **S2** celld viability (minimal DO: SQLite persistence, host WS, outbound fetch, a 10-minute-lived loop / eviction semantics, S3 replication). **S4** notification target (API-creatable? real payload shape with `includeResults`? size cap? retries?). **S3** Cloudflare Computer reachability from celld (gates only PR 12). |
| 2 | app | Shared-code refactor, zero behavior change: `src/api/searchClient.ts` (`SearchClient` interface + browser impl over `src/api/cribl.ts`); `search.ts` / `agentPreflight.ts` / `agentTools.ts` → injection form (`createApmToolExecutors({client, dataset})`) with browser defaults so call sites don't churn; `buildAlertSeed()` extraction; `browserFree.test.ts` guard (node env, no DOM). |
| 3 | app | Flag plumbing (dark — no consumer yet). |
| 4 | framework | `--proxies-manifest` tooling + tests. |
| 5 | app | Swap `--require-empty-proxies` → pinned manifest (empty for now) + cell-exclusion archive assertion. |
| 6 | app (`cell/`) | Cell scaffold: own package.json + wrangler.toml; router, bearer auth, ticket mint/verify, CoordinatorDO, InvestigationDO + migrations, KV flag read, `criblClient.ts`; **stub agent** emitting canned LoopEvents so fire→dedupe→queue→transcript→WS/poll replay is testable without an LLM. Validate: miniflare/workerd tests + curl script against a celld deploy. |
| 7 | app (`cell/` + contract) | Real loop: pi-agent-core + pi-ai, 5 tools via shared executors, `loopEventMap.ts` + table tests, preflight-in-cell, rate caps, started/investigated/failed commits; app side `InvestigationEvent` + canary extension + `Q.investigationEvents()`. Validate: synthetic firing event (reuse `alertTransitionCanary.ts` machinery) → concluded investigation → events queryable; replay identical across reconnects. |
| 8 | framework | `ProvisionedSearch.schedule.notifications` (type + `planToBody` + `isSameAsPlan`) + ensure-notification-target helper. |
| 9 | app | `Q.alertNotify()`, flag-gated plan entry, target provisioning in `scripts/provision.ts`. Validate: live firing transition → exactly-once webhook (rerun notify search, confirm dedupe). |
| 10 | framework | Extract InvestigatorChat transcript rendering into a driver-agnostic view (client-loop driver stays the default). |
| 11 | app | Populate proxies.yml + expected manifest; `investigationTransport.ts`; `InvestigatePage` `?investigation=<id>` replay mode; `AlertsPage` join/badge/drill-in. Validate: Playwright on staging — fire canary, badge appears, drill in, cards render, reload mid-stream → since-replay continuity. |
| 12 | app (`cell/`) | Code tools (contingent on S3): `WorkspaceBackend`, CF Computer impl (or exec-sidecar fallback), read-only tools, pinned OTel Demo clone, prompt addendum. Validate: staged investigation citing a real demo-repo file path. |
| 13+ | app | Hardening: kill-switch drill, failure-path events, transcript size caps, replay pagination, `docs/cell-runbook.md`, README honesty update. |

## Blast radius & reversibility

**Framework changes: 3 total, none flag-dependent, none
behavior-changing for existing users.**

| Change | Nature | Independent justification |
|---|---|---|
| `--proxies-manifest` tooling (PR 4) | Additive CLI option | ROADMAP RG.5 ("archive test that fails on unexpected domains") |
| `schedule.notifications` field (PR 8) | Optional; all 34 existing searches omit it | ROADMAP P3.1 (user alerts + notification dispatch) needs it |
| InvestigatorChat view/driver split (PR 10) | The one structural refactor; client-loop driver stays default | ROADMAP P4.1 (migration to Cribl's server-side runtime) needs it |

`agent-loop.ts`, `agent.ts`, the KQL guard, auth, search-job:
untouched. **Flag off = the existing client Investigator runs
identically** — the flag only gates app-side additions.

All celld-specific code is isolated to: `cell/` (new dir, excluded
from the pack), `src/api/investigationTransport.ts`, and additive
flag-gated blocks in `AlertsPage`/`InvestigatePage`.

**Rollback levels:**

1. *Off in minutes, no code*: Settings toggle → cell kill switch
   drops triggers within ~60s; re-provision removes the notify
   search. Dataset investigation events are inert (no other reader).
2. *Retire the experiment, one small PR*: delete `cell/` +
   `investigationTransport.ts`, remove the flag-gated blocks in two
   routes, revert `proxies.yml` to empty (the pinned-manifest test
   degenerates back to today's invariant). No framework reverts.
3. *Survives a failed spike*: the injection seams, proxies tooling,
   notifications field, transcript-view split, `InvestigationEvent`
   contract, and flag plumbing all have independent roadmap
   justification. True write-offs are only `cell/` + the transport
   shim — and spike ordering (S1/S2/S4 first) means we know before
   most of that exists.

## Verification strategy

- **Unit**: loopEventMap table, event contract, KQL snapshots for
  `alertNotify`/`investigationEvents`, browser-free guard,
  proxies-manifest pin, seed-builder parity (cell vs AlertsPage —
  shared builder makes this structural).
- **Cell**: workerd-local tests with stubbed Cribl/LLM; one
  serialized live staging script (staging's search queue is small —
  run one at a time per CLAUDE.md).
- **UI**: Playwright against staging on every UI PR (repo
  convention).
- **Release**: pinned manifest + cell-exclusion checks in the
  existing evidence pipeline.

## Top risks

1. **Cloudflare Computer may not be bindable from self-hosted
   celld** (it's a Workers-platform binding) — spike S3;
   `WorkspaceBackend` abstraction; code tools off the critical path.
2. **Iframe CSP blocks WebSockets** — spike S1 is step 0; the
   transport interface makes poll-primary a config change, not a
   redesign.
3. **Notification targets not API-provisionable / payload
   unusable** — spike S4; fallbacks: manual target runbook, then
   cell-side dataset polling. (`| send "URL"` is a known trap.)
4. **Search-queue contention** (20-job cap; 8s–22min queue waits
   observed) — coordinator concurrency 1, per-investigation search
   caps, investigations only on firing transitions, seed built from
   the webhook payload (no extra seed query).
5. **Duplicate investigations** (window overlap, webhook retries) —
   dedupe on stable `event_id`, idempotent 202, always-async
   `/alerts/fire`.
6. **Contract drift** (cell and app deploy independently) —
   `schema_version` on rows, `protocolVersion` in the hello frame,
   graceful UI refusal on mismatch.
7. **celld maturity** (early-stage, evolving surface, PRs disabled
   upstream) — spike S2 covers persistence/eviction/WS/outbound
   fetch before any dependent PR.
