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
  description = "celld release tag to install. A fleet must never mix v0.1.0 and v0.2.0 nodes (block-format replication objects are not backward-readable) — upgrade by replacing every node, not rolling."
  type        = string
  default     = "v0.2.0"
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
#    secret_env_keys). ──

variable "llm_base_url" {
  description = "OpenAI-compatible endpoint base for the agent loop (e.g. https://openrouter.ai/api/v1)."
  type        = string
  default     = ""
}

variable "llm_model" {
  description = "Model id sent to the endpoint."
  type        = string
  default     = "deepseek/deepseek-v4-flash-0731"
}

variable "cribl_base_url" {
  description = "Cribl workspace base URL the cell runs searches/metrics against and commits investigation events to. Required for the real loop."
  type        = string
  default     = ""
}

variable "cribl_dataset" {
  description = "Telemetry dataset the investigator queries."
  type        = string
  default     = "otel"
}
