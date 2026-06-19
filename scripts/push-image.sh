#!/usr/bin/env bash
# Build the controller image, push to ECR, and deploy that exact image tag.
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

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CURRENT_TD="$TMP_DIR/taskdef.json"
NEXT_TD="$TMP_DIR/register-taskdef.json"

echo "==> Registering ECS task definition for image tag $TAG..."
aws ecs describe-task-definition \
  --region "$AWS_REGION" \
  --task-definition "$NAME" \
  --query taskDefinition \
  --output json > "$CURRENT_TD"

node --input-type=module - "$CURRENT_TD" "$NEXT_TD" "$ECR_URL" "$TAG" <<'NODE'
import fs from "node:fs";

const [currentPath, nextPath, image, tag] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));

const containerDefinitions = current.containerDefinitions.map((container) => {
  const next = { ...container, image: `${image}:${tag}` };
  const environment = Array.isArray(next.environment) ? [...next.environment] : [];
  const revision = environment.find((item) => item.name === "TMUX_MOBILE_EXPECTED_REVISION");
  if (revision) {
    revision.value = tag;
  } else {
    environment.push({ name: "TMUX_MOBILE_EXPECTED_REVISION", value: tag });
  }
  next.environment = environment;
  return next;
});

const input = { containerDefinitions };
for (const key of [
  "family",
  "taskRoleArn",
  "executionRoleArn",
  "networkMode",
  "volumes",
  "placementConstraints",
  "requiresCompatibilities",
  "cpu",
  "memory",
  "runtimePlatform",
  "ephemeralStorage",
  "inferenceAccelerators",
  "pidMode",
  "ipcMode",
  "proxyConfiguration",
]) {
  if (current[key] !== undefined && current[key] !== null) input[key] = current[key];
}

fs.writeFileSync(nextPath, JSON.stringify(input, null, 2));
NODE

NEW_TD_ARN="$(aws ecs register-task-definition \
  --region "$AWS_REGION" \
  --cli-input-json "file://$NEXT_TD" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

echo "==> Updating ECS service (${NAME}/${NAME}) to $NEW_TD_ARN..."
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$NAME" \
  --service "$NAME" \
  --task-definition "$NEW_TD_ARN" \
  --output text \
  --query 'service.{name:serviceName,desired:desiredCount,running:runningCount,rollout:deployments[0].rolloutState,taskDefinition:taskDefinition}'

echo
echo "Image:     ${ECR_URL}:${TAG}"
echo "Task def:  ${NEW_TD_ARN}"
echo "Tail logs: aws logs tail /ecs/${NAME} --since 5m --follow --region $AWS_REGION"
