import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  authorizeSshPublicKeyForCurrentUser,
  cjmuxIosAuthorizedKeyMarker,
  normalizeIosDeviceLabel,
  normalizeSshEd25519PublicKey,
} from "../lib/ssh-authorized-keys.mjs";
import {
  detectSshHostCandidates,
  sshHostsFromTailscaleStatus,
} from "../lib/ssh-hosts.mjs";

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function ed25519Key(fill) {
  const blob = Buffer.concat([
    sshString("ssh-ed25519"),
    sshString(Buffer.alloc(32, fill)),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

const keyOne = ed25519Key(1);
const keyTwo = ed25519Key(2);
const testUid = typeof process.getuid === "function" ? process.getuid() : 501;

// Controller-side validation accepts one Ed25519 public key, discards an
// untrusted comment, and computes the OpenSSH SHA256 fingerprint.
const normalized = normalizeSshEd25519PublicKey(`${keyOne} user's iPad`);
assert.equal(normalized.publicKey, keyOne);
assert.match(normalized.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/u);
assert.throws(
  () => normalizeSshEd25519PublicKey("ssh-rsa AAAA"),
  /Only ssh-ed25519/u,
);
assert.throws(
  () =>
    normalizeSshEd25519PublicKey(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-public-key\n-----END OPENSSH PRIVATE KEY-----",
    ),
  /publicKey/u,
);
assert.throws(
  () => normalizeSshEd25519PublicKey(`${keyOne}\n${keyTwo}`),
  /one SSH Ed25519 public-key line/u,
);
assert.throws(
  () => normalizeSshEd25519PublicKey(`command="id" ${keyOne}`),
  /Only ssh-ed25519/u,
);

// Markers are stable and recognizable, but contain neither caller-controlled
// ids nor account identifiers.
const markerOne = cjmuxIosAuthorizedKeyMarker(
  "Owner@Example.com",
  "00000000-0000-4000-8000-000000000001",
);
assert.match(markerOne, /^cjmux-ios:[0-9a-f]{16}:[0-9a-f]{16}$/u);
assert.ok(!markerOne.includes("owner"));
assert.ok(!markerOne.includes("00000000"));
assert.equal(
  markerOne,
  cjmuxIosAuthorizedKeyMarker(
    "owner@example.com",
    "00000000-0000-4000-8000-000000000001",
  ),
);
assert.equal(normalizeIosDeviceLabel("  My iPad  "), "My iPad");
assert.throws(() => normalizeIosDeviceLabel("bad\nlabel"), /deviceLabel/u);

const home = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-ssh-auth-"));
try {
  const sshDirectory = path.join(home, ".ssh");
  const authorizedKeysPath = path.join(sshDirectory, "authorized_keys");
  await mkdir(sshDirectory, { mode: 0o755 });
  await writeFile(
    authorizedKeysPath,
    `${keyTwo} existing-key\n`,
    { mode: 0o644 },
  );

  const options = {
    homeDir: home,
    username: "test-user",
    systemHostname: "test.local",
    sshHosts: ["test.tail.example.ts.net", "100.64.0.8", "test.local"],
    platform: "darwin",
    uid: testUid,
    allowRoot: testUid === 0,
  };
  let result = await authorizeSshPublicKeyForCurrentUser(
    { publicKey: keyOne, marker: markerOne },
    options,
  );
  assert.equal(result.installed, true);
  assert.equal(result.present, true);
  assert.equal(result.changed, true);
  assert.equal(result.username, "test-user");
  assert.deepEqual(result.sshHosts, options.sshHosts);

  let contents = await readFile(authorizedKeysPath, "utf8");
  assert.match(contents, /existing-key/u, "unrelated keys are preserved");
  assert.match(
    contents,
    new RegExp(
      `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${keyOne.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} ${markerOne}`,
      "u",
    ),
  );
  assert.equal((await lstat(sshDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(authorizedKeysPath)).mode & 0o777, 0o600);

  result = await authorizeSshPublicKeyForCurrentUser(
    { publicKey: keyOne, marker: markerOne },
    options,
  );
  assert.equal(result.installed, false);
  assert.equal(result.changed, false, "re-authorizing the same key is idempotent");
  assert.equal(
    (await readFile(authorizedKeysPath, "utf8")).split(markerOne).length - 1,
    1,
    "the marker appears exactly once",
  );

  // Key rotation for the same device replaces that marker instead of appending
  // a second durable login.
  result = await authorizeSshPublicKeyForCurrentUser(
    { publicKey: keyTwo, marker: markerOne },
    options,
  );
  assert.equal(result.changed, true);
  contents = await readFile(authorizedKeysPath, "utf8");
  assert.equal(contents.split(markerOne).length - 1, 1);
  assert.match(contents, new RegExp(keyTwo.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  // Concurrent device grants are serialized so neither read-modify-write loses
  // the other's authorized key.
  const markerTwo = cjmuxIosAuthorizedKeyMarker(
    "owner@example.com",
    "00000000-0000-4000-8000-000000000002",
  );
  await Promise.all([
    authorizeSshPublicKeyForCurrentUser(
      { publicKey: keyOne, marker: markerOne },
      options,
    ),
    authorizeSshPublicKeyForCurrentUser(
      { publicKey: keyTwo, marker: markerTwo },
      options,
    ),
  ]);
  contents = await readFile(authorizedKeysPath, "utf8");
  assert.equal(contents.split(markerOne).length - 1, 1);
  assert.equal(contents.split(markerTwo).length - 1, 1);

  await assert.rejects(
    authorizeSshPublicKeyForCurrentUser(
      { publicKey: keyOne, marker: markerOne },
      { ...options, uid: 0, allowRoot: false },
    ),
    /Refusing to authorize SSH access for root/u,
  );

  const cappedHome = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-ssh-cap-"));
  try {
    const cappedSsh = path.join(cappedHome, ".ssh");
    await mkdir(cappedSsh, { mode: 0o700 });
    const markers = Array.from({ length: 64 }, (_, index) =>
      cjmuxIosAuthorizedKeyMarker("owner@example.com", `device-${index}`),
    );
    await writeFile(
      path.join(cappedSsh, "authorized_keys"),
      markers.map((marker) => `${keyOne} ${marker}`).join("\n") + "\n",
      { mode: 0o600 },
    );
    await assert.rejects(
      authorizeSshPublicKeyForCurrentUser(
        {
          publicKey: keyTwo,
          marker: cjmuxIosAuthorizedKeyMarker("owner@example.com", "device-65"),
        },
        { ...options, homeDir: cappedHome },
      ),
      (error) => error.status === 409 && error.code === "too_many_cjmux_keys",
    );
    const rotation = await authorizeSshPublicKeyForCurrentUser(
      { publicKey: keyTwo, marker: markers[0] },
      { ...options, homeDir: cappedHome },
    );
    assert.equal(rotation.installed, true, "an existing device can rotate at the cap");
  } finally {
    await rm(cappedHome, { recursive: true, force: true });
  }

  // Never follow an attacker-controlled authorized_keys symlink.
  const unsafeHome = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-ssh-unsafe-"));
  try {
    const outside = path.join(unsafeHome, "outside");
    const unsafeSsh = path.join(unsafeHome, "home", ".ssh");
    await mkdir(unsafeSsh, { recursive: true });
    await writeFile(outside, "untouched\n");
    await symlink(outside, path.join(unsafeSsh, "authorized_keys"));
    await assert.rejects(
      authorizeSshPublicKeyForCurrentUser(
        { publicKey: keyOne, marker: markerOne },
        { ...options, homeDir: path.join(unsafeHome, "home") },
      ),
      /must be a regular file/u,
    );
    assert.equal(await readFile(outside, "utf8"), "untouched\n");
  } finally {
    await rm(unsafeHome, { recursive: true, force: true });
  }
} finally {
  await rm(home, { recursive: true, force: true });
}

const tailscaleStatus = {
  BackendState: "Running",
  Self: {
    Online: true,
    DNSName: "macbook.example.ts.net.",
    TailscaleIPs: ["100.64.0.9", "fd7a:115c:a1e0::9", "not-an-ip"],
  },
};
assert.deepEqual(
  sshHostsFromTailscaleStatus(tailscaleStatus, "MacBook.local"),
  ["MacBook.local", "macbook.example.ts.net", "100.64.0.9", "fd7a:115c:a1e0::9"],
);
assert.deepEqual(
  await detectSshHostCandidates({
    systemHostname: "fallback.local",
    run: async () => ({ error: new Error("tailscale missing"), stdout: "" }),
  }),
  ["fallback.local"],
  "Tailscale absence never prevents Connector startup",
);

console.log("ssh authorize unit tests passed");
