terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # State lives in the fleet bucket, not on an operator's laptop: a
  # lost local state file would orphan every resource here (Terraform
  # could neither update nor destroy them). `use_lockfile` is S3-native
  # locking — no DynamoDB table needed.
  #
  # The bucket is created by this same config, so it is a chicken-and-egg
  # on a from-scratch apply: run once with this block commented out,
  # then uncomment and `terraform init -migrate-state`. Against the
  # existing cell there is nothing to bootstrap — just init.
  backend "s3" {
    bucket       = "cribl-apm-cell-test"
    key          = "terraform/cell-infra.tfstate"
    region       = "us-west-2"
    profile      = "test"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = {
      Project   = "apm-investigator-cell"
      ManagedBy = "terraform"
      Repo      = "criblio/apm//cell/infra"
      # The test account reaps untagged resources; this keeps the cell up.
      Persistent = "true"
    }
  }
  # The test account's auto-tagger stamps these on create. Without this,
  # every plan wants to strip them and fights the account automation.
  ignore_tags {
    keys = ["AutoTag_Creator", "AutoTagCreatorId"]
  }
}
