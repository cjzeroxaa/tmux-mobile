#!/usr/bin/env bash
# Build the controller image, then roll its existing ECS task definition.
# Reads scripts/aws-state.env for the resource names that aws-setup.sh
# persisted, so this stays in sync without any hand-coded ARNs.
#
# Usage:
#   ./scripts/push-image.sh             # unique source tag, rollback, deploy, verify
#   ./scripts/push-image.sh --no-deploy # build + push only

set -euo pipefail

case "${1:-}" in
  ""|--no-deploy) ;;
  *) echo "Usage: $0 [--no-deploy]" >&2; exit 2 ;;
esac

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
TAG="${GIT_SHA}${DIRTY}-$(date -u +%Y%m%dT%H%M%SZ)"

echo "==> Logging in to ECR ($AWS_REGION)..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"

echo "==> Building linux/arm64 image (source tag $TAG)..."
docker buildx build \
  --platform linux/arm64 \
  --build-arg "TMUX_MOBILE_REVISION=${TAG}" \
  --tag "${ECR_URL}:${TAG}" \
  --push \
  "$ROOT_DIR"

if [[ "${1:-}" == "--no-deploy" ]]; then
  echo "==> --no-deploy: skipping ECS redeploy."
  exit 0
fi

# This is the existing production release channel. Registering a new task
# definition needs PassRole, while normal application-only releases do not.
python3 "$ROOT_DIR/scripts/deploy-existing-task.py" \
  --region "$AWS_REGION" --name "$NAME" \
  --source-tag "$TAG" --expected-revision "$TAG" \
  --receipt-dir "${TMPDIR:-/tmp}/tmux-mobile-deploy-$TAG"
