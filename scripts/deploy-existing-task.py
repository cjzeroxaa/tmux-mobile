#!/usr/bin/env python3
"""Release a verified image through the service's existing mutable deployment tag.

No task-definition registration or IAM changes. The source tag stays distinct;
the previous manifest is saved under a rollback tag before the deployment tag
is moved. A failed rollout restores that manifest and rolls the service again.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-tag", required=True)
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--name", default="tmux-mobile-controller")
    parser.add_argument("--health-url", default="https://eng.impo.ai/api/health")
    parser.add_argument("--receipt-dir", required=True)
    parser.add_argument("--plan", action="store_true", help="Read-only preflight")
    args = parser.parse_args()
    receipt = Path(args.receipt_dir)
    receipt.mkdir(parents=True, exist_ok=False, mode=0o700)

    def save(name, data):
        (receipt / name).write_text(json.dumps(data, indent=2) + "\n")

    def aws(*command):
        result = subprocess.run(
            ["aws", "--region", args.region, "--output", "json", *command],
            check=True, capture_output=True, text=True,
            env={**os.environ, "AWS_PAGER": ""},
        )
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def service():
        result = aws("ecs", "describe-services", "--cluster", args.name,
                     "--services", args.name)
        if result.get("failures") or len(result.get("services", [])) != 1:
            raise RuntimeError("Expected exactly one existing ECS service")
        return result["services"][0]

    def health():
        with urllib.request.urlopen(args.health_url, timeout=15) as response:
            return json.load(response)

    def manifest(tag):
        result = aws("ecr", "batch-get-image", "--repository-name", args.name,
                     "--image-ids", f"imageTag={tag}")
        if result.get("failures") or len(result.get("images", [])) != 1:
            raise RuntimeError(f"Cannot resolve image tag {tag}")
        return result["images"][0]

    def put(tag, image):
        existing = aws("ecr", "batch-get-image", "--repository-name", args.name,
                       "--image-ids", f"imageTag={tag}")
        if existing.get("images") and existing["images"][0]["imageId"]["imageDigest"] == image["imageId"]["imageDigest"]:
            return
        aws("ecr", "put-image", "--repository-name", args.name,
            "--image-tag", tag, "--image-manifest", image["imageManifest"])

    before = service()
    if (len(before["deployments"]) != 1
            or before["deployments"][0].get("rolloutState") != "COMPLETED"
            or before["runningCount"] != before["desiredCount"]
            or before["desiredCount"] < 1 or before["pendingCount"]):
        raise RuntimeError("Service must be stable before deployment")
    definition = aws("ecs", "describe-task-definition", "--task-definition",
                     before["taskDefinition"])["taskDefinition"]
    containers = definition["containerDefinitions"]
    if len(containers) != 1 or containers[0]["name"] != "controller":
        raise RuntimeError("Expected the single-container controller definition")
    repository = aws("ecr", "describe-repositories", "--repository-names",
                     args.name)["repositories"][0]
    image_uri = containers[0]["image"]
    if not image_uri.startswith(repository["repositoryUri"] + ":") or "@" in image_uri:
        raise RuntimeError("Existing definition must use this repository's deployment tag")
    if repository["imageTagMutability"] != "MUTABLE":
        raise RuntimeError("Existing deployment tag must already be mutable")
    target_tag = image_uri.rsplit(":", 1)[1]
    if target_tag == args.source_tag:
        raise RuntimeError("Source tag must be separate from deployment tag")
    old, new = manifest(target_tag), manifest(args.source_tag)
    baseline = health()
    if not baseline.get("ok"):
        raise RuntimeError("Production health baseline failed")
    rollback_tag = "rollback-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + old["imageId"]["imageDigest"][7:19]
    plan = dict(sourceTag=args.source_tag, deploymentTag=target_tag,
                expectedRevision=args.expected_revision,
                taskDefinition=before["taskDefinition"], rollbackTag=rollback_tag,
                oldDigest=old["imageId"]["imageDigest"],
                newDigest=new["imageId"]["imageDigest"], baselineHealth=baseline)
    save("plan.json", plan)
    save("old-image.json", old)
    save("new-image.json", new)
    print(json.dumps(plan, indent=2), flush=True)
    if args.plan:
        return

    def unchanged():
        current = service()
        if current["taskDefinition"] != before["taskDefinition"] or current["desiredCount"] != before["desiredCount"]:
            raise RuntimeError("Service configuration changed concurrently; stop and inspect")
        return current

    def rollout():
        result = aws("ecs", "update-service", "--cluster", args.name,
                     "--service", args.name, "--force-new-deployment")
        return result["service"]["deployments"][0]["id"]

    def wait(deployment_id, expected_revision, expected_digest):
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            current = unchanged()
            primary = next(d for d in current["deployments"] if d["status"] == "PRIMARY")
            if primary["id"] != deployment_id:
                raise RuntimeError("A different deployment became primary")
            if primary.get("rolloutState") == "FAILED":
                raise RuntimeError("ECS deployment failed")
            print(f"rollout={primary.get('rolloutState')} running={current['runningCount']} pending={current['pendingCount']}", flush=True)
            if len(current["deployments"]) == 1 and primary.get("rolloutState") == "COMPLETED" and current["runningCount"] == current["desiredCount"] and not current["pendingCount"]:
                live = health()
                if not live.get("ok") or live.get("revision") != expected_revision:
                    raise RuntimeError(f"Live revision does not match {expected_revision}")
                tasks = aws("ecs", "list-tasks", "--cluster", args.name, "--service-name", args.name)["taskArns"]
                details = aws("ecs", "describe-tasks", "--cluster", args.name, "--tasks", *tasks)
                if details.get("failures") or len(details["tasks"]) != current["desiredCount"]:
                    raise RuntimeError("Running task inventory is incomplete")
                # ECR index digests and ECS platform digests can differ. Accept
                # only the platform manifests explicitly listed by the index.
                parsed = json.loads((new if expected_digest == new["imageId"]["imageDigest"] else old)["imageManifest"])
                digests = {expected_digest} | {m["digest"] for m in parsed.get("manifests", [])}
                if any(c.get("imageDigest") not in digests for t in details["tasks"] for c in t["containers"]):
                    raise RuntimeError("Running container digest differs from release")
                return dict(health=live, taskDefinition=current["taskDefinition"],
                            running=current["runningCount"], rollout="COMPLETED",
                            tasks=[{"arn": t["taskArn"], "digests": [c.get("imageDigest") for c in t["containers"]]} for t in details["tasks"]])
            time.sleep(15)
        raise RuntimeError("Timed out waiting for ECS rollout")

    unchanged()
    if manifest(target_tag)["imageId"]["imageDigest"] != plan["oldDigest"]:
        raise RuntimeError("Deployment tag changed concurrently")
    put(rollback_tag, old)
    if manifest(rollback_tag)["imageId"]["imageDigest"] != plan["oldDigest"]:
        raise RuntimeError("Rollback image verification failed")
    deployment_id = None
    try:
        put(target_tag, new)
        if manifest(target_tag)["imageId"]["imageDigest"] != plan["newDigest"]:
            raise RuntimeError("Deployment tag verification failed")
        deployment_id = rollout()
        save("deployment.json", {"id": deployment_id})
        result = wait(deployment_id, args.expected_revision, plan["newDigest"])
        save("success.json", result)
        print(json.dumps(result, indent=2), flush=True)
    except Exception as error:
        save("failure.json", {"error": str(error)})
        current = unchanged()
        if deployment_id and next(d for d in current["deployments"] if d["status"] == "PRIMARY")["id"] != deployment_id:
            raise RuntimeError("A different deployment became primary; inspect before rollback") from error
        if manifest(target_tag)["imageId"]["imageDigest"] != plan["newDigest"]:
            raise RuntimeError("Deployment tag changed; refusing to overwrite concurrent work") from error
        put(target_tag, old)
        restored = wait(rollout(), baseline["revision"], plan["oldDigest"])
        save("rollback.json", restored)
        raise


if __name__ == "__main__":
    main()
