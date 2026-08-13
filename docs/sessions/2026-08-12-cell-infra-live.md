# 2026-08-12 — Cell infra: first apply, live and smoke-passing

**Outcome**: the investigator cell is **live on AWS** at
[https://54-71-34-177.sslip.io](https://54-71-34-177.sslip.io), running
celld v0.2.0, smoke-passing **16/16**, with an interactive agent run
streamed end-to-end. Terraform state moved to S3, so the cell no longer
depends on any one machine. `cell/infra/HANDOFF.md` is deleted — its
runbook is now `cell/infra/README.md`, and everything it asked for is
done. PR [#130](https://github.com/criblio/apm/pull/130).

| | |
|---|---|
| `cell_url` | https://54-71-34-177.sslip.io |
| `public_ip` | 54.71.34.177 (EIP; survives node replacement) |
| `instance_id` | `i-0c56ce098677dd49d` |
| `bucket` | `cribl-apm-cell-test` |
| account / region | 243602015558 (Cribl test) / **us-west-2** |
| celld | v0.2.0, deployment `c071c551cabea6e9` |
| tf state | `s3://cribl-apm-cell-test/terraform/cell-infra.tfstate` |

## What the handoff got right

The cell code needed **zero changes**. PR #122's 16-check smoke suite
passed against real AWS + real TLS on the first run once a deployment
existed in the bucket. The two spike findings that shaped the design
both held up: graceful-stop matters (systemd `SIGTERM` +
`TimeoutStopSec=90`), and the alarm-per-turn loop survives node
replacement. The Terraform's shape (disposable node, durable bucket,
SSM-not-SSH, secrets out of state) was right as designed.

## Five things that only surfaced on a real apply

The Terraform validated but had never run. Four assumptions broke, plus
one that was flagged as "later" and turned out to be load-bearing.

1. **Region.** `TestAccountPowerUser` is scoped to us-west-2 ("limited
   to us-west-2 for any actions" in the role description). us-east-1
   EC2/SSM/Secrets Manager calls fail `AccessDenied` — but S3 works
   either way (global namespace), so this fails *late* and reads like a
   permissions problem rather than a region problem. Default is now
   us-west-2.
2. **Caddy is not in the AL2023 repos.** `dnf install -y caddy` →
   `Unable to find a match: caddy`. Because that line sat *after*
   `systemctl enable --now celld`, the first apply produced a node that
   looked healthy (celld active, cloud-init "running") but had **no TLS
   at all** and no `/etc/caddy` to hint why. Now installs the pinned
   official static binary (`var.caddy_version`) with a hand-written
   systemd unit. Lesson: `set -euo pipefail` makes cloud-init fail
   loudly, but only if you go read `cloud-init status --long` — a live
   celld is not evidence the boot script finished.
3. **HTTPS without DNS.** The handoff assumed Clint would create an A
   record. Instead the domain is derived from the EIP via
   [sslip.io](https://sslip.io) (`54-71-34-177.sslip.io` resolves to
   `54.71.34.177` with no zone), so Caddy gets a real Let's Encrypt cert
   unattended and `var.domain` is gone. The EIP is now its own resource
   *ahead of* the instance, so node replacement keeps the hostname —
   this is why the two instance replacements below didn't change the
   URL. POC-grade on purpose; ALB + ACM when it stops being a POC.
4. **`Persistent = "true"` on everything** via provider `default_tags`,
   or the test account's reaper eats the cell. Also needed
   `ignore_tags` for the account auto-tagger's `AutoTag_Creator` /
   `AutoTagCreatorId`, which otherwise makes every plan show a spurious
   tag-removal diff and fight the account automation.
5. **Local Terraform state was the real risk.** `terraform.tfstate` was
   gitignored on one laptop. Losing that file orphans all 11 resources —
   Terraform could neither update nor destroy them, and the EIP and
   instance would have to be cleaned up by hand. Migrated to an S3
   backend in the fleet bucket with `use_lockfile` (S3-native locking,
   no DynamoDB) and bucket versioning as the recovery path. Verified by
   deleting the local state and re-running `plan` → `No changes`.

## celld v0.1.0 → v0.2.0

v0.2.0 shipped the same day. Upgraded, and it was low-risk for us:

- Our env block needed no changes — we set none of the removed vars
  (`CELLD_WORKERS`, `CELLD_MAX_COHOSTED`, `CELLD_MAX_CPU_PERCENT`,
  `CELLD_VALIDATE`) and don't use the renamed `CELLD_HIBERNATIONS`.
- v0.2.0 splits the public listener from a new internal peer/operator
  listener, and a **non-loopback** public listener now *requires*
  `--internal-listen`. Ours is `127.0.0.1:8787` behind Caddy, so this
  doesn't apply — but it would if anyone ever exposes celld directly.
- Two constraints worth remembering: v0.2.0 **validates every variable
  at startup and refuses to boot on an unknown one**, so
  `user_data.sh.tftpl`'s env block now has to track `celld --help`; and
  a fleet must **never mix v0.1.0 and v0.2.0** nodes, because v0.2.0
  writes compacted block-format replication objects a v0.1.0 reader
  cannot restore. Upgrades are replace-all, never rolling.

## Two traps that cost the most time

Both now in `cell/infra/README.md`:

- **celld crash-loops until a deployment exists in the bucket**:
  `read s3://<bucket>/deploy/current.json: no such key`, `NRestarts`
  climbing past 100, and Caddy answering **502**. That reads as broken
  infra; it's a missing `celld deploy`. Sequencing matters — deploy the
  code *before* expecting a healthy node.
- **celld's S3 client does not resolve SSO profiles.** `AWS_PROFILE=test`
  alone falls through to IMDS and dies with `bucket unavailable or
  inaccessible` after retrying `169.254.169.254`. Needs
  `eval "$(aws configure export-credentials --profile test --format env)"`.

## Verification

Two instance replacements happened (Caddy fix, then the v0.2.0 bump);
the EIP made both invisible to the URL.

Final state — celld 0.2.0 and Caddy 2.10.2 both `active`,
`cloud-init status: done`, **`NRestarts=0`**, and:

```
$ curl -s https://54-71-34-177.sslip.io/healthz
{"ok":true,"disabled":false}

$ node cell/scripts/smoke.mjs      # 16/16
SMOKE PASS
```

**Interactive agent run** (ad-hoc driver, not committed) — fired a
`cart` error-rate alert and watched the turns arrive over the WebSocket
transport:

```
✓ POST /alerts/fire → HTTP 202 {"accepted":1}
✓ investigation inv-5a4a8645-2f5d-4777-abba-a53c94848255  status=running
  [hello] protocolVersion=1 latestSeq=0
  agent  Investigating the error_rate alert on cart. I'll start with the error breakdown.
  tool→  run_search
         query: dataset="otel" | where service_name == "cart" | summarize n=count() by status_code
  tool←  2 rows in 1200ms: [{"status_code":"ERROR","n":42},{"status_code":"OK","n":958}]
  …
  tool→  present_investigation_summary
  tool←  SUMMARY
         Root cause (stub): cart error rate elevated; concluded after 4 turns.
  ■ done reason=complete

▶ Cold replay via poll transport:
  13 events persisted, latestSeq=13, status=concluded
  seq/kind: 1:assistantText → 2:assistantDone → 3:toolCall → 4:toolResult → … → 13:done

▶ Same alert re-fired (target retry):
  HTTP 202 {"accepted":0} ← deduped, no second run
```

That exercises the parts PR 11's UI will depend on: WS `hello` +
frame shapes (`{type:'event', seq, ev}`), durable transcript replay from
a **cold** `GET /events?since=0`, and coordinator dedupe on
`incidentKey` so a retrying notification target can't double-run an
investigation. The agent is still #122's stub (canned text, fixed 4
turns) — PR 7 swaps in the real loop; the transport under it is real.

## Resuming on a different machine

The point of the state migration: **the repo plus an SSO login is
sufficient.** Nothing needs to come off this laptop.

```bash
git clone https://github.com/criblio/apm && cd apm
aws sso login --profile test
cd cell/infra && terraform init && terraform output
```

- **Terraform state** — S3 (`terraform/cell-infra.tfstate` in the fleet
  bucket). `terraform init` fetches it.
- **Cell secrets** — SSM SecureStrings at `/apm-cell/{WEBHOOK_BEARER,
  UI_BEARER,TICKET_SECRET}`. Never on disk, never in state; read them
  with `aws ssm get-parameter --with-decryption`.
- **App-side `.env`** — the one genuinely local file, and it is *not*
  needed for the cell: `CRIBL_BASE_URL`, `CRIBL_CLIENT_ID`,
  `CRIBL_CLIENT_SECRET` (see `.env.example`). Only the APM app / e2e
  tests use it. PR 7 will add Cribl + LLM creds to SSM for the cell.
- **Framework checkout** — `cribl-search-app-framework` at the SHA in
  `.framework-sha` (`4ee0c5d`), consumed via `file:..`. Cell work does
  not touch it.
- **Tooling** — `terraform` ≥ 1.6, `aws` CLI v2, `node` ≥ 22. For
  `celld deploy`: the celld binary
  ([releases](https://github.com/denoland/celld/releases)) + esbuild.

Not worth preserving: `/tmp/celld020`, `/tmp/esb`, the ad-hoc driver,
`.terraform/` (re-`init` regenerates it), and the deleted local state.

## Next

Unchanged from the design doc, all dev-box work:

- **PR 7** — real agent loop (pi-agent-core) replacing `stubAgent.ts`;
  adds `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` / LLM key to
  `/apm-cell/*` and to `user_data.sh.tftpl`'s secret loop.
- **PR 9 prep** — Cribl notification target against the live
  `/alerts/fire`, capturing the real envelope (S4's open question).
  Bearer is in SSM now.
- **PR 11** — `config/proxies.yml` + expected manifest pointing at
  `54-71-34-177.sslip.io`, `investigationTransport.ts`, and the
  `InvestigatePage` / `AlertsPage` wiring.

Worth noting for PR 11: the cell URL is a POC hostname. Anything that
pins it (proxies.yml, the expected manifest) will need a revisit when
this moves to a real domain.
