# 2026-08-10 — Server-side investigations: kickoff (spikes + PR 2)

**Outcome**: execution started on the
[server-investigations design](../research/server-investigations/design.md).
Spike **S2 (celld viability) passed** with two design-shaping
findings; **S3 (Cloudflare Computer)** was reframed and mostly
resolved by research; **PR 2 (SearchClient injection seam) is up**
([#120](https://github.com/criblio/apm/pull/120)). S1 and S4 are
blocked on restoring `.env` (see Blockers).

## S2 — celld viability: PASS

Ran celld v0.1.0 (prebuilt binary) locally against MinIO, deployed a
spike Worker+DO mirroring the investigator's shape, and verified
live: DO SQLite (`sql.exec`), hibernatable WebSockets with since-seq
backlog replay + live fanout, outbound HTTPS fetch from the DO, and
full state recovery on a fresh node from the S3 bucket alone.

Two findings that changed the design (now recorded in the design
doc's "Spike results" section):

1. **The agent loop must be alarm-driven.** celld kills handler work
   at a 300s budget (`CELLD_HANDLER_BUDGET_S`) — a long
   post-response loop died mid-run at ~5min. One-turn-per-DO-alarm
   works and was verified to **survive a SIGKILL of the node
   mid-investigation**: a fresh node picked up the durable alarm
   chain and completed the remaining turns.
2. **Replication durability is asymmetric.** SIGTERM flushes
   cleanly; SIGKILL during a long handler lost the last ~15s of
   writes, while alarm-per-turn commits all survived. Deploy with
   graceful shutdown; the Cribl-dataset `investigated` commit stays
   the durable record.

## S3 — Cloudflare Computer: reframed

`@cloudflare/computer` is an npm package instantiated **inside your
own DO** (`new Workspace({storage: ctx.storage, backends})`), not a
remote service. Its container backend needs the Cloudflare
Containers binding (unavailable on celld), but the worker-shell
("just-bash") backend does not. Remaining S3 work is narrower: run
`Workspace` + worker-shell inside a celld DO (celld's experimental
`CELLD_WORKER_LOADER` maps to the Dynamic Workers dependency).

## PR 2 — SearchClient injection seam ([#120](https://github.com/criblio/apm/pull/120))

`src/api/searchClient.ts` (interface + `browserSearchClient`
default), threaded through `getTrace` / `listServiceSummaries` /
`listRecentDeploys` / `runPreflight`, executors rebuilt as
`createApmToolExecutors({client, dataset, metricsDataset})` with the
module-level browser exports preserved, `buildAlertSeed()` extracted
into `agentContext.ts` (AlertsPage now uses it). Zero browser
behavior change; 359/359 tests, lint + tsc clean. New pins:
`browserFree.test.ts` (non-browser surface runs against a stub
client in plain node) and `buildAlertSeed.test.ts`.

## Blockers / next session

- **`.env` is missing on the dev box** (only `.env.example` is
  present; the running `cribl-mcp-server` container has the values
  but the permission classifier — correctly — stops Claude from
  extracting credentials out of it). Restore `.env` with
  `CRIBL_BASE_URL` / `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET`
  (+ test login vars per `.env.example`), then:
  - **S1**: Playwright WS-from-iframe CSP probe (needs a `wss://`
    echo endpoint reachable from staging).
  - **S4**: notification-target API probe (list/create/delete a
    webhook target; capture a real payload).
- Framework checkout note: local
  `cribl-search-app-framework` HEAD is one commit ahead of
  `.framework-sha` (an unrelated viz fix); left as-is, CI clones
  the pin.
- After #119/#120 land: PR 3 (flag plumbing) and PR 4/5
  (proxies-manifest tooling) have no external dependencies and can
  proceed without the blocked spikes.

## Overnight continuation (same date, autonomous)

Clint set an overnight goal: get as far as possible without
intervention, stalling on the hosting decision (likely his AWS).
Progress:

- **PR 3 — flag plumbing** shipped:
  [#121](https://github.com/criblio/apm/pull/121). `serverInvestigations`
  off-by-default (pinned by a test), Settings card, hydration,
  provisioner loading. Dark — no consumer.
- **PR 4 — framework proxies-manifest tooling** shipped:
  [cribl-search-app-framework#22](https://github.com/criblio/cribl-search-app-framework/pull/22).
  `--proxies-manifest` deep-compares the packaged proxies.yml
  against a committed expected manifest (empty manifest ≡ today's
  `--require-empty-proxies`); 11/11 tooling tests. PR-5 note: the
  archive path is `default/proxies.yml`, and the server's
  preinstall-check `proxies` shape may need a normalization shim
  when the real manifest lands.
- **PR 6 — cell scaffold** shipped:
  [#122](https://github.com/criblio/apm/pull/122). `cell/` workspace:
  CoordinatorDO (event_id dedupe, queue, concurrency 1, hourly cap),
  **alarm-driven InvestigationDO** (one turn per alarm), stub agent
  with shape-faithful `ui` payloads, closed-by-default auth (webhook
  bearer / UI bearer / HMAC WS tickets). **Validated on local celld
  v0.1.0 + MinIO: `cell/scripts/smoke.mjs` 16/16** — fire, dedupe
  across webhook envelope shapes, alarm turns, conclusion, poll
  transport, ticketed WS replay from mid-stream.
- **S3 spike concluded** (see design doc): Workspace vfs and
  **just-bash-in-the-DO work under celld**; the dynamic-worker
  shell path is blocked on celld loader maturity (capability stubs
  in env). PR 12 gets an in-DO shell backend as celld-primary.
- **PR 7 de-risked**: `@earendil-works/pi-agent-core` +
  `@earendil-works/pi-ai` (v0.84.1) bundle cleanly for a
  neutral/worker target — 631KB, zero `node:` imports in the final
  graph; node-only machinery is segregated under the package's
  `./node` export (and celld provides `node:` modules anyway).
  Caveat for PR 7: pi-ai may lazy-import providers — confirm the
  OpenAI-compatible path is statically included in the cell bundle.
- **Held decision**: celld hosting (likely Clint's AWS — one node +
  an S3 bucket; the cell README documents exactly what a host needs,
  including graceful-shutdown requirements).
- **Still blocked on `.env`**: S1 (WS-from-iframe CSP) and S4
  (notification-target probe).

## Artifacts

- Design doc updated in-place with the "Spike results (2026-08-10)"
  section (PR [#119](https://github.com/criblio/apm/pull/119)).
- PR [#120](https://github.com/criblio/apm/pull/120) — the PR 2
  refactor.
- Spike worker source lives only in the session scratchpad (ad-hoc,
  per repo convention); its findings are fully recorded in the
  design doc.
