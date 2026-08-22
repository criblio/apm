# Investigator cell on AWS: one celld node + one S3 bucket.
#
# The infrastructure itself now lives in the shared framework module
# `infra/celld-fleet` (extracted from this very stack in PRs
# #129/#130/#132), so every cell-harness app deploys the same pattern
# under its own names. What stays here is this stack's identity: the
# cell name, the bucket, and which env vars the APM cell needs.
#
# celld's own design carries the durability — every cell's SQLite
# replicates to the bucket and nodes are stateless — so the instance
# is disposable by construction. Scale-out later = more instances
# pointed at the same bucket.

module "fleet" {
  # Sibling checkout, matching how the app consumes the framework's
  # npm packages (`file:../cribl-search-app-framework/...`). Pin a git
  # ref here once the module lands on the framework's master.
  source = "../../../cribl-search-app-framework/infra/celld-fleet"

  # Drives "apm-cell-node" for every named resource and the default
  # SSM prefix /apm-cell — both must keep their existing values, or
  # the create-time names churn.
  cell_name   = var.cell_name
  bucket_name = var.bucket_name

  region               = var.region
  instance_type        = var.instance_type
  celld_version        = var.celld_version
  caddy_version        = var.caddy_version
  ssm_parameter_prefix = var.ssm_parameter_prefix

  # The security group's description is a create-time argument and the
  # group's name is derived from cell_name, so letting the module's
  # generic wording apply would be a same-name destroy/create that
  # fights the attached instance. Pin this stack's original text.
  security_group_description = "Investigator cell: HTTPS in (Cribl webhooks + platform proxy), no SSH (use SSM Session Manager)."

  # Secrets: SSM SecureStrings under the prefix, created out-of-band
  # and never in Terraform state. Boot fails loudly on a missing one,
  # so this list is exactly what the real agent loop needs.
  secret_env_keys = [
    "WEBHOOK_BEARER",
    "UI_BEARER",
    "TICKET_SECRET",
    "LLM_API_KEY",
    "CRIBL_CLIENT_ID",
    "CRIBL_CLIENT_SECRET",
  ]

  # Non-secret agent-loop config. These land in state — secrets never
  # go here, they go in secret_env_keys above.
  plain_env = {
    LLM_BASE_URL   = var.llm_base_url
    LLM_MODEL      = var.llm_model
    CRIBL_BASE_URL = var.cribl_base_url
    CRIBL_DATASET  = var.cribl_dataset
  }
}

# ── State migration into the module ──────────────────────────────
#
# Every resource below moved from this root into module.fleet.* when
# the stack adopted the module. `moved` blocks make that a state
# re-address, not a destroy/create. Keep them: removing one would
# make Terraform plan a delete of the old address plus a create of
# the new one. (The one legitimate replacement in the adoption apply
# was the instance, whose generalized user_data differs textually
# under user_data_replace_on_change — durable state is in the bucket
# and the EIP is separate, so the URL survived.)

moved {
  from = aws_s3_bucket.fleet
  to   = module.fleet.aws_s3_bucket.fleet
}

moved {
  from = aws_s3_bucket_public_access_block.fleet
  to   = module.fleet.aws_s3_bucket_public_access_block.fleet
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.fleet
  to   = module.fleet.aws_s3_bucket_server_side_encryption_configuration.fleet
}

moved {
  from = aws_s3_bucket_versioning.fleet
  to   = module.fleet.aws_s3_bucket_versioning.fleet
}

moved {
  from = aws_iam_role.cell
  to   = module.fleet.aws_iam_role.cell
}

moved {
  from = aws_iam_role_policy.cell
  to   = module.fleet.aws_iam_role_policy.cell
}

moved {
  from = aws_iam_role_policy_attachment.ssm
  to   = module.fleet.aws_iam_role_policy_attachment.ssm
}

moved {
  from = aws_iam_instance_profile.cell
  to   = module.fleet.aws_iam_instance_profile.cell
}

moved {
  from = aws_security_group.cell
  to   = module.fleet.aws_security_group.cell
}

moved {
  from = aws_eip.cell
  to   = module.fleet.aws_eip.cell
}

moved {
  from = aws_instance.cell
  to   = module.fleet.aws_instance.cell
}

moved {
  from = aws_eip_association.cell
  to   = module.fleet.aws_eip_association.cell
}
