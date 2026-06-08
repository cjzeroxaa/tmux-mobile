#!/usr/bin/env bash
# Build the controller image, push to ECR, force-redeploy the Fargate
# service. Run from the repo root.
#
# Usage:
#   ./scripts/push-image.sh             # tags with git SHA + :latest
#   ./scripts/push-image.sh --no-deploy # push only, don't trigger redeploy
#
# Requires: aws cli (with rebyte-prod creds), docker buildx, terraform
# state in infra/terraform/ already applied (so the ECR repo + ECS
# cluster/service names can be read from outputs).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"

if [[ ! -d "$TF_DIR" ]]; then
  echo "missing $TF_DIR — run terraform apply first" >&2
  exit 1
fi

cd "$TF_DIR"

# Pull deploy targets out of terraform outputs so the script stays in
# sync if you change service_name etc. in TF.
ECR_URL="$(terraform output -raw ecr_repository_url)"
CLUSTER="$(terraform output -raw ecs_cluster_name)"
SERVICE="$(terraform output -raw ecs_service_name)"
REGION="$(awk -F\" '/^variable "aws_region"/,/^}/{ if (/default/) print $2 }' variables.tf | head -1)"

cd "$ROOT_DIR"

GIT_SHA="$(git rev-parse --short HEAD)"
DIRTY=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  DIRTY="-dirty"
fi
TAG="${GIT_SHA}${DIRTY}"

echo "==> Logging in to ECR ($REGION)..."
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"

echo "==> Building linux/arm64 image (tag $TAG, also :latest)..."
docker buildx build \
  --platform linux/arm64 \
  --tag "${ECR_URL}:${TAG}" \
  --tag "${ECR_URL}:latest" \
  --push \
  "$ROOT_DIR"

if [[ "${1:-}" == "--no-deploy" ]]; then
  echo "==> --no-deploy: skipping ECS redeploy."
  exit 0
fi

echo "==> Forcing ECS service redeployment ($CLUSTER/$SERVICE)..."
aws ecs update-service \
  --region "$REGION" \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --force-new-deployment \
  --output text \
  --query 'service.{name:serviceName,desired:desiredCount,running:runningCount,deployments:deployments[0].rolloutState}'

echo
echo "Image:  ${ECR_URL}:${TAG}"
echo "Tail logs: aws logs tail /ecs/tmux-mobile-controller --since 5m --follow --region $REGION"
