variable "region" {
  description = "AWS region for the cell."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile (SSO) to authenticate with."
  type        = string
  default     = "apm-cell"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket for the celld fleet (deployments + replicated cell state)."
  type        = string
}

variable "domain" {
  description = "Public hostname for the cell (Caddy terminates TLS via ACME). Leave empty to skip Caddy and serve plain HTTP on :8080 — dev only; Cribl webhooks and the platform proxy require HTTPS."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type (arm64 — celld ships an aarch64 binary)."
  type        = string
  default     = "t4g.small"
}

variable "celld_version" {
  description = "celld release tag to install."
  type        = string
  default     = "v0.1.0"
}

variable "ssm_parameter_prefix" {
  description = "SSM SecureString prefix the instance reads its secrets from at boot. Parameters are created OUT of Terraform (never in state) — see README."
  type        = string
  default     = "/apm-cell"
}
