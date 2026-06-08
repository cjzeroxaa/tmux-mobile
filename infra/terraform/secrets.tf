# Sensitive runtime config lives in Secrets Manager and gets injected into
# the Fargate task by ARN reference (see ecs.tf `secrets` block). Plain
# config (allow-list, redirect URI, container port) stays inline in the
# task def as `environment` since those values aren't credentials.
#
# Terraform CREATES the secret resources but does NOT set their values —
# that way the secret material never touches tfstate or your local disk.
# Use the `aws secretsmanager put-secret-value` commands in the deploy
# runbook (docs/fargate-deploy.md) to populate them after the first apply.

locals {
  controller_secret_names = [
    "OPENAI_API_KEY",
    "SESSION_SECRET",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_DEVICE_CLIENT_ID",
    "GOOGLE_DEVICE_CLIENT_SECRET",
  ]
}

# A random session secret if you don't paste one in yourself — generated
# once at apply time, stored in tfstate (encrypted at rest in S3 if you
# move to a remote backend). For Google OAuth creds and OpenAI key you
# still have to put_secret_value manually.
resource "random_password" "session_secret_default" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "controller" {
  for_each = toset(local.controller_secret_names)
  name     = "${local.service_name}/${each.key}"
  # 7 days is the minimum AWS allows for "scheduled deletion" — gives you a
  # week to undo an accidental destroy.
  recovery_window_in_days = 7
}

# Only seed the SESSION_SECRET automatically; everything else is operator-
# supplied via aws cli (see docs/fargate-deploy.md).
resource "aws_secretsmanager_secret_version" "session_secret" {
  secret_id     = aws_secretsmanager_secret.controller["SESSION_SECRET"].id
  secret_string = random_password.session_secret_default.result

  lifecycle {
    # If the operator overwrites it with their own value later, don't
    # clobber it on the next apply.
    ignore_changes = [secret_string]
  }
}
