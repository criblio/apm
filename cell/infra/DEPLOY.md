# Cell redeploy + real-loop cutover — handoff

Audience: the Claude Code session on the **infra VM** (test-account
AWS creds, us-west-2). Goal: redeploy the celld node and cut the live
cell over from the stub agent to the **real investigator loop**
(PR #131), then verify a real investigation end-to-end.

The whole loop was already proven on a local celld against real
staging Cribl + OpenRouter (see the PR #131 body). This is the same
thing on the hosted node.

## What changed since the node was last applied

- **PR #131** (cell code) — the real pi-agent-core loop, metrics
  transport, the alarm re-entrancy guard (the fix that made it work),
  storage caps, and orphan-slot reclaim. The cell no longer reads
  the `serverInvestigations` flag (it's enforced app-side), so no
  override is needed.
- **This branch** (`cell/infra`) — `user_data` now also seeds the
  agent-loop env from three new SSM secrets + five Terraform config
  vars. Applying it is what carries LLM/Cribl config onto the node.

Merge/pull both before deploying.

## Prerequisites

- SSO to the test account: `aws sso login --profile test` (region
  `us-west-2`). Sanity: `aws sts get-caller-identity --profile test`.
- The Terraform S3 backend is already `s3://cribl-apm-cell-test`
  (`terraform/cell-infra.tfstate`); `terraform init` picks it up.
- `node` ≥ 22 + an `esbuild` binary for `celld deploy`.

## Step 1 — new SSM secrets (once, out of TF state)

The bearers already exist. Add the three real-loop secrets:

```bash
# OpenRouter key (the one Clint provided; rotate freely)
aws ssm put-parameter --profile test --region us-west-2 \
  --name /apm-cell/LLM_API_KEY --type SecureString --value "sk-or-v1-…"

# Cribl machine credentials (same client-credentials pair the app
# uses; from the apm repo .env: CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET)
aws ssm put-parameter --profile test --region us-west-2 \
  --name /apm-cell/CRIBL_CLIENT_ID --type SecureString --value "…"
aws ssm put-parameter --profile test --region us-west-2 \
  --name /apm-cell/CRIBL_CLIENT_SECRET --type SecureString --value "…"
```

The instance role is already scoped to `/apm-cell/*`, so no IAM
change is needed for the new keys.

## Step 2 — apply the infra (carries the loop config)

```bash
cd cell/infra
terraform init
terraform apply \
  -var bucket_name=cribl-apm-cell-test \
  -var llm_base_url=https://openrouter.ai/api/v1 \
  -var llm_model=deepseek/deepseek-v4-flash-0731 \
  -var cribl_base_url=https://main-objective-shirley-sho21r7.cribl-staging.cloud \
  -var cribl_dataset=otel
```

Setting `llm_base_url` flips the node from stub → real loop.
`user_data_replace_on_change=true` means this replaces the instance;
the EIP/URL and all durable state survive (state is in the bucket).

> **celld version bump** (if you want a newer celld than the pinned
> `v0.2.0`): add `-var celld_version=vX.Y.Z`. Two rules from the last
> bump — v0.2.0+ needs no `--internal-listen` because our listener is
> loopback-only behind Caddy; and **never mix versions in one fleet**
> (replication objects aren't backward-readable). Since this is a
> single node, `terraform apply` replacing it is a clean full
> replacement. If you ever run >1 node, replace them all.

## Step 3 — deploy the cell code to the bucket

`terraform apply` provisions the node but does **not** ship the cell
bundle; celld loads whatever deployment is in the bucket at startup.

```bash
# from the apm repo root, same SSO profile
eval "$(aws configure export-credentials --profile test --format env)"  # celld's S3 client ignores AWS_PROFILE (SSO) — export real creds
AWS_REGION=us-west-2 CELLD_ESBUILD=<path-to-esbuild> \
  celld deploy cell --bucket s3://cribl-apm-cell-test
# then load it:
aws ssm start-session --profile test --target <instance_id> \
  -- 'sudo systemctl restart celld'   # graceful; SIGTERM drains
```

`<instance_id>` is the `instance_id` Terraform output.

## Step 4 — verify end-to-end

```bash
BASE=https://54-71-34-177.sslip.io   # cell_url output
curl -s $BASE/healthz                # {"ok":true,"disabled":false}

# real-loop smoke: fire a synthetic alert, watch it investigate real
# staging data and conclude, and confirm the dataset commits.
WEBHOOK=$(aws ssm get-parameter --profile test --region us-west-2 \
  --name /apm-cell/WEBHOOK_BEARER --with-decryption --query Parameter.Value --output text)
UI=$(aws ssm get-parameter --profile test --region us-west-2 \
  --name /apm-cell/UI_BEARER --with-decryption --query Parameter.Value --output text)
CELL_URL=$BASE WEBHOOK_BEARER=$WEBHOOK UI_BEARER=$UI \
  node cell/scripts/smoke-real.mjs   # against the mock backends, OR
```

For a true real-data run, POST a firing alert directly and poll:

```bash
curl -s -X POST -H "authorization: Bearer $WEBHOOK" -H 'content-type: application/json' \
  -d '[{"event_id":"live:'$(date +%s)'","alert_id":"auto:health:payment","svc":"payment","signal_type":"error_rate","curr_error_rate":0.08}]' \
  $BASE/alerts/fire
# then poll $BASE/investigations and .../events?since=0 with the UI bearer
```

Expect: the investigation runs real KQL + PromQL against staging and
concludes, and `started`/`investigated` rows land in the `otel`
dataset (query `record_kind=="investigation"`). That is the full
loop.

## Failure modes (seen before)

- **502 from Caddy / `no such key deploy/current.json`** — the bucket
  has no deployment yet. Run Step 3.
- **`bucket unavailable or inaccessible`** — celld's S3 client didn't
  get creds. Use `aws configure export-credentials`, not `AWS_PROFILE`.
- **First request after restart 503s for ~10–15 s** — ownership lease
  + replica restore. Retry.
- **`cloud-init status` not `done`** — check `/var/log/apm-cell-init.log`
  via SSM; most likely a missing SSM parameter (Step 1).
- Never `kill -9` celld; `systemctl restart`.

## Report back

`cell_url`, `instance_id`, celld version, the smoke result, and any
drift you had to commit to this branch.

---

# CI/CD design — automated cell deploy on merge

Goal: on merge to `master` touching `cell/**`, build the cell bundle,
`celld deploy` it to the fleet bucket, and restart the node — with a
**dedicated IAM role scoped to exactly that**, assumed via GitHub
OIDC (no long-lived keys in the repo).

## The scoped deploy role

Create a role `apm-cell-deployer` (Terraform — add to `cell/infra`)
whose **trust policy** is the GitHub OIDC provider, restricted to this
repo, the `master` ref, and a named environment:

```hcl
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "deployer_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # Only the master branch of this repo, in the `cell-deploy` env.
      values   = ["repo:criblio/apm:ref:refs/heads/master",
                  "repo:criblio/apm:environment:cell-deploy"]
    }
  }
}
```

**Permissions** — three narrow grants, nothing more:

```hcl
data "aws_iam_policy_document" "deployer" {
  # 1. Write the deployment bundle to the bucket's deploy/ prefix only.
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.fleet.arn,
      "${aws_s3_bucket.fleet.arn}/deploy/*",
    ]
    # (ListBucket is on the bucket ARN; Put/Get on deploy/* — the
    #  deployer cannot touch replicated cell state or tf state.)
  }
  # 2. Restart celld on the node via SSM RunCommand, scoped to this
  #    instance and the AWS-RunShellScript document.
  statement {
    actions   = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.region}:*:instance/${aws_instance.cell.id}",
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }
  statement {
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]   # read-only status of the command it issued
  }
}
```

Notes on the scoping:
- **No `ssm:StartSession`, no SSH, no `ec2:*` mutating actions, no
  Terraform-state access.** The deployer can push a bundle and bounce
  the service — that is all.
- Deploy writes go to `deploy/*`; the cell's own SQLite replicas
  (other prefixes) and `terraform/*` state are out of reach.
- Restart is `SendCommand` against the one instance ARN, not the
  fleet — even a new node needs an explicit policy update, which is a
  deliberate review gate.

## The workflow

`.github/workflows/cell-deploy.yml`:

```yaml
name: Deploy cell
on:
  push:
    branches: [master]
    paths: ["cell/**"]
permissions:
  id-token: write   # OIDC
  contents: read
concurrency: cell-deploy   # never two deploys at once
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: cell-deploy   # gate: required reviewers / secrets scope
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: aws-actions/configure-aws-credentials@<pinned-sha>
        with:
          role-to-assume: arn:aws:iam::243602015558:role/apm-cell-deployer
          aws-region: us-west-2
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version: 22 }
      - run: npm ci --prefix cell && npm ci   # esbuild for the bundler
      - name: Deploy bundle
        run: |
          curl -fsSL -o /tmp/celld.gz \
            "https://github.com/denoland/celld/releases/download/v0.2.0/celld-x86_64-unknown-linux-gnu.gz"
          gunzip /tmp/celld.gz && chmod +x /tmp/celld
          CELLD_ESBUILD=$(command -v esbuild || echo node_modules/.bin/esbuild) \
            /tmp/celld deploy cell --bucket s3://cribl-apm-cell-test
      - name: Restart celld
        run: |
          CID=$(aws ssm send-command --instance-ids <instance_id> \
            --document-name AWS-RunShellScript \
            --parameters commands='sudo systemctl restart celld' \
            --query Command.CommandId --output text)
          # poll ssm get-command-invocation until Success/Failed
```

Pin the celld version to the same tag as the running node's binary
(the fleet-version rule). Keep secrets (LLM key, Cribl creds) **out**
of CI — they live in SSM on the node, not in the pipeline; CI only
ships code and restarts. The app pack's own deploy stays separate
(`npm run deploy` → Cribl Cloud); this workflow is cell-only.

## Rollout

1. Land the deployer role in `cell/infra` (`terraform apply` — it only
   adds IAM, no node replacement).
2. Register the GitHub OIDC provider in the account if not present.
3. Create the `cell-deploy` GitHub environment (add required
   reviewers if you want a manual gate).
4. Add the workflow. First run is a no-op redeploy to prove the path;
   after that, cell PRs ship on merge.
