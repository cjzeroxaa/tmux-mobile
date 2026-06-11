#!/usr/bin/env bash
# Build the controller image, push to ECR, force-redeploy the Fargate service.
# Reads scripts/aws-state.env for the resource names that aws-setup.sh
# persisted, so this stays in sync without any hand-coded ARNs.
#
# Usage:
#   ./scripts/push-image.sh             # tags with git SHA + :latest, then redeploys
#   ./scripts/push-image.sh --no-deploy # build + push only

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/scripts/aws-state.env"
if [[ ! -f "$STATE_FILE" ]]; then
  echo "missing $STATE_FILE — run ./scripts/aws-setup.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$STATE_FILE"

: "${ECR_URL:?ECR_URL not in state — re-run aws-setup.sh}"
: "${AWS_REGION:?AWS_REGION not in state}"
: "${NAME:?NAME not in state}"

cd "$ROOT_DIR"
GIT_SHA="$(git rev-parse --short HEAD)"
DIRTY=""
if ! git diff --quiet || ! git diff --cached --quiet; then DIRTY="-dirty"; fi
TAG="${GIT_SHA}${DIRTY}"

echo "==> Logging in to ECR ($AWS_REGION)..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"

echo "==> Building linux/arm64 image (tag $TAG + :latest)..."
docker buildx build \
  --platform linux/arm64 \
  --build-arg "TMUX_MOBILE_REVISION=${TAG}" \
  --tag "${ECR_URL}:${TAG}" \
  --tag "${ECR_URL}:latest" \
  --push \
  "$ROOT_DIR"

if [[ "${1:-}" == "--no-deploy" ]]; then
  echo "==> --no-deploy: skipping ECS redeploy."
  exit 0
fi

echo "==> Forcing ECS service redeployment (${NAME}/${NAME})..."
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$NAME" \
  --service "$NAME" \
  --force-new-deployment \
  --output text \
  --query 'service.{name:serviceName,desired:desiredCount,running:runningCount,rollout:deployments[0].rolloutState}'

echo
echo "Image:     ${ECR_URL}:${TAG}"
echo "Tail logs: aws logs tail /ecs/${NAME} --since 5m --follow --region $AWS_REGION"
