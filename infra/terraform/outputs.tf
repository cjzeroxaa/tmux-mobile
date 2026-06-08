# Operator-facing outputs. After `terraform apply` these print the
# commands you actually run to finish the deploy: add the ACM validation
# record to Google Cloud DNS, push the image, point eng.rebyte.ai at the
# ALB.

output "ecr_repository_url" {
  description = "ECR repo URL — passed to docker tag / docker push."
  value       = aws_ecr_repository.controller.repository_url
}

output "alb_dns_name" {
  description = "Internal ALB hostname. Make eng.rebyte.ai a CNAME to this."
  value       = aws_lb.controller.dns_name
}

output "alb_url" {
  description = "Hit this directly during smoke tests before DNS is wired."
  value       = "https://${aws_lb.controller.dns_name}/"
}

# ACM validation CNAME — paste the .name and .record into Google Cloud
# DNS once, ACM picks it up within ~2 min. `gcloud_dns_validation_cmd`
# below packages it as a copy-pasteable gcloud invocation.
output "acm_validation_records" {
  description = "DNS records that need to exist on the authoritative DNS server for ACM to issue the cert."
  value = [
    for option in aws_acm_certificate.controller.domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}

output "gcloud_dns_validation_cmd" {
  description = "Copy-paste these into a shell with gcloud auth'd to the Rebyte project. The trailing dot on the value is intentional (FQDN)."
  value = join("\n", concat(
    [for option in aws_acm_certificate.controller.domain_validation_options :
      "gcloud dns record-sets create ${trimsuffix(option.resource_record_name, ".")} --zone=rebyte-ai --type=${option.resource_record_type} --ttl=300 --rrdatas='${option.resource_record_value}'"
    ],
    [
      "# After the cert validates (re-run `terraform apply`), point the domain at the ALB:",
      "gcloud dns record-sets create ${var.domain_name}. --zone=rebyte-ai --type=CNAME --ttl=300 --rrdatas='${aws_lb.controller.dns_name}.'",
    ],
  ))
}

output "ecs_cluster_name" {
  description = "Used by scripts/push-image.sh to force a service redeploy."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Used by scripts/push-image.sh to force a service redeploy."
  value       = aws_ecs_service.controller.name
}

output "secrets_to_populate" {
  description = "Run `aws secretsmanager put-secret-value` for each ARN below, with the matching credential. SESSION_SECRET is auto-seeded."
  value       = { for name, secret in aws_secretsmanager_secret.controller : name => secret.arn }
}

output "log_group" {
  description = "CloudWatch log group for the controller. Tail with `aws logs tail`."
  value       = aws_cloudwatch_log_group.controller.name
}
