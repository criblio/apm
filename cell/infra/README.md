# Cell infrastructure (AWS, Terraform)

One celld node + one S3 fleet bucket. The instance is disposable by
construction — celld replicates every cell's SQLite to the bucket,
so `terraform apply` replacing the node loses nothing (given a
graceful stop; the systemd unit handles that).

**This is a thin root over a shared module.** The resources live in
the framework's `infra/celld-fleet` (extracted from this stack in PRs
#129/#130/#132); `main.tf` here supplies only this fleet's identity —
`cell_name = "apm-cell"`, the bucket, the SSM prefix, and the two env
inputs (`secret_env_keys` for SSM SecureStrings, `plain_env` for
non-secret values). The provider and the S3 backend stay in this root.
The module is consumed as a **pinned git ref** on the framework's
master (`git::https://…//infra/celld-fleet?ref=<sha>`). The repo is
public, so this resolves with no credentials. It used to be a sibling
checkout pinned by `.framework-sha`; that record retired when the app
moved to GitHub Packages, and a path source would have made
`terraform init` depend on an adjacent clone. Bump the `ref` the way
you'd bump a dependency.

The `moved` blocks at the bottom of `main.tf` record the state
migration from the pre-module addresses into `module.fleet.*`. Leave
them in place.

## Picking this up on a new machine

Nothing here depends on a particular laptop — state is in S3, secrets
are in SSM. From a fresh clone:

```bash
aws sso login --profile test            # only interactive step
cd cell/infra
terraform init                          # installs the module + remote state
terraform output                        # cell_url, public_ip, instance_id, bucket
terraform plan -var bucket_name=cribl-apm-cell-test   # expect: No changes
```

`terraform init` fetches the module from GitHub at the pinned ref — no
framework clone needed. After moving that `ref` in `main.tf`, re-run
`terraform init -upgrade` before planning, or Terraform keeps using the
module it already cached.

Then confirm the cell is serving and run the smoke suite:

```bash
curl -s $(terraform output -raw cell_url)/healthz     # {"ok":true,"disabled":false}

cd ../..
WEBHOOK_BEARER=$(aws ssm get-parameter --profile test --region us-west-2 \
  --name /apm-cell/WEBHOOK_BEARER --with-decryption --query Parameter.Value --output text) \
UI_BEARER=$(aws ssm get-parameter --profile test --region us-west-2 \
  --name /apm-cell/UI_BEARER --with-decryption --query Parameter.Value --output text) \
CELL_URL=https://54-71-34-177.sslip.io node cell/scripts/smoke.mjs
```

Tooling needed: `terraform` ≥ 1.6, `aws` CLI v2, `node` ≥ 22. The only
repo-external thing is the root `.env` (gitignored) for the *app* side —
`CRIBL_BASE_URL`, `CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET`; see
`.env.example`. The cell itself needs none of it.

## AWS account / profile

Currently applied in the Cribl **test** account (`243602015558`) with
the existing `test` SSO profile — `var.aws_profile` defaults to it.

```bash
aws sso login --profile test      # re-run when the session expires
aws sts get-caller-identity --profile test
```

**Region is `us-west-2`, not us-east-1.** The `TestAccountPowerUser`
permission set is scoped to us-west-2 ("limited to us-west-2 for any
actions" per the role description); EC2/SSM/Secrets Manager calls in
other regions fail with `AccessDenied`/`UnauthorizedOperation` even
though S3 (global namespace) appears to work. `var.region` defaults
to us-west-2 accordingly.

On a fresh account, set up a dedicated profile instead:

```bash
aws configure sso    # profile name must match var.aws_profile
```

## One-time: secrets (out of Terraform state, on purpose)

```bash
for k in WEBHOOK_BEARER UI_BEARER TICKET_SECRET; do
  aws ssm put-parameter --profile test --region us-west-2 \
    --name "/apm-cell/$k" --type SecureString \
    --value "$(openssl rand -hex 32)" --no-overwrite
done
```

(Already done in the test account — all three exist at version 1.)

The real agent loop adds three more: `LLM_API_KEY`, `CRIBL_CLIENT_ID`,
`CRIBL_CLIENT_SECRET`. All six are named in `secret_env_keys` in
`main.tf`, and the instance reads exactly that list at boot into
`CELLD_VAR_*` (root-only env file).

**Only three of the six abort the boot** — the ones named in
`required_secret_keys`:

| Secret | Missing ⇒ | Why |
|---|---|---|
| `UI_BEARER` | **boot aborts** | Gates every UI route, and `bearerOk()` treats unset as *closed*. Without it the node comes up 401-ing the app — up and unusable, which is worse than not up. |
| `TICKET_SECRET` | **boot aborts** | Gates the WS tickets the transcript streams over. |
| `LLM_API_KEY` | **boot aborts** | Gates the agent loop; an investigator that can't reach a model has nothing to offer. |
| `WEBHOOK_BEARER` | warns | Only guards `POST /alerts/fire`. The coordinator *pulls* firing alerts from `$vt_results` now, so autonomous investigation still runs. |
| `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` | warns | Checked at use — the cell reports "not configured" in the transcript instead of costing you the node. |

Skipped keys are warned about in `/var/log/apm-cell-init.log` and
listed one per line in `/etc/celld/missing-secrets`. Check both when a
feature reports itself unconfigured on a node you thought was fully
provisioned. All six exist in the test account, so this changes nothing
about the current node — it decides what happens to the next one.

Note SSM rejects an empty `SecureString`, so "set it blank to disable"
isn't available; omit the parameter (now non-fatal for the optional
three) or drop the key from `secret_env_keys`.

Rotate by updating the parameter and replacing the instance
(`terraform apply -replace=module.fleet.aws_instance.cell` — note the
module-qualified address).

## Apply

```bash
cd cell/infra
terraform init
terraform apply -var bucket_name=<globally-unique-bucket>
```

`bucket_name` is the only input without a default. In particular the
agent-loop config (`llm_base_url`, `llm_model`, `cribl_base_url`,
`cribl_dataset`) now **defaults to the live staging values** rather
than being passed as `-var` flags from a runbook. All four render into
`user_data`, and `user_data_replace_on_change = true`, so an apply that
forgot a flag would replace the node and quietly bring it back in stub
mode (empty `llm_base_url` ⇒ no agent loop, no error). Config the node
can't run without belongs where a bare `terraform apply` finds it.

**No DNS setup required.** The hostname is derived from the Elastic IP
via [sslip.io](https://sslip.io) — EIP `54.71.34.177` becomes
`54-71-34-177.sslip.io`, which resolves publicly with no zone to
manage. Caddy gets a real Let's Encrypt cert for it on first request,
so `cell_url` is trusted HTTPS out of the box. The EIP is a separate
resource from the instance, so replacing the node keeps the hostname
stable; only destroying the EIP changes it. Swap to a real domain
(ALB + ACM, or an A record) when this stops being a POC.

## Deploy the cell code

celld's S3 client uses its own credential chain and does **not**
resolve SSO profiles — `AWS_PROFILE=test` alone makes it fall through
to IMDS and fail with `bucket unavailable or inaccessible`. Export
static credentials for the deploy:

```bash
# from the repo root
npm install --prefix /tmp/esb esbuild          # celld bundles with esbuild
eval "$(aws configure export-credentials --profile test --format env)"
CELLD_ESBUILD=/tmp/esb/node_modules/.bin/esbuild AWS_REGION=us-west-2 \
  celld deploy cell --bucket s3://cribl-apm-cell-test

aws ssm send-command --profile test --region us-west-2 \
  --instance-ids <instance_id> --document-name AWS-RunShellScript \
  --parameters commands='sudo systemctl restart celld'
```

**celld will not start until a deployment exists in the bucket.** With
an empty bucket it crash-loops on
`read s3://<bucket>/deploy/current.json: no such key` and Caddy
answers 502 — that is a missing deploy, not broken infra.

## Operational notes

- **Always stop celld gracefully** (systemd does: SIGTERM,
  `TimeoutStopSec=90`). A hard kill can lose the last seconds of
  cell writes (S2 spike finding). The Cribl-dataset `investigated`
  events remain the durable record regardless.
- No SSH: use SSM Session Manager (`aws ssm start-session`), or
  `aws ssm send-command` for one-shot commands.
- The security group exposes only 80/443; celld itself listens on
  loopback behind Caddy.
- **Every resource carries `Persistent = "true"`** (a provider
  `default_tags`) so the test account's reaper leaves the cell up.
  Anything added here inherits it automatically — don't opt out.
- **Caddy is installed from the official GitHub static binary**, not
  from dnf. AL2023 has no `caddy` package (`Unable to find a match:
  caddy`), which silently left the first apply with no TLS. Version is
  pinned in `var.caddy_version`.
- **celld is pinned to v0.3.0** (`var.celld_version`). v0.2.0 split
  the public listener from a new internal peer/operator listener; our
  public listener is loopback-only behind Caddy, so no
  `--internal-listen` is needed. It also dropped `CELLD_WORKERS`,
  `CELLD_MAX_COHOSTED`, `CELLD_MAX_CPU_PERCENT`, `CELLD_VALIDATE`, and
  renamed `CELLD_HIBERNATIONS` → `CELLD_EVICTIONS`; celld validates
  every variable at startup and refuses to boot on an unknown one, so
  keep the module's `user_data.sh.tftpl` env block in sync with
  `celld --help` (it lives in the framework repo now, so that edit is a
  framework PR affecting every cell).
  A fleet must never mix v0.1.0 and v0.2.0 nodes — v0.2.0 writes
  compacted block-format replication objects a v0.1.0 reader cannot
  restore. Upgrade by replacing all nodes, never rolling.
- **v0.3.0 durability: `CELLD_DURABILITY` is pinned to `fleet`**
  (`var.celld_durability`). v0.3.0 added a replicated write-behind log
  and moved the default write-ack posture from `bucket` to `fleet`.
  That reads like a durability regression on a single-node fleet but
  isn't: with no peers, celld "behaves exactly like sync-to-bucket —
  no peers means no record, no shipper, and bucket-proven acks", and it
  starts using peers the moment one joins. It's pinned explicitly, not
  left to the default, so a future celld default change can't move this
  node's durability without showing up in a plan. Set `bucket` to
  force bucket-proven acks on every write regardless of peers.
- **Downgrading off v0.3.0 is one-way-ish.** v0.2.1→v0.3.0 can roll a
  node at a time, but do NOT start a v0.2.x binary on a node that has
  run v0.3.0 unless its shutdown log shows `node-log close: sealed
  epoch` — v0.2.x can't read the replicated log, and the downgrade can
  lose acknowledged writes. Roll forward instead.
- **`CELLD_HANDLER_BUDGET_S` is pinned at celld's default, 300**
  (`var.celld_handler_budget_s`). Blowing this budget kills the celld
  *process*, not just the offending isolate, so every session on the
  node dies with it. cell-harness 0.3.0's bounded watchdog exists
  because of exactly that: a turn whose tool overran the budget used to
  be retried forever, restarting the node every ~240s. Keep in-cell
  work well inside the budget rather than raising it.
- **Terraform state lives in the fleet bucket**
  (`s3://cribl-apm-cell-test/terraform/cell-infra.tfstate`), with
  S3-native locking (`use_lockfile`) and bucket versioning as the
  recovery path. Nothing about this cell depends on one laptop: a fresh
  clone + `aws sso login --profile test` + `terraform init` gives you
  full control. Do not re-add local state.
- The account's auto-tagger stamps `AutoTag_Creator` /
  `AutoTagCreatorId` on create; the provider's `ignore_tags` keeps
  plans from fighting it. Without that, every plan shows a spurious
  tag-removal diff.
- **A security group's `description` is create-time.** Because the
  group's name is derived from `cell_name`, changing the description is
  a same-name destroy/create that fights the attached instance — so the
  module takes `security_group_description` and this root pins the
  original text. Treat any cosmetic string the module renders into a
  create-time argument the same way: make it an input, don't accept the
  replacement.
