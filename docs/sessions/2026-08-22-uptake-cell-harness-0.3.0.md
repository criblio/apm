# Uptake: cell-harness 0.3.0, agent-protocol 0.2.0, celld v0.3.0

**Date:** 2026-08-22
**Branch:** `feat/uptake-cell-harness-0.3.0` (stacked on `refactor/cell-infra-fleet-module`, PR #155)

The framework grew a set of changes while Kidder was being built. This
session took them into APM: the two npm packages, the celld 0.3.0
runtime, and the infra + docs changes consuming them.

## What landed

### 1. Dependencies (`5dea567`)

```
@criblio/agent-protocol  ^0.1.1 → ^0.2.0
@criblio/cell-harness    ^0.1.1 → ^0.3.0
```

`app-utils ^0.5.1`, `cell-workspace ^0.1.1`, `app-tooling ^0.2.0` were
already at the latest published versions.

**Every change is additive — no APM source edits were needed.** Verified
rather than assumed:

| Framework change | Why APM needs no edit |
|---|---|
| `Env` now extends `CellEnv` from the harness | `CellEnv` is a **name-identical superset** of what APM declared, so the node's existing `/etc/celld/env` still binds. No SSM or Terraform change. |
| `createTools(env, sql?)` gained a param | Optional. APM's payload is API-backed and ignores `sql`. |
| `PayloadSqlHandle` new export | New symbol; nothing to migrate. |
| `imageCount?` on tool frames | Optional, and the UI imports wire types from `@criblio/agent-protocol` rather than mirroring them — the type widens with no edit. |
| `LLM_VISION?` env var | Optional; deliberately left unset (see below). |
| `agent_images` table | `CREATE TABLE IF NOT EXISTS` runs in the session DO constructor, so existing DOs gain it on rehydration. **No migration.** |
| DO class names | `CoordinatorDO` / `InvestigationDO` unchanged, so durable state stays addressable across the deploy. |

**The headline behavior change: a bounded watchdog.**
`MAX_WATCHDOG_ATTEMPTS = 3`, counted in durable storage under
`watchdogAttempts`, written *before* the turn (the isolate dying is the
event being counted, so it can't be written after). Previously the retry
was unbounded — a turn whose tool overran celld's handler budget killed
the process and got retried forever, restarting the node every ~240s
(`TURN_WATCHDOG_MS`).

### 2. Infra (`cd73be7`, includes the merge of #155)

- **celld `v0.2.0` → `v0.3.0`** (`var.celld_version`).
- **`CELLD_DURABILITY` pinned to `fleet`** (`var.celld_durability`).
  v0.3.0 added a replicated write-behind log and moved the default
  write-ack posture from `bucket` to `fleet`. That reads like a
  regression on a single-node fleet but isn't: with no peers celld
  behaves exactly like sync-to-bucket — "no peers means no record, no
  shipper, and bucket-proven acks" — and it starts using peers the
  moment one joins. Pinned rather than defaulted so a future celld
  default change can't move this node's durability without showing up
  in a plan.
- **`CELLD_HANDLER_BUDGET_S` pinned at the default, 300**
  (`var.celld_handler_budget_s`). Exceeding it kills the celld
  **process**, not just the isolate, so every session on the node dies
  — this is the budget the bounded watchdog stops retrying against.
  Pinned for visibility.
- **Module source is now a pinned git ref**, not a sibling checkout:
  `git::https://github.com/criblio/cribl-search-app-framework.git//infra/celld-fleet?ref=4ecc2d7`.
  The app stopped consuming the framework from `file:../` when it moved
  to GitHub Packages, so nothing guarantees a checkout sits next to
  this one, and `terraform init` on a fresh machine has to resolve
  without one. The repo is public, so https needs no credentials.
- **`required_secret_keys = ["UI_BEARER", "TICKET_SECRET", "LLM_API_KEY"]`.**
  Only these three abort the boot. `WEBHOOK_BEARER` only guards
  `POST /alerts/fire`, and the coordinator *pulls* firing alerts from
  `$vt_results` now (`coordinatorDO` → `payload.pollTriggers(env)`), so
  autonomous investigation survives its absence. `CRIBL_CLIENT_ID/SECRET`
  are checked at use. Skipped keys land in `/etc/celld/missing-secrets`.
- **Staging config moved from `-var` flags into `variables.tf` defaults**
  (`llm_base_url`, `cribl_base_url`). All of them render into `user_data`
  under `user_data_replace_on_change = true`, so an apply that forgot a
  flag would replace the node into stub mode (empty `llm_base_url` ⇒ no
  agent loop) **with no error**. `bucket_name` is the only flag now.

### 3. Docs + lint (`839ec0e`)

`DEPLOY.md` / `cell/infra/README.md` updated for all of the above;
`cell/README.md` documents `LLM_VISION` and `TURN_BUDGET`.
`eslint.config.js` ignores `**/.terraform/` — the pinned git module
means `terraform init` drops a full framework clone in there, and lint
failed on vendored source (2 × `react-refresh/only-export-components`).
It's gitignored, but eslint doesn't read `.gitignore`.

## Deployment: what's done, what's pending

Deliberately sequenced one variable at a time, so a bad bundle would
still have a live node to roll back on.

**Done — new bundle deployed and verified on the existing node:**

- `celld deploy` → version **`9d5358e345bf0c41`** (was `7bd185e1a91dd9d7`).
  `deploy/current.json` confirmed pointing at it *before* the restart —
  last session's trap was the pointer lagging a newer bundle in the
  bucket, leaving the node on old code all day.
- Bundle diff confirms the new harness is actually in the artifact:
  `watchdogAttempts` present in the new `index.js`, absent from the old.
- Restart via SSM (`systemctl restart celld`, graceful SIGTERM).
- **No state lost:** 30 investigations before, 30 after, 0 lost, 0 new,
  0 title/status drift. All DOs restored at `fresh=false`.
  `journalctl -p warning` → *No entries*. `Started celld` = 1 (no
  crash-loop).
- **Real end-to-end investigation on the new bundle**
  (`inv-ed5faf29-0300-43b8-ae45-7dafc645bde1`): 69 frames, 19 real tool
  calls against live staging, found 393 error `oteldemo.PaymentService/Charge`
  spans with sub-ms latency. It ended `failed` on
  *"hit the 12-turn cap without concluding"* — **not a regression**: the
  identical string is in the old bundle, and autonomous mode is
  hard-capped at `MAX_TURNS = 12` regardless of `TURN_BUDGET`
  (`sessionDO.js:832` — `interactive ? row.turn_budget : MAX_TURNS`).
  Worth revisiting separately; it's a pre-existing cap, not something
  this uptake changed.

**Pending — needs an explicit `terraform apply`:**

The celld 0.2.0 → 0.3.0 binary upgrade requires replacing the instance.
The plan is verified and saved, blast radius confirmed from the plan
JSON:

```
delete,create  module.fleet.aws_eip_association.cell   (replace: instance_id)
delete,create  module.fleet.aws_instance.cell          (replace: user_data)
10 no-ops
Plan: 2 to add, 0 to change, 2 to destroy.
```

The EIP is a separate resource, so **`cell_url` stays
`https://54-71-34-177.sslip.io`** and all durable state survives (it
lives in the bucket). Pre-flight checks already done: `user_data`
rendered through `templatefile` and `bash -n`'d, and the celld v0.3.0
aarch64 release asset returns 200 (a 404 would brick the replacement
node on boot).

```bash
cd cell/infra
terraform apply -var bucket_name=cribl-apm-cell-test
# then, after it comes up:
curl -s $(terraform output -raw cell_url)/healthz
```

The node currently runs celld 0.2.0 with neither new env var. Because
the bundle is already deployed, that apply is the only remaining step.

## Traps worth remembering

- **celld version IDs are content hashes.** Deploying identical bytes
  reproduces the same ID and overwrites that prefix. `current.json` is a
  *separate* pointer, so the bucket can hold a newer bundle than the
  pointer selects — always check the pointer, not just the upload.
- **Downgrading off v0.3.0 is one-way-ish.** v0.2.1→v0.3.0 can roll one
  node at a time, but do not start a v0.2.x binary on a node that has
  run v0.3.0 unless its shutdown log shows `node-log close: sealed
  epoch` — v0.2.x can't read the replicated log and the downgrade can
  lose acknowledged writes. Roll forward.
- **celld 0.2.0 exposes no version/status endpoint** on either listener
  (`/status`, `/version`, `/metrics` all `{"error":"not_found"}`), and
  `runtime_version` in its logs is celld's own runtime, not the bundle.
  To prove which bundle a node loaded, check `current.json` before the
  restart and probe behavior after.
- **`LLM_VISION` stays off.** The pinned model is text-only; pi-ai
  silently *drops* images for an undeclared model, while most providers
  hard-fail image parts sent to a text-only one. APM's UI doesn't attach
  images.
- **`aws ssm send-command --parameters commands='…'`** can't take a
  shell string containing `"` — the CLI's shorthand parser fails with
  `Expected: ',' received: '"'`. Use `--parameters file://params.json`.
