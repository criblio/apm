# Cell infrastructure (AWS, Terraform)

One celld node + one S3 fleet bucket. The instance is disposable by
construction — celld replicates every cell's SQLite to the bucket,
so `terraform apply` replacing the node loses nothing (given a
graceful stop; the systemd unit handles that).

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

The instance reads these at boot into `CELLD_VAR_*` (root-only env
file). Rotate by updating the parameter and replacing the instance
(`terraform apply -replace=aws_instance.cell`). PR 7 adds
`CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` / the LLM endpoint key to
this list.

## Apply

```bash
cd cell/infra
terraform init
terraform apply -var bucket_name=<globally-unique-bucket>
```

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
- **celld is pinned to v0.2.0** (`var.celld_version`). v0.2.0 splits
  the public listener from a new internal peer/operator listener; our
  public listener is loopback-only behind Caddy, so no
  `--internal-listen` is needed. It also drops `CELLD_WORKERS`,
  `CELLD_MAX_COHOSTED`, `CELLD_MAX_CPU_PERCENT`, `CELLD_VALIDATE`, and
  renames `CELLD_HIBERNATIONS` → `CELLD_EVICTIONS`; v0.2.0 validates
  every variable at startup and refuses to boot on an unknown one, so
  keep `user_data.sh.tftpl`'s env block in sync with `celld --help`.
  A fleet must never mix v0.1.0 and v0.2.0 nodes — v0.2.0 writes
  compacted block-format replication objects a v0.1.0 reader cannot
  restore. Upgrade by replacing all nodes, never rolling.
- Terraform state is local for now (single operator). Move to an S3
  backend when that stops being true.
