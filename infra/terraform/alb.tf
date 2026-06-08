# Application Load Balancer in front of the Fargate task. Two-AZ subnets
# because AWS requires it; the actual task only runs in one AZ at a time.

resource "aws_lb" "controller" {
  name               = local.service_name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # Bump the idle timeout so long-lived agent WebSockets don't get reaped
  # by ALB while quiet between bursts. Default is 60s; 4000s matches the
  # ALB ceiling for normal accounts.
  idle_timeout = 4000

  enable_http2               = true
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "controller" {
  name        = local.service_name
  port        = local.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/api/health"
    healthy_threshold   = 2
    unhealthy_threshold = 5
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  # Sticky on a cookie issued by ALB so a browser session that opens a WS
  # lands on the same task as its HTTP requests. With one task this is a
  # no-op now; it's the right setting for any future scale-out.
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  deregistration_delay = 30
}

# Plaintext HTTP just redirects to HTTPS. Cheaper than running it as a
# full app listener and matches every "https on by default" policy.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.controller.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.controller.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.controller.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.controller.arn
  }
}
