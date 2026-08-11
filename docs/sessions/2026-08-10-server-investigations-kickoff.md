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

## Artifacts

- Design doc updated in-place with the "Spike results (2026-08-10)"
  section (PR [#119](https://github.com/criblio/apm/pull/119)).
- PR [#120](https://github.com/criblio/apm/pull/120) — the PR 2
  refactor.
- Spike worker source lives only in the session scratchpad (ad-hoc,
  per repo convention); its findings are fully recorded in the
  design doc.
