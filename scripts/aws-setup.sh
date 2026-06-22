#!/usr/bin/env bash
# Stand up the tmux-mobile controller on AWS Fargate in us-east-1.
#
# Idempotent: every section checks if the resource already exists (by Name tag
# or known name) and skips creation if so. Re-running the script on the same
# AWS account is safe — it just confirms the existing state and prints the
# next manual step you owe (DNS, Secrets Manager population).
#
# State file: scripts/aws-state.env. KEY=VALUE pairs, one per line. Both the
# push-image and teardown scripts source it. Re-runs of THIS script also read
# it, so you can edit a value (e.g. force a re-create by clearing the ID) and
# re-run.
#
# Usage:
#   ./scripts/aws-setup.sh             # bring everything up to current
#   ./scripts/aws-setup.sh --print-only  # show what would happen, don't apply
#
# Prereqs:
#   - aws cli with credentials for account 811162362148 (IAM rebyte-prod)
#   - docker (for push-image, not used here)
#   - jq

set -euo pipefail

# ---------------------- configuration ----------------------
AWS_REGION="${AWS_REGION:-us-east-1}"
NAME="tmux-mobile-controller"
DOMAIN="eng.impo.ai"
CONTAINER_PORT=3737
TASK_CPU=256
TASK_MEMORY=512
VPC_CIDR="10.42.0.0/16"
SUBNET_A_CIDR="10.42.1.0/24"
SUBNET_B_CIDR="10.42.2.0/24"
AZ_A="us-east-1a"
AZ_B="us-east-1b"
LOG_RETENTION_DAYS=7
SECRET_NAMES=(
  OPENAI_API_KEY
  SESSION_SECRET
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET
  GOOGLE_DEVICE_CLIENT_ID
  GOOGLE_DEVICE_CLIENT_SECRET
)
ALLOW_ALL_GOOGLE_USERS="1"
SUPER_ADMIN_EMAILS="sonicgg@gmail.com"
ALLOWED_GOOGLE_EMAILS=""
ALLOWED_GOOGLE_DOMAINS=""
USER_PREFS_DYNAMO_TABLE="${USER_PREFS_DYNAMO_TABLE:-${NAME}-user-preferences}"

# ---------------------- bootstrap ----------------------
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/scripts/aws-state.env"
PRINT_ONLY=false
[[ "${1:-}" == "--print-only" ]] && PRINT_ONLY=true

# Source any existing state into the environment so we can short-circuit
# already-created resources.
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi

state_set() {
  local key="$1" value="$2"
  if [[ -f "$STATE_FILE" ]] && grep -q "^$key=" "$STATE_FILE"; then
    sed -i '' "s|^$key=.*|$key=$value|" "$STATE_FILE"
  else
    echo "$key=$value" >>"$STATE_FILE"
  fi
  export "$key=$value"
}

# Echo with a section marker; aws calls are noisy. Sent to stderr so they
# don't contaminate `$(fn …)` capture sites — and so a normal `tee` of the
# script output still shows the resource IDs the AWS commands print.
section() { printf '\n\033[1;34m==> %s\033[0m\n' "$*" >&2; }
note() { printf '   %s\n' "$*" >&2; }
warn() { printf '   \033[1;33m! %s\033[0m\n' "$*" >&2; }

aws_run() {
  if $PRINT_ONLY; then echo "DRY-RUN: aws $*"; return; fi
  aws "$@"
}

# ---------------------- preflight ----------------------
section "preflight"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
note "account: $ACCOUNT_ID"
note "region:  $AWS_REGION"
state_set ACCOUNT_ID "$ACCOUNT_ID"
state_set AWS_REGION "$AWS_REGION"
state_set NAME "$NAME"
state_set DOMAIN "$DOMAIN"

# ---------------------- ECR ----------------------
section "ECR repository"
ECR_URL="$(aws ecr describe-repositories --repository-names "$NAME" --region "$AWS_REGION" \
  --query 'repositories[0].repositoryUri' --output text 2>/dev/null || echo "")"
if [[ -z "$ECR_URL" || "$ECR_URL" == "None" ]]; then
  ECR_URL="$(aws_run ecr create-repository \
    --repository-name "$NAME" \
    --image-tag-mutability MUTABLE \
    --image-scanning-configuration scanOnPush=true \
    --region "$AWS_REGION" \
    --query 'repository.repositoryUri' --output text)"
  note "created $ECR_URL"
else
  note "exists  $ECR_URL"
fi
state_set ECR_URL "$ECR_URL"

# Lifecycle policy: keep last 10 tagged + expire untagged after 7d.
aws_run ecr put-lifecycle-policy --repository-name "$NAME" --region "$AWS_REGION" \
  --lifecycle-policy-text '{
    "rules":[
      {"rulePriority":1,"description":"keep last 10 tagged","selection":{
        "tagStatus":"tagged","tagPatternList":["*"],"countType":"imageCountMoreThan","countNumber":10},
        "action":{"type":"expire"}},
      {"rulePriority":2,"description":"expire untagged 7d","selection":{
        "tagStatus":"untagged","countType":"sinceImagePushed","countUnit":"days","countNumber":7},
        "action":{"type":"expire"}}
    ]}' >/dev/null

# ---------------------- VPC + subnets + IGW ----------------------
section "VPC"
VPC_ID="$(aws ec2 describe-vpcs --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${NAME}-vpc" \
  --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)"
if [[ -z "$VPC_ID" || "$VPC_ID" == "None" ]]; then
  VPC_ID="$(aws_run ec2 create-vpc --region "$AWS_REGION" \
    --cidr-block "$VPC_CIDR" \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${NAME}-vpc}]" \
    --query 'Vpc.VpcId' --output text)"
  aws_run ec2 modify-vpc-attribute --region "$AWS_REGION" --vpc-id "$VPC_ID" --enable-dns-support
  aws_run ec2 modify-vpc-attribute --region "$AWS_REGION" --vpc-id "$VPC_ID" --enable-dns-hostnames
  note "created $VPC_ID"
else
  note "exists  $VPC_ID"
fi
state_set VPC_ID "$VPC_ID"

section "Internet gateway"
IGW_ID="$(aws ec2 describe-internet-gateways --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${NAME}-igw" \
  --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null || true)"
if [[ -z "$IGW_ID" || "$IGW_ID" == "None" ]]; then
  IGW_ID="$(aws_run ec2 create-internet-gateway --region "$AWS_REGION" \
    --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=${NAME}-igw}]" \
    --query 'InternetGateway.InternetGatewayId' --output text)"
  aws_run ec2 attach-internet-gateway --region "$AWS_REGION" \
    --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"
  note "created $IGW_ID"
else
  # Make sure it's attached
  ATTACHED_VPC="$(aws ec2 describe-internet-gateways --region "$AWS_REGION" \
    --internet-gateway-ids "$IGW_ID" \
    --query 'InternetGateways[0].Attachments[0].VpcId' --output text 2>/dev/null || true)"
  if [[ "$ATTACHED_VPC" != "$VPC_ID" ]]; then
    aws_run ec2 attach-internet-gateway --region "$AWS_REGION" \
      --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"
  fi
  note "exists  $IGW_ID"
fi
state_set IGW_ID "$IGW_ID"

create_subnet() {
  local az="$1" cidr="$2" name_tag="$3"
  local id
  id="$(aws ec2 describe-subnets --region "$AWS_REGION" \
    --filters "Name=tag:Name,Values=$name_tag" \
    --query 'Subnets[0].SubnetId' --output text 2>/dev/null || true)"
  if [[ -z "$id" || "$id" == "None" ]]; then
    id="$(aws_run ec2 create-subnet --region "$AWS_REGION" \
      --vpc-id "$VPC_ID" --cidr-block "$cidr" --availability-zone "$az" \
      --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$name_tag},{Key=Tier,Value=public}]" \
      --query 'Subnet.SubnetId' --output text)"
    aws_run ec2 modify-subnet-attribute --region "$AWS_REGION" --subnet-id "$id" --map-public-ip-on-launch
    note "created $name_tag = $id"
  else
    note "exists  $name_tag = $id"
  fi
  echo "$id"
}

section "Public subnets"
SUBNET_A_ID="$(create_subnet "$AZ_A" "$SUBNET_A_CIDR" "${NAME}-public-${AZ_A}")"
SUBNET_B_ID="$(create_subnet "$AZ_B" "$SUBNET_B_CIDR" "${NAME}-public-${AZ_B}")"
state_set SUBNET_A_ID "$SUBNET_A_ID"
state_set SUBNET_B_ID "$SUBNET_B_ID"

section "Route table"
RT_ID="$(aws ec2 describe-route-tables --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${NAME}-public-rt" \
  --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || true)"
if [[ -z "$RT_ID" || "$RT_ID" == "None" ]]; then
  RT_ID="$(aws_run ec2 create-route-table --region "$AWS_REGION" --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${NAME}-public-rt}]" \
    --query 'RouteTable.RouteTableId' --output text)"
  aws_run ec2 create-route --region "$AWS_REGION" --route-table-id "$RT_ID" \
    --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID" >/dev/null
  note "created $RT_ID"
else
  note "exists  $RT_ID"
fi
state_set RT_ID "$RT_ID"
# Always reconcile subnet associations: a previous run with bad subnet
# IDs (e.g. multiline-contaminated state) can leave the RT with no
# associations, and the else-branch above otherwise wouldn't notice.
for sub in "$SUBNET_A_ID" "$SUBNET_B_ID"; do
  current_rt="$(aws ec2 describe-route-tables --region "$AWS_REGION" \
    --filters "Name=association.subnet-id,Values=$sub" \
    --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || true)"
  if [[ "$current_rt" != "$RT_ID" ]]; then
    aws_run ec2 associate-route-table --region "$AWS_REGION" \
      --route-table-id "$RT_ID" --subnet-id "$sub" >/dev/null
    note "  associated $sub → $RT_ID"
  fi
done

# ---------------------- security groups ----------------------
section "Security groups"
SG_ALB_ID="$(aws ec2 describe-security-groups --region "$AWS_REGION" \
  --filters "Name=group-name,Values=${NAME}-alb" "Name=vpc-id,Values=${VPC_ID}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [[ -z "$SG_ALB_ID" || "$SG_ALB_ID" == "None" ]]; then
  SG_ALB_ID="$(aws_run ec2 create-security-group --region "$AWS_REGION" \
    --group-name "${NAME}-alb" --description "ALB world to 80 and 443" --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)"
  aws_run ec2 authorize-security-group-ingress --region "$AWS_REGION" \
    --group-id "$SG_ALB_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  aws_run ec2 authorize-security-group-ingress --region "$AWS_REGION" \
    --group-id "$SG_ALB_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  note "created ALB SG $SG_ALB_ID"
else
  note "exists  ALB SG $SG_ALB_ID"
fi

SG_TASK_ID="$(aws ec2 describe-security-groups --region "$AWS_REGION" \
  --filters "Name=group-name,Values=${NAME}-task" "Name=vpc-id,Values=${VPC_ID}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [[ -z "$SG_TASK_ID" || "$SG_TASK_ID" == "None" ]]; then
  SG_TASK_ID="$(aws_run ec2 create-security-group --region "$AWS_REGION" \
    --group-name "${NAME}-task" --description "Fargate task ingress from ALB on ${CONTAINER_PORT}" --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)"
  aws_run ec2 authorize-security-group-ingress --region "$AWS_REGION" \
    --group-id "$SG_TASK_ID" --protocol tcp --port "$CONTAINER_PORT" --source-group "$SG_ALB_ID" >/dev/null
  note "created task SG $SG_TASK_ID"
else
  note "exists  task SG $SG_TASK_ID"
fi
state_set SG_ALB_ID "$SG_ALB_ID"
state_set SG_TASK_ID "$SG_TASK_ID"

# ---------------------- CloudWatch log group ----------------------
section "CloudWatch log group"
LOG_GROUP="/ecs/${NAME}"
EXISTING_LG="$(aws logs describe-log-groups --region "$AWS_REGION" \
  --log-group-name-prefix "$LOG_GROUP" \
  --query "logGroups[?logGroupName=='$LOG_GROUP'].logGroupName | [0]" --output text 2>/dev/null || true)"
if [[ -z "$EXISTING_LG" || "$EXISTING_LG" == "None" ]]; then
  aws_run logs create-log-group --region "$AWS_REGION" --log-group-name "$LOG_GROUP"
  aws_run logs put-retention-policy --region "$AWS_REGION" \
    --log-group-name "$LOG_GROUP" --retention-in-days "$LOG_RETENTION_DAYS"
  note "created $LOG_GROUP"
else
  note "exists  $LOG_GROUP"
fi
state_set LOG_GROUP "$LOG_GROUP"

# ---------------------- IAM roles ----------------------
section "IAM roles"
ASSUME_ROLE_POLICY='{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
}'

TASK_EXEC_ROLE="${NAME}-task-execution"
TASK_EXEC_ARN="$(aws iam get-role --role-name "$TASK_EXEC_ROLE" \
  --query 'Role.Arn' --output text 2>/dev/null || true)"
if [[ -z "$TASK_EXEC_ARN" || "$TASK_EXEC_ARN" == "None" ]]; then
  TASK_EXEC_ARN="$(aws_run iam create-role --role-name "$TASK_EXEC_ROLE" \
    --assume-role-policy-document "$ASSUME_ROLE_POLICY" \
    --query 'Role.Arn' --output text)"
  aws_run iam attach-role-policy --role-name "$TASK_EXEC_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  note "created $TASK_EXEC_ARN"
else
  note "exists  $TASK_EXEC_ARN"
fi
state_set TASK_EXEC_ARN "$TASK_EXEC_ARN"

TASK_ROLE="${NAME}-task"
TASK_ROLE_ARN="$(aws iam get-role --role-name "$TASK_ROLE" \
  --query 'Role.Arn' --output text 2>/dev/null || true)"
if [[ -z "$TASK_ROLE_ARN" || "$TASK_ROLE_ARN" == "None" ]]; then
  TASK_ROLE_ARN="$(aws_run iam create-role --role-name "$TASK_ROLE" \
    --assume-role-policy-document "$ASSUME_ROLE_POLICY" \
    --query 'Role.Arn' --output text)"
  note "created $TASK_ROLE_ARN"
else
  note "exists  $TASK_ROLE_ARN"
fi
state_set TASK_ROLE_ARN "$TASK_ROLE_ARN"

# ---------------------- DynamoDB user preferences ----------------------
section "DynamoDB user preferences"
USER_PREFS_DYNAMO_TABLE_ARN="$(aws dynamodb describe-table --region "$AWS_REGION" \
  --table-name "$USER_PREFS_DYNAMO_TABLE" \
  --query 'Table.TableArn' --output text 2>/dev/null || true)"
if [[ -z "$USER_PREFS_DYNAMO_TABLE_ARN" || "$USER_PREFS_DYNAMO_TABLE_ARN" == "None" ]]; then
  USER_PREFS_DYNAMO_TABLE_ARN="$(aws_run dynamodb create-table --region "$AWS_REGION" \
    --table-name "$USER_PREFS_DYNAMO_TABLE" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --query 'TableDescription.TableArn' --output text)"
  if ! $PRINT_ONLY; then
    aws dynamodb wait table-exists --region "$AWS_REGION" --table-name "$USER_PREFS_DYNAMO_TABLE"
  fi
  note "created $USER_PREFS_DYNAMO_TABLE"
else
  note "exists  $USER_PREFS_DYNAMO_TABLE"
fi
state_set USER_PREFS_DYNAMO_TABLE "$USER_PREFS_DYNAMO_TABLE"
state_set USER_PREFS_DYNAMO_TABLE_ARN "$USER_PREFS_DYNAMO_TABLE_ARN"

USER_PREFS_POLICY_DOC='{
  "Version":"2012-10-17",
  "Statement":[{
    "Effect":"Allow",
    "Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:DeleteItem"],
    "Resource":"'"$USER_PREFS_DYNAMO_TABLE_ARN"'"
  }]
}'
aws_run iam put-role-policy --role-name "$TASK_ROLE" \
  --policy-name user-preferences-dynamodb \
  --policy-document "$USER_PREFS_POLICY_DOC" >/dev/null
note "task role can read/write user preferences"

# ---------------------- Secrets Manager (empty placeholders) ----------------------
section "Secrets Manager entries"
SECRET_ARNS=()
for sec in "${SECRET_NAMES[@]}"; do
  sec_name="${NAME}/${sec}"
  arn="$(aws secretsmanager describe-secret --secret-id "$sec_name" --region "$AWS_REGION" \
    --query 'ARN' --output text 2>/dev/null || true)"
  if [[ -z "$arn" || "$arn" == "None" ]]; then
    arn="$(aws_run secretsmanager create-secret --region "$AWS_REGION" \
      --name "$sec_name" --description "tmux-mobile-controller $sec" \
      --query 'ARN' --output text)"
    note "created $sec_name"
    # Auto-seed SESSION_SECRET only; everything else operator-supplied.
    if [[ "$sec" == "SESSION_SECRET" ]]; then
      # openssl avoids the `tr | head` SIGPIPE-under-pipefail trap that
      # silently bombed the script the first time around.
      RAND="$(openssl rand -hex 32)"
      aws_run secretsmanager put-secret-value --region "$AWS_REGION" \
        --secret-id "$sec_name" --secret-string "$RAND" >/dev/null
      note "  seeded random 64-char SESSION_SECRET"
    fi
  else
    note "exists  $sec_name"
  fi
  SECRET_ARNS+=("$arn")
done

# Inline policy: task execution role can read each secret ARN.
SECRETS_POLICY_DOC='{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue"],"Resource":['
SECRETS_POLICY_DOC+=$(printf '"%s",' "${SECRET_ARNS[@]}")
SECRETS_POLICY_DOC="${SECRETS_POLICY_DOC%,}]}]}"
aws_run iam put-role-policy --role-name "$TASK_EXEC_ROLE" \
  --policy-name read-controller-secrets \
  --policy-document "$SECRETS_POLICY_DOC" >/dev/null
note "task-exec role can read all $((${#SECRET_ARNS[@]})) secret ARNs"

# ---------------------- ACM cert ----------------------
section "ACM certificate"
ACM_ARN="${ACM_ARN:-}"
if [[ -z "$ACM_ARN" ]]; then
  ACM_ARN="$(aws acm list-certificates --region "$AWS_REGION" \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text 2>/dev/null || true)"
fi
if [[ -z "$ACM_ARN" || "$ACM_ARN" == "None" ]]; then
  ACM_ARN="$(aws_run acm request-certificate --region "$AWS_REGION" \
    --domain-name "$DOMAIN" --validation-method DNS \
    --query 'CertificateArn' --output text)"
  note "requested $ACM_ARN"
  # Need to wait briefly for AWS to surface the validation record.
  sleep 5
else
  note "exists    $ACM_ARN"
fi
state_set ACM_ARN "$ACM_ARN"

ACM_STATUS="$(aws acm describe-certificate --region "$AWS_REGION" \
  --certificate-arn "$ACM_ARN" --query 'Certificate.Status' --output text)"
note "status:   $ACM_STATUS"

if [[ "$ACM_STATUS" == "PENDING_VALIDATION" ]]; then
  VALIDATION_JSON="$(aws acm describe-certificate --region "$AWS_REGION" \
    --certificate-arn "$ACM_ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)"
  V_NAME="$(echo "$VALIDATION_JSON"  | jq -r '.Name')"
  V_TYPE="$(echo "$VALIDATION_JSON"  | jq -r '.Type')"
  V_VALUE="$(echo "$VALIDATION_JSON" | jq -r '.Value')"
  echo
  echo "  Add this CNAME record to Cloudflare for impo.ai:"
  echo
  echo "    name:  ${V_NAME%.}"
  echo "    type:  $V_TYPE"
  echo "    value: ${V_VALUE%.}"
  echo
  echo "  (Cloudflare DNS dashboard → impo.ai → Records → Add record. PROXY OFF / DNS only.)"
  echo
  echo "  Then re-run this script. It will detect the cert validated and continue with ALB / ECS."
  echo
  warn "stopping here until the cert is ISSUED. Current status: $ACM_STATUS"
  exit 0
elif [[ "$ACM_STATUS" != "ISSUED" ]]; then
  warn "unexpected ACM status: $ACM_STATUS — aborting"
  exit 1
fi

# ---------------------- ALB ----------------------
section "Application Load Balancer"
ALB_ARN="$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
  --names "$NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)"
if [[ -z "$ALB_ARN" || "$ALB_ARN" == "None" ]]; then
  ALB_ARN="$(aws_run elbv2 create-load-balancer --region "$AWS_REGION" \
    --name "$NAME" --type application --scheme internet-facing \
    --subnets "$SUBNET_A_ID" "$SUBNET_B_ID" \
    --security-groups "$SG_ALB_ID" \
    --ip-address-type ipv4 \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
  # Bump idle timeout to 4000s for long-lived agent WS.
  aws_run elbv2 modify-load-balancer-attributes --region "$AWS_REGION" \
    --load-balancer-arn "$ALB_ARN" \
    --attributes Key=idle_timeout.timeout_seconds,Value=4000 >/dev/null
  note "created $ALB_ARN"
else
  note "exists  $ALB_ARN"
fi
state_set ALB_ARN "$ALB_ARN"

ALB_DNS="$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
  --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)"
state_set ALB_DNS "$ALB_DNS"
note "DNS:    $ALB_DNS"

section "Target group"
TG_ARN="$(aws elbv2 describe-target-groups --region "$AWS_REGION" \
  --names "$NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
if [[ -z "$TG_ARN" || "$TG_ARN" == "None" ]]; then
  TG_ARN="$(aws_run elbv2 create-target-group --region "$AWS_REGION" \
    --name "$NAME" --protocol HTTP --port "$CONTAINER_PORT" \
    --vpc-id "$VPC_ID" --target-type ip \
    --health-check-path /api/health --health-check-protocol HTTP \
    --healthy-threshold-count 2 --unhealthy-threshold-count 5 \
    --health-check-interval-seconds 30 --health-check-timeout-seconds 5 \
    --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
  aws_run elbv2 modify-target-group-attributes --region "$AWS_REGION" \
    --target-group-arn "$TG_ARN" \
    --attributes \
      Key=stickiness.enabled,Value=true \
      Key=stickiness.type,Value=lb_cookie \
      Key=stickiness.lb_cookie.duration_seconds,Value=86400 \
      Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
  note "created $TG_ARN"
else
  note "exists  $TG_ARN"
fi
state_set TG_ARN "$TG_ARN"

section "ALB listeners"
HTTP_LISTENER_ARN="$(aws elbv2 describe-listeners --region "$AWS_REGION" \
  --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" --output text 2>/dev/null || true)"
if [[ -z "$HTTP_LISTENER_ARN" || "$HTTP_LISTENER_ARN" == "None" ]]; then
  HTTP_LISTENER_ARN="$(aws_run elbv2 create-listener --region "$AWS_REGION" \
    --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
    --query 'Listeners[0].ListenerArn' --output text)"
  note "created HTTP 301 redirect"
else
  note "exists  $HTTP_LISTENER_ARN"
fi

HTTPS_LISTENER_ARN="$(aws elbv2 describe-listeners --region "$AWS_REGION" \
  --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text 2>/dev/null || true)"
if [[ -z "$HTTPS_LISTENER_ARN" || "$HTTPS_LISTENER_ARN" == "None" ]]; then
  HTTPS_LISTENER_ARN="$(aws_run elbv2 create-listener --region "$AWS_REGION" \
    --load-balancer-arn "$ALB_ARN" --protocol HTTPS --port 443 \
    --certificates "CertificateArn=$ACM_ARN" \
    --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" \
    --query 'Listeners[0].ListenerArn' --output text)"
  note "created HTTPS forward → target group"
else
  note "exists  $HTTPS_LISTENER_ARN"
fi

# ---------------------- ECS cluster, task def, service ----------------------
section "ECS cluster"
CLUSTER_ARN="$(aws ecs describe-clusters --region "$AWS_REGION" \
  --clusters "$NAME" --query 'clusters[0].clusterArn' --output text 2>/dev/null || true)"
if [[ -z "$CLUSTER_ARN" || "$CLUSTER_ARN" == "None" || "$CLUSTER_ARN" == "" ]]; then
  CLUSTER_ARN="$(aws_run ecs create-cluster --region "$AWS_REGION" \
    --cluster-name "$NAME" \
    --capacity-providers FARGATE \
    --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1,base=1 \
    --query 'cluster.clusterArn' --output text)"
  note "created $CLUSTER_ARN"
else
  note "exists  $CLUSTER_ARN"
fi
state_set CLUSTER_ARN "$CLUSTER_ARN"

section "ECS task definition"
SECRETS_JSON="["
first=true
for i in "${!SECRET_NAMES[@]}"; do
  $first && first=false || SECRETS_JSON+=","
  SECRETS_JSON+="{\"name\":\"${SECRET_NAMES[$i]}\",\"valueFrom\":\"${SECRET_ARNS[$i]}\"}"
done
SECRETS_JSON+="]"

ENV_JSON="[
  {\"name\":\"NODE_ENV\",\"value\":\"production\"},
  {\"name\":\"HOST\",\"value\":\"0.0.0.0\"},
  {\"name\":\"PORT\",\"value\":\"$CONTAINER_PORT\"},
  {\"name\":\"ALLOW_ALL_GOOGLE_USERS\",\"value\":\"$ALLOW_ALL_GOOGLE_USERS\"},
  {\"name\":\"SUPER_ADMIN_EMAILS\",\"value\":\"$SUPER_ADMIN_EMAILS\"},
  {\"name\":\"ALLOWED_GOOGLE_EMAILS\",\"value\":\"$ALLOWED_GOOGLE_EMAILS\"},
  {\"name\":\"ALLOWED_GOOGLE_DOMAINS\",\"value\":\"$ALLOWED_GOOGLE_DOMAINS\"},
  {\"name\":\"TMUX_MOBILE_SNIPPETS_STORE\",\"value\":\"dynamo\"},
  {\"name\":\"TMUX_MOBILE_USER_PREFS_DYNAMO_TABLE\",\"value\":\"$USER_PREFS_DYNAMO_TABLE\"},
  {\"name\":\"TMUX_MOBILE_USER_PREFS_DYNAMO_REGION\",\"value\":\"$AWS_REGION\"},
  {\"name\":\"GOOGLE_OAUTH_REDIRECT_URI\",\"value\":\"https://${DOMAIN}/auth/google/callback\"}
]"

TD_FILE="$(mktemp)"
cat >"$TD_FILE" <<EOF
{
  "family": "${NAME}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${TASK_CPU}",
  "memory": "${TASK_MEMORY}",
  "executionRoleArn": "${TASK_EXEC_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "runtimePlatform": {
    "operatingSystemFamily": "LINUX",
    "cpuArchitecture": "ARM64"
  },
  "containerDefinitions": [
    {
      "name": "controller",
      "image": "${ECR_URL}:latest",
      "essential": true,
      "portMappings": [{ "containerPort": ${CONTAINER_PORT}, "protocol": "tcp" }],
      "environment": ${ENV_JSON},
      "secrets": ${SECRETS_JSON},
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "controller"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 15
      }
    }
  ]
}
EOF
TD_ARN="$(aws_run ecs register-task-definition --region "$AWS_REGION" \
  --cli-input-json file://"$TD_FILE" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
rm -f "$TD_FILE"
note "registered $TD_ARN"
state_set TD_ARN "$TD_ARN"

section "ECS service"
SVC_EXISTS="$(aws ecs describe-services --region "$AWS_REGION" \
  --cluster "$NAME" --services "$NAME" \
  --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")"
if [[ "$SVC_EXISTS" == "ACTIVE" ]]; then
  note "exists  — updating to new task def + forcing redeploy"
  aws_run ecs update-service --region "$AWS_REGION" \
    --cluster "$NAME" --service "$NAME" \
    --task-definition "$TD_ARN" \
    --force-new-deployment >/dev/null
elif [[ "$SVC_EXISTS" == "INACTIVE" || "$SVC_EXISTS" == "MISSING" || "$SVC_EXISTS" == "None" ]]; then
  # "None" is what `--query services[0].status` prints when the array is
  # empty (jmespath maps undefined to JSON null, CLI prints it as "None").
  aws_run ecs create-service --region "$AWS_REGION" \
    --cluster "$NAME" --service-name "$NAME" \
    --task-definition "$TD_ARN" \
    --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A_ID,$SUBNET_B_ID],securityGroups=[$SG_TASK_ID],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$TG_ARN,containerName=controller,containerPort=$CONTAINER_PORT" \
    --health-check-grace-period-seconds 60 \
    --deployment-configuration "minimumHealthyPercent=50,maximumPercent=200" >/dev/null
  note "created service"
else
  warn "service in unexpected state: $SVC_EXISTS"
fi

# ---------------------- next steps ----------------------
echo
section "Done — next steps"
echo
echo "  1. Populate the placeholder secrets (only needed once, or when rotating):"
for sec in "${SECRET_NAMES[@]}"; do
  [[ "$sec" == "SESSION_SECRET" ]] && continue
  echo "       aws secretsmanager put-secret-value --region $AWS_REGION \\"
  echo "         --secret-id ${NAME}/$sec \\"
  echo "         --secret-string '<value>'"
done
echo
echo "  2. Add the Fargate redirect URI to the Google OAuth client's"
echo "     Authorized redirect URIs list:"
echo "       https://${DOMAIN}/auth/google/callback"
echo
echo "  3. Build + push the first image:"
echo "       ./scripts/push-image.sh"
echo
echo "  4. Once the image is up and ECS reports a healthy task, point"
echo "     ${DOMAIN} at the ALB in Cloudflare:"
echo
echo "       name:    eng"
echo "       type:    CNAME"
echo "       target:  ${ALB_DNS}"
echo "       proxy:   OFF (DNS only)"
echo
echo "  5. Smoke test:"
echo "       curl -sS https://${DOMAIN}/api/health"
echo
echo "  Full state in: $STATE_FILE"
