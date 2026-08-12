# Cell infrastructure (AWS, Terraform)

One celld node + one S3 fleet bucket. The instance is disposable by
construction — celld replicates every cell's SQLite to the bucket,
so `terraform apply` replacing the node loses nothing (given a
graceful stop; the systemd unit handles that).

## One-time: AWS SSO on a new machine

```bash
aws configure sso
#   SSO session name : apm-cell
#   SSO start URL    : <your IAM Identity Center start URL>
#   SSO region       : <identity center region>
#   Account / role   : pick the target account + role
#   Profile name     : apm-cell        <- matches var.aws_profile
aws sso login --profile apm-cell      # re-run when the session expires
aws sts get-caller-identity --profile apm-cell   # sanity check
```

## One-time: secrets (out of Terraform state, on purpose)

```bash
for k in WEBHOOK_BEARER UI_BEARER TICKET_SECRET; do
  aws ssm put-parameter --profile apm-cell \
    --name "/apm-cell/$k" --type SecureString \
    --value "$(openssl rand -hex 32)"
done
```

The instance reads these at boot into `CELLD_VAR_*` (root-only env
file). Rotate by updating the parameter and replacing the instance
(`terraform apply -replace=aws_instance.cell`). PR 7 adds
`CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` / the LLM endpoint key to
this list.

## Apply

```bash
cd cell/infra
terraform init
terraform apply \
  -var bucket_name=<globally-unique-bucket> \
  -var domain=<cell.example.com>   # omit for HTTP-only dev
```

Then point the domain's A record at the `public_ip` output. Caddy
picks up the ACME certificate on first request.

## Deploy the cell code

```bash
# from the repo root, with the same SSO profile
AWS_PROFILE=apm-cell celld deploy cell --bucket s3://<bucket>
aws ssm start-session --profile apm-cell --target <instance_id> \
  -- 'sudo systemctl restart celld'   # nodes load deployments at startup
```

## Operational notes

- **Always stop celld gracefully** (systemd does: SIGTERM,
  `TimeoutStopSec=90`). A hard kill can lose the last seconds of
  cell writes (S2 spike finding). The Cribl-dataset `investigated`
  events remain the durable record regardless.
- No SSH: use SSM Session Manager (`aws ssm start-session`).
- The security group exposes only 80/443; celld itself listens on
  loopback behind Caddy.
- Terraform state is local for now (single operator). Move to an S3
  backend when that stops being true.
