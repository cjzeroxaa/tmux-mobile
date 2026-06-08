# ACM cert for the controller domain. Validation is DNS-based, but
# rebyte.ai delegates to Google Cloud DNS (not Route 53), so this module
# does NOT create the validation record automatically — `outputs.tf`
# emits the exact `gcloud dns record-sets` command the operator runs to
# add the validation CNAME under rebyte.ai.
#
# After that record propagates (usually <2 min on Google DNS), `terraform
# apply` again to let aws_acm_certificate_validation poll AWS for the
# issued cert and unblock the ALB listener.

resource "aws_acm_certificate" "controller" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Waits up to 30 min for AWS to see the validation CNAME on the
# authoritative DNS server. Add the record (see outputs.tf) BEFORE
# running the apply that triggers this resource, or `terraform apply`
# will hang until you do.
resource "aws_acm_certificate_validation" "controller" {
  certificate_arn = aws_acm_certificate.controller.arn

  # No validation_record_fqdns: we're managing DNS out-of-band in
  # Google Cloud DNS. ACM polls the public resolver, which is what
  # matters.
  timeouts {
    create = "30m"
  }
}
