# ECS cluster + Fargate task def + service. ARM64 platform (Graviton) so
# we get the ~20% price drop vs x86 for the same vCPU/memory.
#
# The image tag is "latest" — every push-image.sh run replaces it in ECR
# and force-redeploys the service. If you'd rather pin to git SHAs, set
# the task def to that SHA and re-apply.

resource "aws_ecs_cluster" "main" {
  name = local.service_name

  setting {
    name  = "containerInsights"
    value = "disabled" # free tier; flip to "enabled" if you want metrics
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

resource "aws_cloudwatch_log_group" "controller" {
  name              = "/ecs/${local.service_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "controller" {
  family                   = local.service_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory_mib
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "controller"
      image     = "${aws_ecr_repository.controller.repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = local.container_port
          protocol      = "tcp"
        }
      ]

      # Non-secret config. ALLOWED_* values are deliberately not secret —
      # publishing them gives no advantage to an attacker and pulling them
      # from Secrets Manager would just be slower task starts.
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = tostring(local.container_port) },
        { name = "ALLOWED_GOOGLE_EMAILS", value = var.allowed_google_emails },
        { name = "ALLOWED_GOOGLE_DOMAINS", value = var.allowed_google_domains },
        { name = "GOOGLE_OAUTH_REDIRECT_URI", value = "https://${var.domain_name}/auth/google/callback" },
      ]

      # Secret material — injected at task start from Secrets Manager.
      # Cycling a secret's value does NOT re-roll the task; you need
      # `aws ecs update-service --force-new-deployment` (or push a new
      # image) to pick up the change. push-image.sh does that for you.
      secrets = [
        for name in local.controller_secret_names : {
          name      = name
          valueFrom = aws_secretsmanager_secret.controller[name].arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.controller.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "controller"
        }
      }

      # Mirror the Dockerfile HEALTHCHECK at the ECS level too so ECS will
      # mark an unhealthy task for replacement (ALB target-group health
      # check is independent and also wired up in alb.tf).
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }
    }
  ])
}

resource "aws_ecs_service" "controller" {
  name            = local.service_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.controller.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Single-AZ topology: tasks placed in any subnet from the public set; ECS
  # picks one. AssignPublicIp because we have no NAT — without it the task
  # can't egress to OpenAI / Google.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.controller.arn
    container_name   = "controller"
    container_port   = local.container_port
  }

  # Wait for ALB target to become healthy before completing the deploy.
  health_check_grace_period_seconds = 60

  # Rolling deploy without minimum healthy: with desired=1 there's a brief
  # gap during a redeploy. Acceptable for a single-user app. If you bump
  # desired_count later, leave deployment_minimum_healthy_percent at 100.
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  # Ignore image-tag drift between Terraform and push-image.sh. We always
  # push :latest, so the task def in tfstate keeps saying :latest and
  # `terraform plan` stays clean even after a new image push.
  lifecycle {
    ignore_changes = [
      task_definition,
      desired_count,
    ]
  }

  depends_on = [
    aws_lb_listener.https,
  ]
}
