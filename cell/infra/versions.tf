terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # State stays local until we decide otherwise; a single-node cell
  # has no team-concurrency problem yet. To move to S3 state later:
  # terraform init -migrate-state with a backend block here.
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = {
      Project   = "apm-investigator-cell"
      ManagedBy = "terraform"
      Repo      = "criblio/apm//cell/infra"
    }
  }
}
