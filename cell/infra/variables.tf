# This root's inputs. Anything describing *how* a celld fleet is built
# now lives in the framework module (infra/celld-fleet); what is left
# here is this stack's identity and its AWS-session details.

variable "cell_name" {
  description = "Cell (fleet) name. Drives every resource name (\"<name>-node\") and the default SSM prefix. Changing it renames create-time-named resources — don't, on the live stack."
  type        = string
  default     = "apm-cell"
}

variable "region" {
  description = "AWS region for the cell. The test account's TestAccountPowerUser permission set is scoped to us-west-2; other regions fail AccessDenied."
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "AWS CLI profile (SSO) to authenticate with."
  type        = string
  default     = "test"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket for the celld fleet (deployments + replicated cell state). Also holds this stack's Terraform state — see the backend block in versions.tf."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type (arm64 — celld ships an aarch64 binary)."
  type        = string
  default     = "t4g.small"
}

variable "celld_version" {
  description = "celld release tag to install. A fleet must never mix v0.1.0 and v0.2.0 nodes (block-format replication objects are not backward-readable) — upgrade by replacing every node, not rolling. v0.2.1→v0.3.0 can roll one node at a time, but going BACK to a v0.2.x binary on a node that has run v0.3.0 can lose acknowledged writes unless its shutdown log shows `node-log close: sealed epoch` — v0.2.x cannot read the replicated log."
  type        = string
  default     = "v0.3.0"
}

variable "celld_durability" {
  description = "Write-ack posture (celld v0.3.0+). `fleet` acks once a follower has fsynced and tiers to S3 behind; `bucket` waits for S3 on every write. `fleet` is safe on this single-node fleet — with no peers celld behaves exactly like sync-to-bucket (bucket-proven acks) and upgrades itself if a peer joins — so it keeps v0.2.0's guarantee while dropping write latency and Class A op count. Pinned rather than defaulted so a celld default change can't move it silently."
  type        = string
  default     = "fleet"
}

variable "celld_handler_budget_s" {
  description = "Per-request JS handler budget in seconds (celld default 300). Exceeding it kills the celld PROCESS, not just the isolate, so every session on the node dies — this is the budget cell-harness 0.3.0's bounded watchdog stops retrying a turn against. Kept at the default; pinned for visibility."
  type        = number
  default     = 300
}

variable "caddy_version" {
  description = "Caddy release version (no leading v). Installed from the official GitHub static binary — AL2023 has no caddy package."
  type        = string
  default     = "2.10.2"
}

variable "ssm_parameter_prefix" {
  description = "SSM SecureString prefix the instance reads its secrets from at boot. Parameters are created OUT of Terraform (never in state) — see README."
  type        = string
  default     = "/apm-cell"
}

# ── Real agent-loop config (non-secret; passed to the module as
#    plain_env. The matching secrets — LLM_API_KEY, CRIBL_CLIENT_ID,
#    CRIBL_CLIENT_SECRET — live in SSM and are named in the module's
#    secret_env_keys).
#
#    These defaults are the LIVE staging values, deliberately. They
#    used to be empty and supplied as `-var` flags from the runbook,
#    but every one of them renders into user_data under
#    `user_data_replace_on_change = true`: an apply that forgot a flag
#    would REPLACE the node and bring it back in stub mode (empty
#    llm_base_url ⇒ no agent loop) with no error. Config the node
#    can't run without belongs where a bare `terraform apply` finds
#    it. ──

variable "llm_base_url" {
  description = "OpenAI-compatible endpoint base for the agent loop. Empty ⇒ the payload's stub agent instead of the real loop."
  type        = string
  default     = "https://openrouter.ai/api/v1"
}

variable "llm_model" {
  description = "Model id sent to the endpoint. Text-only — see the cell's LLM_VISION note; declaring vision on a text-only model is a hard API error on most providers."
  type        = string
  default     = "deepseek/deepseek-v4-flash-0731"
}

variable "cribl_base_url" {
  description = "Cribl workspace base URL the cell runs searches/metrics against and commits investigation events to. Required for the real loop (and for the coordinator's $vt_results alert poll)."
  type        = string
  default     = "https://main-objective-shirley-sho21r7.cribl-staging.cloud"
}

variable "cribl_dataset" {
  description = "Telemetry dataset the investigator queries."
  type        = string
  default     = "otel"
}
