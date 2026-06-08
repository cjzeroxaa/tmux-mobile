# AWS Fargate deployment of the tmux-mobile controller.
#
# Provisions, in us-east-1:
#   - VPC with two public subnets (ALB needs ≥2 AZs; the Fargate task itself
#     lives in only one of them per the chosen single-AZ topology)
#   - ECR repository for the controller image
#   - ALB (HTTPS) + ACM cert for eng.rebyte.ai
#   - ECS cluster + Fargate service (ARM64, 1 task)
#   - IAM task roles, CloudWatch log group
#   - Secrets Manager entries for the controller's required env vars
#
# State is local-file by default. See infra/terraform/.gitignore — the
# tfstate is git-ignored. If a second operator joins, migrate to S3+DDB.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project   = "tmux-mobile"
      ManagedBy = "terraform"
      Service   = local.service_name
    }
  }
}

locals {
  # One name token used throughout so resources are easy to find in the
  # AWS console. Changing it forces a fresh deployment.
  service_name = "tmux-mobile-controller"

  container_port = 3737

  # Single-AZ for the task itself, but ALB still needs subnets in two AZs
  # — picking 1a and 1b which are the most stable us-east-1 pair.
  azs = ["us-east-1a", "us-east-1b"]

  vpc_cidr       = "10.42.0.0/16"
  public_subnets = ["10.42.1.0/24", "10.42.2.0/24"]
}
