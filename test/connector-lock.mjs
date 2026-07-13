import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireConnectorLock,
  connectorLockRoot,
} from "../lib/connector-lock.mjs";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tmux-mobile-connector-lock-"));
const alive = new Set();
const killImpl = (pid) => {
  if (alive.has(pid)) return;
  const error = new Error("no such process");
  error.code = "ESRCH";
  throw error;
};

try {
  alive.add(101);
  const first = acquireConnectorLock("https://eng.impo.ai/path", {
    rootDir: tmp,
    agentId: "agent-one",
    pid: 101,
    token: "first-token",
    killImpl,
  });
  assert.equal(first.acquired, true);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(first.lockPath, "owner.json"), "utf8")),
    {
      pid: 101,
      token: "first-token",
      controller: "https://eng.impo.ai",
      agentId: "agent-one",
      startedAt: first.owner.startedAt,
    },
    "owner record contains the durable lock identity",
  );

  const duplicate = acquireConnectorLock("https://eng.impo.ai/", {
    rootDir: tmp,
    agentId: "agent-one",
    pid: 202,
    token: "duplicate-token",
    killImpl,
  });
  assert.equal(duplicate.acquired, false);
  assert.equal(duplicate.reason, "held");
  assert.equal(duplicate.owner.pid, 101);
  assert.equal(duplicate.owner.token, "first-token");

  const otherController = acquireConnectorLock("https://other.example", {
    rootDir: tmp,
    agentId: "agent-one",
    pid: 202,
    token: "other-token",
    killImpl,
  });
  assert.equal(otherController.acquired, true, "different controllers have different locks");
  assert.equal(otherController.release(), true);

  const otherIdentity = acquireConnectorLock("https://eng.impo.ai", {
    rootDir: tmp,
    agentId: "agent-two",
    pid: 202,
    token: "other-identity-token",
    killImpl,
  });
  assert.equal(
    otherIdentity.acquired,
    true,
    "different agent identities may connect to the same controller",
  );
  assert.equal(otherIdentity.release(), true);

  // A dead owner is reclaimed without requiring a graceful cleanup.
  alive.delete(101);
  alive.add(303);
  const replacement = acquireConnectorLock("https://eng.impo.ai", {
    rootDir: tmp,
    agentId: "agent-one",
    pid: 303,
    token: "replacement-token",
    killImpl,
  });
  assert.equal(replacement.acquired, true);
  assert.equal(replacement.owner.pid, 303);

  // The old process must not remove a replacement's lock when its delayed
  // shutdown handler eventually runs.
  assert.equal(first.release(), false);
  const replacementOwner = JSON.parse(
    readFileSync(path.join(replacement.lockPath, "owner.json"), "utf8"),
  );
  assert.equal(replacementOwner.token, "replacement-token");
  assert.equal(replacement.release(), true);
  assert.equal(replacement.release(), false, "release is idempotent");

  const previousOverride = process.env.TMUX_MOBILE_CONNECTOR_LOCK_DIR;
  process.env.TMUX_MOBILE_CONNECTOR_LOCK_DIR = path.join(tmp, "override");
  assert.equal(connectorLockRoot(), path.join(tmp, "override"));
  if (previousOverride === undefined) delete process.env.TMUX_MOBILE_CONNECTOR_LOCK_DIR;
  else process.env.TMUX_MOBILE_CONNECTOR_LOCK_DIR = previousOverride;

  console.log("connector singleton lock tests passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
