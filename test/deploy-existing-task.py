"""Offline checks: read-only plan, verified release, and failed-health rollback."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "deploy", Path(__file__).resolve().parents[1] / "scripts/deploy-existing-task.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ReleaseTest(unittest.TestCase):
    def run_release(self, mode, health_url=None):
        old_digest, new_digest = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        images = {"old-deployment": old_digest, "candidate": new_digest}
        current_digest = old_digest
        deployment_id = "initial"
        calls = []
        health_calls = []

        def service():
            return dict(taskDefinition="controller:163", desiredCount=1,
                        runningCount=1, pendingCount=0,
                        deployments=[dict(id=deployment_id, status="PRIMARY", rolloutState="COMPLETED")])

        def run(command, **kwargs):
            nonlocal current_digest, deployment_id
            c = command[5:]
            calls.append(c)
            action = tuple(c[:2])
            if action == ("ecs", "describe-services"):
                data = {"services": [service()]}
            elif action == ("ecs", "describe-task-definition"):
                data = {"taskDefinition": {"containerDefinitions": [{"name": "controller", "image": "ecr/controller:old-deployment"}]}}
            elif action == ("ecr", "describe-repositories"):
                data = {"repositories": [{"repositoryUri": "ecr/controller", "imageTagMutability": "MUTABLE"}]}
            elif action == ("ecr", "batch-get-image"):
                tag = c[c.index("--image-ids") + 1].split("=", 1)[1]
                data = {"images": [{"imageId": {"imageDigest": images[tag]}, "imageManifest": json.dumps({"schemaVersion": 2, "testDigest": images[tag]})}]} if tag in images else {"images": [], "failures": ["not found"]}
            elif action == ("ecr", "put-image"):
                tag = c[c.index("--image-tag") + 1]
                images[tag] = json.loads(c[c.index("--image-manifest") + 1])["testDigest"]
                data = {}
            elif action == ("ecs", "update-service"):
                self.assertNotIn("--task-definition", c)
                self.assertIn("--force-new-deployment", c)
                current_digest = images["old-deployment"]
                deployment_id = "deploy-" + str(len(calls))
                data = {"service": service()}
            elif action == ("ecs", "list-tasks"):
                data = {"taskArns": ["task1"]}
            elif action == ("ecs", "describe-tasks"):
                data = {"tasks": [{"taskArn": "task1", "containers": [{"imageDigest": current_digest}]}]}
            else:
                self.fail(f"Unexpected cloud operation: {action}")
            return subprocess.CompletedProcess(command, 0, json.dumps(data), "")

        def health(url, **kwargs):
            health_calls.append(url)
            revision = "old" if current_digest == old_digest else "new"
            if mode == "fail" and revision == "new":
                revision = "wrong"
            if mode == "legacy-fail" and revision == "new" and url == deploy.PRODUCTION_HEALTH_URLS[1]:
                revision = "old"
            return io.BytesIO(json.dumps(dict(ok=True, revision=revision)).encode())

        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root) / "receipt"
            argv = ["deploy", "--source-tag", "candidate", "--expected-revision", "new", "--receipt-dir", str(receipt)]
            if health_url:
                argv.extend(["--health-url", health_url])
            if mode == "plan":
                argv.append("--plan")
            with patch("sys.argv", argv), patch.object(deploy.subprocess, "run", side_effect=run), patch.object(deploy.urllib.request, "urlopen", side_effect=health), patch("sys.stdout", new_callable=io.StringIO):
                if mode in ("fail", "legacy-fail"):
                    with self.assertRaisesRegex(RuntimeError, "Live revision|Production domain versions differ"):
                        deploy.main()
                    self.assertTrue((receipt / "rollback.json").exists())
                    self.assertEqual(images["old-deployment"], old_digest)
                    self.assertEqual(current_digest, old_digest)
                else:
                    deploy.main()
                    if mode == "plan":
                        self.assertFalse(any(c[1] in ["put-image", "update-service"] for c in calls))
                    else:
                        self.assertTrue((receipt / "success.json").exists())
                        self.assertEqual(current_digest, new_digest)
                        plan = json.loads((receipt / "plan.json").read_text())
                        self.assertEqual(images[plan["rollbackTag"]], old_digest)
            expected_urls = set(deploy.PRODUCTION_HEALTH_URLS) if not health_url or health_url in deploy.PRODUCTION_HEALTH_URLS else {health_url}
            self.assertEqual(set(health_calls), expected_urls)
            self.assertTrue(all(health_calls.count(url) == health_calls.count(health_calls[0]) for url in expected_urls))

    def test_plan_is_read_only(self):
        self.run_release("plan")

    def test_verified_release_keeps_rollback(self):
        self.run_release("success")

    def test_failed_health_restores_old_image(self):
        self.run_release("fail")

    def test_old_domain_revision_failure_rolls_back(self):
        self.run_release("legacy-fail")

    def test_old_primary_still_checks_new_domain(self):
        self.run_release("success", deploy.PRODUCTION_HEALTH_URLS[1])

    def test_custom_endpoint_does_not_check_production(self):
        self.run_release("success", "http://localhost:8080/api/health")


if __name__ == "__main__":
    unittest.main()
