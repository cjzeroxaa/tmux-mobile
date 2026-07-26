import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEY_TYPE = "ssh-ed25519";
const KEY_PREFIX = `${KEY_TYPE} `;
const MAX_PUBLIC_KEY_CHARS = 4_096;
const MAX_AUTHORIZED_KEYS_BYTES = 16 * 1024 * 1024;
const MAX_CJMUX_MANAGED_KEYS = 64;
const AUTHORIZED_KEYS_LOCK_TIMEOUT_MS = 5_000;
const AUTHORIZED_KEYS_STALE_LOCK_MS = 30_000;
const MARKER_RE = /^cjmux-ios:[0-9a-f]{16}:[0-9a-f]{16}$/;
const AUTHORIZED_KEY_RESTRICTIONS =
  "no-agent-forwarding,no-port-forwarding,no-X11-forwarding";
const installQueues = new Map();

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function securityError(message) {
  const error = new Error(message);
  error.code = "unsafe_authorized_keys";
  return error;
}

function canonicalBase64(value) {
  const raw = String(value || "");
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw inputError("publicKey must contain valid base64 key bytes");
  }
  const bytes = Buffer.from(raw, "base64");
  if (
    bytes.length === 0 ||
    bytes.toString("base64").replace(/=+$/u, "") !== raw.replace(/=+$/u, "")
  ) {
    throw inputError("publicKey must contain canonical base64 key bytes");
  }
  return { bytes, base64: bytes.toString("base64") };
}

function readSshString(buffer, offset) {
  if (offset + 4 > buffer.length) {
    throw inputError("publicKey is not a complete SSH public key");
  }
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buffer.length) {
    throw inputError("publicKey is not a complete SSH public key");
  }
  return { value: buffer.subarray(start, end), offset: end };
}

/**
 * Accept exactly one OpenSSH Ed25519 public-key line. User comments are
 * deliberately discarded: only the Controller-generated marker is ever
 * written to authorized_keys.
 */
export function normalizeSshEd25519PublicKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw inputError("publicKey is required");
  }
  if (
    value.length > MAX_PUBLIC_KEY_CHARS ||
    /[\r\n\0]/u.test(value) ||
    /PRIVATE KEY/u.test(value)
  ) {
    throw inputError("publicKey must be one SSH Ed25519 public-key line");
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) {
    throw inputError("Only ssh-ed25519 public keys are supported");
  }
  const fields = trimmed.split(/[ \t]+/u);
  if (fields.length < 2 || fields[0] !== KEY_TYPE) {
    throw inputError("Only ssh-ed25519 public keys are supported");
  }

  const decoded = canonicalBase64(fields[1]);
  const algorithm = readSshString(decoded.bytes, 0);
  const keyBytes = readSshString(decoded.bytes, algorithm.offset);
  if (
    algorithm.value.toString("utf8") !== KEY_TYPE ||
    keyBytes.value.length !== 32 ||
    keyBytes.offset !== decoded.bytes.length
  ) {
    throw inputError("publicKey is not a valid SSH Ed25519 public key");
  }

  return {
    publicKey: `${KEY_TYPE} ${decoded.base64}`,
    fingerprint: `SHA256:${createHash("sha256")
      .update(decoded.bytes)
      .digest("base64")
      .replace(/=+$/u, "")}`,
  };
}

function markerHash(value) {
  return createHash("sha256")
    .update(String(value || "").trim().toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Stable across key rotation for one authenticated user + iOS installation.
 * Neither the account identifier nor the caller-controlled device id is copied
 * into the file.
 */
export function cjmuxIosAuthorizedKeyMarker(userId, deviceId) {
  const user = String(userId || "").trim();
  const device = String(deviceId || "").trim();
  if (!user) throw inputError("Authenticated user is required");
  if (!device || device.length > 256 || /[\0-\x1f\x7f]/u.test(device)) {
    throw inputError("deviceId must be 1-256 printable characters");
  }
  return `cjmux-ios:${markerHash(user)}:${markerHash(device)}`;
}

export function normalizeIosDeviceLabel(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 128 || /[\0-\x1f\x7f]/u.test(value)) {
    throw inputError("deviceLabel must be at most 128 printable characters");
  }
  return value.trim();
}

export function validateCjmuxAuthorizedKeyMarker(value) {
  const marker = String(value || "");
  if (!MARKER_RE.test(marker)) {
    throw inputError("Invalid CJMUX authorized-key marker");
  }
  return marker;
}

function lineHasMarker(line, marker) {
  const fields = String(line || "").trim().split(/[ \t]+/u);
  return fields.length >= 3 && fields.at(-1) === marker;
}

function managedMarkerForLine(line) {
  const marker = String(line || "").trim().split(/[ \t]+/u).at(-1) || "";
  return MARKER_RE.test(marker) ? marker : "";
}

function assertOwnedByUid(info, target, uid) {
  if (Number.isInteger(uid) && uid >= 0 && Number(info.uid) !== uid) {
    throw securityError(`${target} must be owned by the Connector OS user`);
  }
}

async function assertSafeDirectory(directory, uid) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw securityError(`${directory} must be a real directory`);
  }
  assertOwnedByUid(info, directory, uid);
}

async function readExistingAuthorizedKeys(filePath, uid) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw securityError(`${filePath} must be a regular file`);
    }
    assertOwnedByUid(info, filePath, uid);
    if (info.size > MAX_AUTHORIZED_KEYS_BYTES) {
      throw securityError(`${filePath} is too large to update safely`);
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireAuthorizedKeysLock(directory, uid) {
  const lockPath = path.join(directory, ".cjmux-authorized-keys.lock");
  const deadline = Date.now() + AUTHORIZED_KEYS_LOCK_TIMEOUT_MS;
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await handle.close();
        } finally {
          await unlink(lockPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        }
      };
    } catch (error) {
      const created = Boolean(handle);
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") {
        if (created) await unlink(lockPath).catch(() => {});
        throw error;
      }

      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw securityError(`${lockPath} must be a regular file`);
        }
        assertOwnedByUid(info, lockPath, uid);
        if (Date.now() - info.mtimeMs > AUTHORIZED_KEYS_STALE_LOCK_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
        throw lockError;
      }

      if (Date.now() >= deadline) {
        const busy = new Error("Timed out waiting to update authorized_keys");
        busy.status = 503;
        busy.code = "authorized_keys_busy";
        throw busy;
      }
      await wait(50);
    }
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Some filesystems/platforms reject fsync on a directory. The file itself
    // has already been fsynced, so this is a best-effort durability barrier.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteAuthorizedKeys(filePath, contents) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.authorized_keys.cjmux-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function installUnlocked({ publicKey, marker, homeDir, uid }) {
  const normalized = normalizeSshEd25519PublicKey(publicKey);
  const safeMarker = validateCjmuxAuthorizedKeyMarker(marker);
  const root = path.resolve(String(homeDir || ""));
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw securityError("Cannot determine a safe OS user home directory");
  }

  await assertSafeDirectory(root, uid);
  const sshDirectory = path.join(root, ".ssh");
  const authorizedKeysPath = path.join(sshDirectory, "authorized_keys");
  await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(sshDirectory, uid);
  await chmod(sshDirectory, 0o700);

  const releaseLock = await acquireAuthorizedKeysLock(sshDirectory, uid);
  try {
    const existing = await readExistingAuthorizedKeys(authorizedKeysPath, uid);
    // Keep an interactive PTY available, but do not turn this convenience key
    // into an agent, TCP forwarding, or X11 pivot through the target machine.
    const desiredLine =
      `${AUTHORIZED_KEY_RESTRICTIONS} ${normalized.publicKey} ${safeMarker}`;
    const sourceLines = existing.split(/\n/u).map((line) => line.replace(/\r$/u, ""));
    const managedMarkers = new Set(sourceLines.map(managedMarkerForLine).filter(Boolean));
    if (!managedMarkers.has(safeMarker) && managedMarkers.size >= MAX_CJMUX_MANAGED_KEYS) {
      const error = new Error(
        `authorized_keys already has ${MAX_CJMUX_MANAGED_KEYS} CJMUX-managed devices`,
      );
      error.status = 409;
      error.code = "too_many_cjmux_keys";
      throw error;
    }
    const matchingLines = sourceLines.filter((line) => lineHasMarker(line, safeMarker));
    const alreadyInstalled =
      matchingLines.length === 1 && matchingLines[0].trim() === desiredLine;

    if (!alreadyInstalled) {
      const kept = sourceLines.filter((line) => !lineHasMarker(line, safeMarker));
      while (kept.length > 0 && kept.at(-1) === "") kept.pop();
      const next = `${[...kept, desiredLine].join("\n").replace(/^\n+/u, "")}\n`;
      if (Buffer.byteLength(next, "utf8") > MAX_AUTHORIZED_KEYS_BYTES) {
        throw securityError(`${authorizedKeysPath} is too large to update safely`);
      }
      await atomicWriteAuthorizedKeys(authorizedKeysPath, next);
    } else {
      await chmod(authorizedKeysPath, 0o600);
    }

    return {
      installed: !alreadyInstalled,
      present: true,
      changed: !alreadyInstalled,
      fingerprint: normalized.fingerprint,
      path: authorizedKeysPath,
    };
  } finally {
    await releaseLock();
  }
}

/**
 * Install on the Connector process's OS account only. The home directory and
 * username are intentionally not accepted from the wire payload.
 */
export async function authorizeSshPublicKeyForCurrentUser(
  { publicKey, marker } = {},
  {
    homeDir = os.homedir(),
    username = os.userInfo().username,
    systemHostname = os.hostname(),
    sshHosts = [systemHostname],
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : null,
    allowRoot = process.env.TMUX_MOBILE_ALLOW_ROOT_SSH_AUTHORIZE === "1",
  } = {},
) {
  if (platform === "win32") {
    const error = new Error("SSH key authorization is only supported on Unix-like connectors");
    error.status = 501;
    error.code = "unsupported_platform";
    throw error;
  }
  if (uid === 0 && !allowRoot) {
    const error = new Error(
      "Refusing to authorize SSH access for root; run the Connector as the target OS user",
    );
    error.status = 403;
    error.code = "root_authorization_disabled";
    throw error;
  }

  const authorizedKeysPath = path.join(path.resolve(homeDir), ".ssh", "authorized_keys");
  const previous = installQueues.get(authorizedKeysPath) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => installUnlocked({ publicKey, marker, homeDir, uid }));
  installQueues.set(authorizedKeysPath, current);
  try {
    const result = await current;
    return {
      ...result,
      username: String(username || ""),
      systemHostname: String(systemHostname || ""),
      sshHosts: Array.isArray(sshHosts)
        ? sshHosts.map((host) => String(host || "").trim()).filter(Boolean)
        : [String(systemHostname || "")].filter(Boolean),
      port: 22,
    };
  } finally {
    if (installQueues.get(authorizedKeysPath) === current) {
      installQueues.delete(authorizedKeysPath);
    }
  }
}
