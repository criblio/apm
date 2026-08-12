# Infra handoff — bringing the cell live from the infra VM

Audience: a Claude Code session running on the **infra VM** (the
one on the right Tailscale network for AWS provisioning — not the
dev box). Goal: apply the Terraform in this directory, deploy the
cell code to the fleet bucket, and verify the cell is publicly
serving. Everything you need is in this file plus `README.md`; the
feature design is `docs/research/server-investigations/design.md`.

## What already exists (do not redo)

- The cell code (`cell/`) works: smoke-tested 16/16 on a local
  celld v0.1.0 + MinIO (PR #122). The agent is a stub; that's
  expected (real loop lands in PR 7).
- The Terraform here validates (`terraform validate`, `fmt` clean)
  but has **never been applied**.
- Spike facts you should trust: graceful stop matters (hard kill
  loses last seconds of writes); the UI will poll, not use WS; the
  Cribl notification target is API-managed later from the dev box.

## Prerequisites on the infra VM

1. This repo, on branch `feat/cell-terraform` (or `master` once
   PRs #122/#124 merge).
2. `terraform` ≥ 1.6, `aws` CLI v2, `node` ≥ 22 (for the smoke
   script), `curl`.
3. AWS SSO — **interactive, Clint drives**: follow README.md
   ("One-time: AWS SSO"). Profile name `apm-cell` (or override
   `-var aws_profile=`).

## Inputs Clint must provide

- `bucket_name` — globally-unique S3 bucket name.
- `domain` — public hostname for the cell (e.g.
  `apm-cell.<his-domain>`). He also needs DNS control for it.

## Steps

```bash
cd cell/infra

# 1. Secrets (once). Random 32-byte hex each; never in TF state.
for k in WEBHOOK_BEARER UI_BEARER TICKET_SECRET; do
  aws ssm put-parameter --profile apm-cell \
    --name "/apm-cell/$k" --type SecureString \
    --value "$(openssl rand -hex 32)"
done

# 2. Apply.
terraform init
terraform apply -var bucket_name=<bucket> -var domain=<domain>
# Outputs: public_ip, bucket, instance_id, cell_url.

# 3. DNS (Clint): A record <domain> -> public_ip. Wait for it to
#    resolve before expecting TLS to work (Caddy does ACME on the
#    first request; port 80 must reach the instance).

# 4. Deploy the cell code to the bucket. celld bundles with esbuild:
npm install --prefix /tmp/esb esbuild
curl -fsSL -o /tmp/celld.gz \
  "https://github.com/denoland/celld/releases/download/v0.1.0/celld-$(uname -m | sed 's/x86_64/x86_64/;s/aarch64/aarch64/')-unknown-linux-gnu.gz"
gunzip -f /tmp/celld.gz && chmod +x /tmp/celld
CELLD_ESBUILD=/tmp/esb/node_modules/.bin/esbuild \
AWS_PROFILE=apm-cell \
/tmp/celld deploy ../../cell --bucket s3://<bucket>
# ("Nodes load a deployment at startup" — so:)

# 5. Restart celld on the node (graceful — systemd handles SIGTERM):
aws ssm start-session --profile apm-cell \
  --target <instance_id> -- 'sudo systemctl restart celld'
# If start-session document syntax fights you:
#   aws ssm send-command --profile apm-cell \
#     --instance-ids <instance_id> \
#     --document-name AWS-RunShellScript \
#     --parameters commands='sudo systemctl restart celld'

# 6. Verify.
curl -s https://<domain>/healthz          # {"ok":true,"disabled":false}
WEBHOOK_BEARER=$(aws ssm get-parameter --profile apm-cell \
  --name /apm-cell/WEBHOOK_BEARER --with-decryption \
  --query Parameter.Value --output text)
UI_BEARER=$(aws ssm get-parameter --profile apm-cell \
  --name /apm-cell/UI_BEARER --with-decryption \
  --query Parameter.Value --output text)
CELL_URL=https://<domain> WEBHOOK_BEARER=$WEBHOOK_BEARER \
  UI_BEARER=$UI_BEARER node ../scripts/smoke.mjs
# Expect: SMOKE PASS (16/16). The WS checks are valid from a VM
# (the CSP restriction only applies inside the Cribl iframe).
```

## Failure modes seen before

- **First request after a node restart can 503/route-error for
  ~10-15s** (ownership lease + replica restore). Retry before
  digging.
- **ACME fails** until DNS resolves and port 80 is reachable —
  check `sudo journalctl -u caddy` via a session.
- **cloud-init failures** land in `/var/log/apm-cell-init.log` on
  the instance (SSM session). Most likely cause: a missing SSM
  parameter — the boot script fails loudly on purpose.
- Never `kill -9` celld; always `systemctl stop/restart`.

## Report back to the dev-box session (via Clint or a session doc)

1. `cell_url`, `public_ip`, `instance_id`, `bucket` outputs.
2. Smoke result (should be 16/16).
3. Any drift you had to make to Terraform or this doc — commit it
   to the branch so the repo stays the source of truth.

The dev-box session then continues with: proxies.yml + expected
manifest pointing at `<domain>` (PR 11), the notification target
against the live `/alerts/fire` + envelope capture (PR 9 prep),
and the UI transport work — none of which run from the infra VM.
