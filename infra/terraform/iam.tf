# Two roles for the Fargate task:
#
#   execution_role - what ECS itself assumes to start the container:
#     pull from ECR, write to CloudWatch Logs, fetch secrets at task start.
#   task_role      - what the running container assumes for AWS calls.
#     The controller doesn't currently make any AWS API calls (it just
#     reads its env vars), so this role has no inline policies — kept here
#     so future features (e.g. write logs to S3) attach cleanly.

data "aws_iam_policy_document" "assume_role_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.service_name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_role_ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow execution role to read each individual secret (least privilege —
# not blanket "secretsmanager:GetSecretValue" on *).
data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [for s in aws_secretsmanager_secret.controller : s.arn]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "read-controller-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.service_name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_role_ecs_tasks.json
}
