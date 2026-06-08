variable "aws_region" {
  description = "AWS region. Only us-east-1 is tested but the code is region-agnostic."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Public hostname the controller answers on. ACM cert + ALB listener + GOOGLE_OAUTH_REDIRECT_URI are all derived from this."
  type        = string
  default     = "eng.rebyte.ai"
}

# Browser-side allow-list. Set both: ALLOWED_GOOGLE_EMAILS is per-user (you),
# ALLOWED_GOOGLE_DOMAINS lets the whole rebyte.ai org in without listing each.
variable "allowed_google_emails" {
  description = "Comma-separated list of Google account emails permitted to log in."
  type        = string
  default     = "sonicgg@gmail.com"
}

variable "allowed_google_domains" {
  description = "Comma-separated list of Google Workspace domains permitted to log in."
  type        = string
  default     = "rebyte.ai"
}

variable "task_cpu" {
  description = "Fargate vCPU units. 256 = 0.25 vCPU. ARM64 supports 256/512/1024/2048/4096."
  type        = number
  default     = 256
}

variable "task_memory_mib" {
  description = "Fargate task memory in MiB. With cpu=256 the valid values are 512/1024/2048."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Fargate service desired task count. Single-user setup — keep at 1."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch log group retention. 7 days keeps the bill near zero for the volume this service produces."
  type        = number
  default     = 7
}
