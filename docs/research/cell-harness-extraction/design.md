# Cell harness extraction & Pi adoption

Separate the celld infrastructure from the APM payload so a second
Cribl Search app — a Pi coding agent running inside a celld worker —
can reuse the harness without copying it. APM-specific code stays in
this repo; the generic agent harness moves to
`cribl-search-app-framework`.

Status: **implementation in flight** (2026-08-20). Steps 1-4 built +
step 5's offline half, as a PR stack — apm: #149 (payload seam) →
#150 (protocol consumption) → #151 (pi-agent-core runner) → #152
(cell rebuilt on framework packages); framework: #27
(agent-protocol) → #28 (cell-harness + cell-workspace) → #29 (write
tools + git write-back). Remaining: CF-computer vfs + just-bash
(needs live celld), tool-defs move to app-utils (§2.5), GitHub
Packages publishing, coding-app scaffold. Decisions confirmed with
Clint inline below.

## Decisions (2026-08-20, second round)

6. **GitHub Packages** is the registry, under the `criblio` org.
   GitHub Packages requires the npm scope to match the owning org,
   so published names are `@criblio/agent-protocol`,
   `@criblio/cell-harness`, `@criblio/cell-workspace`. The existing
   `@cribl/app-utils` / `@cribl/app-tooling` either republish as
   `@criblio/*`, or apps keep imports unchanged via npm aliasing
   (`"@cribl/app-utils": "npm:@criblio/app-utils@^x.y.z"`) —
   resolve when the publishing PR lands.
7. **Coding app is interactive-first.** UI-prompted sessions are the
   v1 trigger; the harness's webhook trigger surface stays available
   but no autonomous trigger ships in the coding app's v1.
8. **v1 write-back is via Git** (§4.4): GitHub Data API backend
   first (fits the tarball checkout — no `.git` state in the vfs),
   behind a tool surface that can later swap to isomorphic-git,
   including a just-bash `git` command emulated as a wrapper around
   isomorphic-git.

## Decisions (2026-08-20)

1. **Framework monorepo** hosts the extracted packages (not a new
   repo).
2. **UI stays in the app.** The transcript reducer/session hook can
   move to `app-utils` (generic), but chat components and pages stay
   app-side — the coding app will use different UI constructs.
3. **Tests/exec for the coding agent are out of scope for v1.**
   Emulated in-cell tooling (e.g. esbuild via custom just-bash
   commands) is in scope; running a real test suite is not.
4. **Adopt `@earendil-works/pi-agent-core` for the loop** (spike
   verdict below); tools are worker-native implementations over the
   `@cloudflare/computer` vfs + just-bash, not a bundle of
   pi-coding-agent's node tools.
5. **Publish the framework as a proper npm module** and retire the
   `.framework-sha` pin (registry choice open, see §6).

## 1. What exists today — the coupling map

The client side already has the right shape: framework
`agent-loop.ts` injects everything app-specific via `RunLoopOptions`
(tool defs, executors, context builder), and the transcript UI lives
in `app-utils/investigator`. The server side never got that seam —
the cell reaches into app source with relative imports
(`cell/src/agent/realTurn.ts` → `../../../src/api/agentToolDefs`,
`investigationDO.ts` → `buildAlertSeed` / `createApmToolExecutors`).

Sorting `cell/` (~3.4k lines):

| Bucket | Files | Notes |
|---|---|---|
| Generic celld harness (~80%) | `index.ts` router + closed-by-default auth, `tickets.ts` (HMAC WS tickets), `coordinatorDO.ts` (dedupe/queue/concurrency/caps/index), `investigationDO.ts` session machinery (alarm-per-turn loop, append-only `seq` transcript, WS fanout + `?since` replay + poll fallback, status machine, watchdogs, event capping) | Knows nothing about APM except naming and two SQL columns (`alert_id`, `incident_key`) |
| Generic, coding-harness-ready | `workspace/` (tarball checkout, RepoStore over DO SQLite), `agent/codeTools.ts` (checkout_repo / list_dir / read_file / grep_code) | The read-only half of a coding workspace, deliberately worker-native |
| Cribl-generic, not APM | `criblClient.ts` (machine OAuth), `cellSearchClient.ts` | A second app wants these verbatim |
| APM-specific | `FiringAlert` + `incidentKey`, `buildAlertSeed` + preflight, APM tool defs/executors, stub agent's canned turns, lifecycle commits to the criblapm dataset | Stays in this repo |
| Known drift | `protocol.ts` hand-mirrors the framework `LoopEvent` union (its own header says to converge) | Fixed by extraction (§2.1) |

## 2. Target architecture — framework monorepo packages

Runtime is the package boundary: `app-utils` is browser-flavored;
the cell needs `@cloudflare/workers-types`. New packages, own
tsconfigs:

### 2.1 `@criblio/agent-protocol` (tiny, isomorphic)

`WireLoopEvent`, `ServerFrame`, session statuses + terminal-status
logic, `PROTOCOL_VERSION`, ticket format. Imported by both the UI
transport and the cell; a type-level assertion pins it to the
framework `LoopEvent` union so the mirror can't drift.

### 2.2 `@criblio/cell-harness` (workers runtime)

- Router factory (`createCellRouter(payload, opts)`), bearer auth,
  tickets.
- `CoordinatorDO` with policies (concurrency, hourly cap, dedupe
  key) as config.
- Generic `AgentSessionDO` (renamed from `InvestigationDO`):
  `alert_id`/`incident_key` → `subject_id`/`group_key` +
  payload-owned `meta_json`. Alarm-per-turn loop, transcript
  store/fanout/replay, watchdogs, `capEvent`.
- The turn runner (pi-agent-core based, §4).
- A default stub agent so any payload's configless smoke works.

### 2.3 `@criblio/cell-workspace` (workers runtime)

The `@cloudflare/computer` Workspace vfs + just-bash layer (S3-spike
proven: vfs and just-bash run fully self-hosted in a celld DO;
worker-shell/Containers backends stay a Cloudflare-portability
upgrade). Today's tarball checkout + RepoStore + read-only tools
migrate onto it; write tools and the bash tool land here (§4.2).
Separate from cell-harness so the coding app can take the workspace
without the DO scaffolding (or vice versa).

### 2.4 The `CellPayload` seam

The server-side mirror of `RunLoopOptions`. An app supplies:

```ts
interface CellPayload {
  /** Parse a webhook/UI trigger into a typed subject + grouping key. */
  parseTrigger(req: TriggerRequest): { subjectId: string; groupKey: string; meta: unknown };
  /** System prompt + opening message (+ optional preflight). */
  buildSeed(trigger, ctx): Promise<Seed>;
  /** Tools advertised + executed for a session. */
  tools(ctx): AgentTool[];
  /** Lifecycle hooks: started/concluded commits, coordinator notify. */
  onLifecycle?(event, ctx): Promise<void>;
  /** Optional canned turns for configless smoke. */
  stubTurns?(...): WireLoopEvent[][];
}
```

APM's payload implementation (alert parsing, `buildAlertSeed`, APM
tools, dataset commits) stays in `apm/cell/`, which shrinks to
payload + entry wiring + deploy scripts. The coding app's payload
supplies a task/prompt trigger, Pi persona, and coding tools.

### 2.5 The Cribl domain tools are framework-level, not APM-level

`run_search` and `run_metrics_query` (and the concluding
`present_investigation_summary`, whose card the framework chat shell
renders natively) are Cribl-Search-generic, and their *executors*
already live in the framework — `createRunSearchTool` /
`createRunMetricsQueryTool` in `app-utils/agent-tools.ts`. APM only
contributes the wiring (dataset, KQL read-only guard, search client,
metrics transport) and its own `render_trace`. What still lives
app-side for no good reason is the tool *definitions*
(`agentToolDefs.ts` schemas/descriptions for run_search,
run_metrics_query, update_context, present_investigation_summary):
step 4 moves those into `app-utils` next to their executors, so any
payload — the coding agent included — can offer the Cribl search
tools without importing anything from APM. `render_trace` (defs +
executor) stays APM-only.

## 3. What stays where

- **apm repo**: APM payload, provisioned searches, incidents/alerts
  wiring, all UI, stub turns, deploy env.
- **framework**: the three packages above; `app-utils` gains the
  generic session-transport hook (`useInvestigationSession` minus
  APM naming) next to `investigator/` for apps that want it — the
  coding app is free to ignore it.
- **new coding app**: own repo/app, depends on the framework
  packages, supplies its payload + UI.

## 4. Pi adoption — spike results and recommendation

Two separate questions: the **loop** and the **tools**.

### 4.1 Loop: adopt `@earendil-works/pi-agent-core` — spike PASSED

The DO model requires: one LLM turn per `alarm()`, persist, resume
on a possibly different node from serialized messages.
pi-agent-core supports this natively:

- `shouldStopAfterTurn` hook → loop exits after each turn.
- `initialState.messages` + `continue()` → rehydrate a fresh
  `Agent` from persisted JSON and resume (`continue()` requires the
  history to end on `user`/`toolResult` — exactly the turn-boundary
  state; a turn ending in plain assistant text is the
  concluded/idle state anyway).
- Messages are plain JSON (pi-ai shapes — same thing `realTurn.ts`
  persists today).

Verified live with a scripted stream function
(`spike-pi-agent-core.mjs`, run `npm i <pi-agent-core tgz> && node
spike-pi-agent-core.mjs`): turn 1 stops after exactly one LLM call
with history ending on `toolResult`; JSON round-trip; a brand-new
Agent rehydrated from that JSON `continue()`s to the final answer.
All 5 checks pass on 0.84.2.

Runtime purity: the root entry (`dist/index.js`) pulls no node
builtins — node-specific code is isolated behind the separate
`./node` export. Deps are pure JS (pi-ai, pi-telemetry, typebox,
yaml, diff, ignore). Worker-bundlable as-is.

What this buys over the hand-rolled `realTurn.ts`: maintained loop
machinery — steering/follow-up queues (interactive sends stop being
custom code), `beforeToolCall`/`afterToolCall` hooks, parallel tool
execution, and **compaction** (`compact`/`shouldCompact` exported
from the root) which a long coding session will need and the
investigator will eventually want. `realTurn.ts` + `loopEventMap.ts`
become a thinner adapter: pi-agent-core events → `WireLoopEvent`.

### 4.2 Tools: worker-native over the Workspace vfs, not bundled node tools

`@earendil-works/pi-coding-agent` (0.84.2) has the right seam on
paper — every tool accepts an Operations interface
(`BashOperations.exec`, `ReadOperations`, `EditOperations`,
`WriteOperations`, …) with `createLocalBashOperations` as the node
default. But in practice bundling them into a worker is hostile
today:

- The tool modules statically import node builtins (`fs`,
  `child_process`, `node:readline`) and the TUI (`pi-tui`, theme,
  keybinding hints) even when custom Operations are injected —
  every import needs an esbuild stub, fragile across upstream
  releases.
- Package `exports` only expose `.` / `./rpc-entry` / `./client`;
  the root entry drags the CLI, TUI components, and `main()`. No
  supported subpath for just the tools.

**Recommendation:** implement the coding tools in
`@criblio/cell-workspace` against the Workspace vfs + just-bash,
matching pi's tool names/schemas/behavior (read, write, edit, ls,
grep, find, bash):

- We already have 4 read-only ones proven in production
  (`codeTools.ts`); add write/edit/bash on the vfs.
- `bash` = just-bash over the vfs (S3-spike proven in-DO), with
  **custom commands implemented in TS** for toolchain steps — e.g.
  an `esbuild` command backed by esbuild-wasm. This is the "run
  esbuild etc. from within typescript with emulated commands" path;
  it can go surprisingly far without Containers.
- Borrow pi-coding-agent's pure modules where valuable — its
  `edit-diff` logic (normalize/apply/diff) has no node deps and
  encodes hard-won edit semantics.
- Optional later: upstream a PR to pi-mono adding a runtime-pure
  `./tools` export; if accepted, swap our implementations for
  theirs behind the same Operations interfaces.

### 4.3 Write-back: git, API-backend first

Edits live in the vfs; the session's output is a branch + PR on
GitHub. Two viable backends, one tool surface:

- **v1 — GitHub Data API.** The tarball checkout carries no `.git`
  state, and the API needs none: resolve the base ref's sha, create
  blobs for changed files, a tree, a commit, a branch ref, then a
  PR — all plain worker `fetch` against api.github.com with the
  existing `GITHUB_TOKEN`. No git implementation in the bundle.
- **Upgrade — isomorphic-git over the vfs.** When richer workflows
  matter (history, diff against ancestors, multi-commit sessions):
  shallow-fetch (depth 1) into the vfs, commit locally, push.
  Surfaced to the agent either as the same tool or as a just-bash
  `git` command emulated as a wrapper around isomorphic-git — the
  S3 spike already saw `createGitClient()` wire up in-DO.

The agent-facing tool (e.g. `commit_and_push` / `open_pr`, or the
emulated `git` command) is defined in `@criblio/cell-workspace` so the
backend can swap without touching payloads.

### 4.4 What "Pi in the cell" looks like

`AgentSessionDO` alarm → rehydrate `Agent` from `agent_messages` →
`continue()` (or `prompt()` on the first turn / a queued user
follow-up) with `shouldStopAfterTurn: () => true` → adapter maps
events to `WireLoopEvent`s → persist messages + transcript rows →
schedule next alarm. Same durability envelope as today (turn fits
celld's 300s budget; TURN_TIMEOUT watchdog stays).

## 5. Migration path (small PRs)

1. **Generalize in place (apm repo).** Define `CellPayload`, rename
   DO schema/types to generic names, route APM specifics through
   the seam. No repo moves; proven against the live cell.
2. **Extract `agent-protocol`** into the framework; cell + UI import
   it; add the `LoopEvent` drift assertion.
3. **Swap the turn runner to pi-agent-core** behind the existing
   wire protocol (stub agent + smokes unchanged). Can precede or
   follow #2.
4. **Move harness + workspace to the framework packages**; apm
   `cell/` drops to payload + entry + deploy. Verify `celld deploy`
   esbuild bundling resolves the framework packages (today the
   cell's package.json is standalone).
5. **Workspace upgrade**: RepoStore → `@cloudflare/computer` vfs;
   add write/edit/bash tools + custom TS commands.
6. **Scaffold the coding app** (this is when
   `create-cribl-app --with-cell` earns its keep).

## 6. npm publishing — retiring the SHA pin

Yes — extraction is the forcing function. Two apps × `file:../` +
`.framework-sha` discipline is misery (the pin exists because local
checkouts drift; CI clones at the SHA; devs must manually stay
aligned). Publishing gives semver, lockfile-pinned installs, no
local checkout requirement, and the cell's standalone package.json
can depend on `@criblio/cell-harness` like any dep.

- **Mechanics**: framework monorepo publishes per-package
  (changesets or a plain version-tag workflow — changesets
  recommended for multi-package). Apps depend on `^x.y.z`; a bump
  is a normal lockfile PR (Dependabot-able). Framework development
  against a local checkout uses `npm link`/overrides, no longer the
  default wiring.
- **Registry: GitHub Packages under `criblio` (decided).** Auth via
  existing gh tokens; `.npmrc` per dev + `NODE_AUTH_TOKEN` in CI.
  Scope must match the org, so packages publish as `@criblio/*`
  (decision 6 covers the `@cribl/app-utils` naming migration). A
  public npmjs move later is nondestructive.
- The `release-build` action's SHA assertion and `.framework-sha`
  die with the migration; CI just `npm ci`s.

## 7. Open questions

All four first-round questions were resolved 2026-08-20 (decisions
6–8). Remaining:

1. **`@cribl/*` → `@criblio/*` migration mechanics** for the
   existing framework packages: republish under the new scope and
   update imports, or keep import paths via npm aliasing. Decide in
   the publishing PR.

## Appendix: spike artifacts

- `spike-pi-agent-core.mjs` — the turn-stepping/rehydration spike
  (5/5 PASS on 0.84.2, 2026-08-20).
- Prior art this design leans on: S3 spike (`../server-investigations/design.md`
  §"S3 live test") proving Workspace vfs + just-bash in-DO on celld;
  `../server-investigations/code-investigation.md` for the checkout
  design the workspace package inherits.
