#!/usr/bin/env bash
# Tear down everything aws-setup.sh created. Reads scripts/aws-state.env for
# resource IDs; if a resource isn't in state we still try a name-based lookup
# so a partial setup can be cleaned up too.
#
# Idempotent on the way down: missing resources are quietly skipped. Order
# matters — service before cluster, listeners before ALB, ALB before subnets,
# subnets before VPC.
#
# Usage:
#   ./scripts/aws-teardown.sh             # actually destroy
#   ./scripts/aws-teardown.sh --dry-run   # show what would happen
#
# Some things stick around on purpose:
#   - Secrets Manager entries (7-day recovery window)
#   - CloudWatch log group (so post-mortem logs survive)
#   - ECR images (delete manually if you want them gone too)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/scripts/aws-state.env"
[[ -f "$STATE_FILE" ]] && source "$STATE_FILE"

AWS_REGION="${AWS_REGION:-us-east-1}"
NAME="${NAME:-tmux-mobile-controller}"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
section() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
say() {
  if $DRY_RUN; then echo "DRY-RUN: $*"; else "$@"; fi
}

# ---------------------- ECS service + cluster ----------------------
section "ECS service"
SVC_STATUS="$(aws ecs describe-services --region "$AWS_REGION" --cluster "$NAME" --services "$NAME" \
  --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")"
if [[ "$SVC_STATUS" == "ACTIVE" ]]; then
  say aws ecs update-service --region "$AWS_REGION" --cluster "$NAME" --service "$NAME" --desired-count 0 >/dev/null
  say aws ecs delete-service  --region "$AWS_REGION" --cluster "$NAME" --service "$NAME" --force      >/dev/null
  note "deleted service"
else
  note "service: $SVC_STATUS (skip)"
fi

section "ECS cluster"
if aws ecs describe-clusters --region "$AWS_REGION" --clusters "$NAME" \
  --query 'clusters[0].clusterName' --output text 2>/dev/null | grep -q "^$NAME\$"; then
  say aws ecs delete-cluster --region "$AWS_REGION" --cluster "$NAME" >/dev/null
  note "deleted cluster"
else
  note "cluster: missing (skip)"
fi

# ---------------------- task definitions (deregister all) ----------------------
section "Task definitions"
TD_ARNS=( $(aws ecs list-task-definitions --region "$AWS_REGION" --family-prefix "$NAME" --status ACTIVE --query 'taskDefinitionArns' --output text 2>/dev/null || true) )
for td in "${TD_ARNS[@]}"; do
  say aws ecs deregister-task-definition --region "$AWS_REGION" --task-definition "$td" >/dev/null
  note "deregistered $td"
done

# ---------------------- ALB listeners / TG / ALB ----------------------
section "ALB listeners + target group + load balancer"
ALB_ARN="${ALB_ARN:-$(aws elbv2 describe-load-balancers --region "$AWS_REGION" --names "$NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)}"
if [[ -n "$ALB_ARN" && "$ALB_ARN" != "None" ]]; then
  for lst in $(aws elbv2 describe-listeners --region "$AWS_REGION" --load-balancer-arn "$ALB_ARN" --query 'Listeners[].ListenerArn' --output text 2>/dev/null || true); do
    say aws elbv2 delete-listener --region "$AWS_REGION" --listener-arn "$lst" >/dev/null
    note "deleted listener $lst"
  done
  say aws elbv2 delete-load-balancer --region "$AWS_REGION" --load-balancer-arn "$ALB_ARN" >/dev/null
  note "deleted ALB"
  # Wait for the ALB to fully detach before deleting target group / subnets.
  say aws elbv2 wait load-balancers-deleted --region "$AWS_REGION" --load-balancer-arns "$ALB_ARN" || true
fi

TG_ARN="${TG_ARN:-$(aws elbv2 describe-target-groups --region "$AWS_REGION" --names "$NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)}"
if [[ -n "$TG_ARN" && "$TG_ARN" != "None" ]]; then
  say aws elbv2 delete-target-group --region "$AWS_REGION" --target-group-arn "$TG_ARN" >/dev/null
  note "deleted target group"
fi

# ---------------------- ACM cert ----------------------
section "ACM certificate"
ACM_ARN="${ACM_ARN:-$(aws acm list-certificates --region "$AWS_REGION" --query "CertificateSummaryList[?DomainName=='${DOMAIN:-eng.impo.ai}'].CertificateArn | [0]" --output text 2>/dev/null || true)}"
if [[ -n "$ACM_ARN" && "$ACM_ARN" != "None" ]]; then
  say aws acm delete-certificate --region "$AWS_REGION" --certificate-arn "$ACM_ARN" >/dev/null
  note "deleted cert"
fi

# ---------------------- security groups ----------------------
section "Security groups"
for tag in "${NAME}-task" "${NAME}-alb"; do
  sg="$(aws ec2 describe-security-groups --region "$AWS_REGION" --filters "Name=group-name,Values=$tag" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
  if [[ -n "$sg" && "$sg" != "None" ]]; then
    say aws ec2 delete-security-group --region "$AWS_REGION" --group-id "$sg" >/dev/null
    note "deleted $tag $sg"
  fi
done

# ---------------------- route table + subnets + IGW + VPC ----------------------
section "Route table + subnets + IGW + VPC"
RT_ID="${RT_ID:-$(aws ec2 describe-route-tables --region "$AWS_REGION" --filters "Name=tag:Name,Values=${NAME}-public-rt" --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || true)}"
if [[ -n "$RT_ID" && "$RT_ID" != "None" ]]; then
  for assoc in $(aws ec2 describe-route-tables --region "$AWS_REGION" --route-table-ids "$RT_ID" --query 'RouteTables[0].Associations[].RouteTableAssociationId' --output text 2>/dev/null || true); do
    [[ -n "$assoc" && "$assoc" != "None" ]] && say aws ec2 disassociate-route-table --region "$AWS_REGION" --association-id "$assoc" >/dev/null
  done
  say aws ec2 delete-route-table --region "$AWS_REGION" --route-table-id "$RT_ID" >/dev/null
  note "deleted route table"
fi

for tag in "${NAME}-public-us-east-1a" "${NAME}-public-us-east-1b"; do
  sub="$(aws ec2 describe-subnets --region "$AWS_REGION" --filters "Name=tag:Name,Values=$tag" --query 'Subnets[0].SubnetId' --output text 2>/dev/null || true)"
  if [[ -n "$sub" && "$sub" != "None" ]]; then
    say aws ec2 delete-subnet --region "$AWS_REGION" --subnet-id "$sub" >/dev/null
    note "deleted $tag $sub"
  fi
done

IGW_ID="${IGW_ID:-$(aws ec2 describe-internet-gateways --region "$AWS_REGION" --filters "Name=tag:Name,Values=${NAME}-igw" --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null || true)}"
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --region "$AWS_REGION" --filters "Name=tag:Name,Values=${NAME}-vpc" --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)}"
if [[ -n "$IGW_ID" && "$IGW_ID" != "None" ]]; then
  if [[ -n "$VPC_ID" && "$VPC_ID" != "None" ]]; then
    say aws ec2 detach-internet-gateway --region "$AWS_REGION" --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" >/dev/null || true
  fi
  say aws ec2 delete-internet-gateway --region "$AWS_REGION" --internet-gateway-id "$IGW_ID" >/dev/null
  note "deleted IGW"
fi
if [[ -n "$VPC_ID" && "$VPC_ID" != "None" ]]; then
  say aws ec2 delete-vpc --region "$AWS_REGION" --vpc-id "$VPC_ID" >/dev/null
  note "deleted VPC"
fi

# ---------------------- IAM ----------------------
section "IAM roles"
for role in "${NAME}-task-execution" "${NAME}-task"; do
  if aws iam get-role --role-name "$role" --query 'Role.RoleName' --output text 2>/dev/null | grep -q "^$role\$"; then
    for pol in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true); do
      say aws iam detach-role-policy --role-name "$role" --policy-arn "$pol" >/dev/null
    done
    for inline in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames' --output text 2>/dev/null || true); do
      say aws iam delete-role-policy --role-name "$role" --policy-name "$inline" >/dev/null
    done
    say aws iam delete-role --role-name "$role" >/dev/null
    note "deleted $role"
  fi
done

echo
echo "Done. Kept around (delete manually if wanted):"
echo "  - CloudWatch log group /ecs/${NAME}"
echo "  - Secrets Manager entries under ${NAME}/* (7-day recovery window)"
echo "  - ECR repo ${NAME} and any images"
echo "  - Cloudflare DNS records for ${DOMAIN:-eng.impo.ai}"
echo
echo "State file: $STATE_FILE — clear it or delete it before the next aws-setup.sh run."
