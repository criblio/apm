variable "region" {
  description = "AWS region for the cell."
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "AWS CLI profile (SSO) to authenticate with."
  type        = string
  default     = "test"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket for the celld fleet (deployments + replicated cell state)."
  type        = string
}


variable "instance_type" {
  description = "EC2 instance type (arm64 — celld ships an aarch64 binary)."
  type        = string
  default     = "t4g.small"
}

variable "celld_version" {
  description = "celld release tag to install. v0.2.0+ splits the public listener from an internal peer/operator listener; our public listener is loopback-only behind Caddy, so no --internal-listen is required. A fleet must never mix v0.1.0 and v0.2.0 nodes (block-format replication objects are not backward-readable) — upgrade by replacing every node, not rolling."
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
