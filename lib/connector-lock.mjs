import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_INITIALIZATION_GRACE_MS = 5_000;

/**
 * Acquire the machine-local singleton lock for one Controller + agent identity.
 *
 * `mkdir` is the exclusion primitive. The owner record makes abandoned locks
 * recoverable after an ungraceful process exit, while the random token keeps an
 * old instance from releasing a lock that has since been reacquired.
 */
export function acquireConnectorLock(controller, options = {}) {
  const normalizedController = normalizeController(controller);
  if (!normalizedController) throw new Error("Connector lock requires a controller URL");
  const agentId = String(options.agentId || "").trim().toLowerCase();
  if (!agentId) throw new Error("Connector lock requires an agentId");

  const rootDir = connectorLockRoot(options);
  const pid = positiveInteger(options.pid) || process.pid;
  const token = String(options.token || randomUUID());
  const now = typeof options.now === "function" ? options.now : Date.now;
  const killImpl = options.killImpl || process.kill.bind(process);
  const initializationGraceMs = nonNegativeNumber(
    options.initializationGraceMs,
    DEFAULT_INITIALIZATION_GRACE_MS,
  );
  const lockPath = path.join(rootDir, connectorLockName(normalizedController, agentId));
  const ownerPath = path.join(lockPath, "owner.json");

  mkdirSync(rootDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (created) {
      const owner = {
        pid,
        token,
        controller: normalizedController,
        agentId,
        startedAt: new Date(now()).toISOString(),
      };
      const temporaryOwnerPath = path.join(lockPath, `.owner-${token}.tmp`);
      try {
        writeFileSync(temporaryOwnerPath, `${JSON.stringify(owner, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        renameSync(temporaryOwnerPath, ownerPath);
      } catch (error) {
        // We created this directory and have not published owner.json, so no
        // other caller can legitimately own it yet.
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        acquired: true,
        lockPath,
        owner,
        release() {
          if (released) return false;
          const didRelease = releaseConnectorLock({ lockPath, token });
          if (didRelease) released = true;
          return didRelease;
        },
      };
    }

    const owner = readOwner(ownerPath);
    if (owner && processIsAlive(owner.pid, killImpl)) {
      return { acquired: false, lockPath, owner, reason: "held" };
    }

    // A competing process can observe the directory in the tiny interval
    // between mkdir and the atomic owner.json rename. Do not steal a fresh lock
    // merely because its owner record is not visible yet.
    if (!owner && lockAgeMs(lockPath, now()) < initializationGraceMs) {
      return { acquired: false, lockPath, owner: null, reason: "initializing" };
    }

    const reclaim = reclaimStaleLock(lockPath, {
      killImpl,
      now,
      initializationGraceMs,
    });
    if (reclaim.state === "held" || reclaim.state === "initializing") {
      return {
        acquired: false,
        lockPath,
        owner: reclaim.owner,
        reason: reclaim.state,
      };
    }
  }

  return {
    acquired: false,
    lockPath,
    owner: readOwner(ownerPath),
    reason: "contended",
  };
}

/** Release only when the on-disk owner still carries this caller's token. */
export function releaseConnectorLock({ lockPath, token }) {
  const expectedToken = String(token || "");
  if (!lockPath || !expectedToken) return false;
  const owner = readOwner(path.join(lockPath, "owner.json"));
  if (!owner || owner.token !== expectedToken) return false;
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function connectorLockRoot(options = {}) {
  return path.resolve(
    options.rootDir ||
      process.env.TMUX_MOBILE_CONNECTOR_LOCK_DIR ||
      path.join(os.homedir(), ".config", "tmux-mobile", "connector-locks"),
  );
}

function connectorLockName(controller, agentId) {
  return createHash("sha256").update(`${controller}\0${agentId}`).digest("hex");
}

function normalizeController(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

function readOwner(ownerPath) {
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    const pid = positiveInteger(owner?.pid);
    const token = String(owner?.token || "");
    const controller = String(owner?.controller || "");
    const agentId = String(owner?.agentId || "");
    const startedAt = String(owner?.startedAt || "");
    if (!pid || !token || !controller || !agentId || !startedAt) return null;
    return { pid, token, controller, agentId, startedAt };
  } catch {
    return null;
  }
}

function processIsAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user. Unknown
    // errors are also treated conservatively so we do not steal a live lock.
    return true;
  }
}

function lockAgeMs(lockPath, nowMs) {
  try {
    return Math.max(0, nowMs - statSync(lockPath).mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function reclaimStaleLock(
  lockPath,
  { killImpl, now, initializationGraceMs },
) {
  // Serialize stale-owner decisions. Without this guard, two contenders can
  // both inspect the same dead owner; after the first renames it away and a new
  // process acquires the path, the second contender could accidentally move
  // that new live lock.
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    mkdirSync(reclaimPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") return { state: "contended", owner: null };
    throw error;
  }

  try {
    const ownerPath = path.join(lockPath, "owner.json");
    const currentOwner = readOwner(ownerPath);
    if (currentOwner && processIsAlive(currentOwner.pid, killImpl)) {
      return { state: "held", owner: currentOwner };
    }
    if (!currentOwner && lockAgeMs(lockPath, now()) < initializationGraceMs) {
      return { state: "initializing", owner: null };
    }

    // Rename the exact stale directory out of the canonical namespace before
    // deleting it. A contender may immediately acquire lockPath, but cleanup is
    // confined to the unique tombstone and cannot remove the new owner's lock.
    const tombstonePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(lockPath, tombstonePath);
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "reclaimed", owner: null };
      throw error;
    }
    rmSync(tombstonePath, { recursive: true, force: true });
    return { state: "reclaimed", owner: currentOwner };
  } finally {
    rmSync(reclaimPath, { recursive: true, force: true });
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
