// Unit tests for the pinned-artifact metadata store (lib/pins.mjs). Covers:
// content-hash dedup, family versioning, canSeePin visibility truth table,
// owner-only updateShare/deletePin, refcounted storage deletion, durability
// across a simulated restart (records survive in the PinIndex backend), and
// sanitize-on-read of malformed records. Uses an in-memory PinIndex and a fake
// blob-storage driver that spies on put/delete.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "tmux-mobile-pins-"));

const {
  createPin,
  listPins,
  getPinByToken,
  getPinById,
  updateShare,
  deletePin,
  canSeePin,
  setPinIndex,
  hydratePins,
  _resetPinsCache,
} = await import("../lib/pins.mjs");

const { createMemoryPinIndex, createFilePinIndex } = await import("../lib/pin-index.mjs");

// Register a fresh in-memory index for the bulk of the tests.
let index = createMemoryPinIndex();
setPinIndex(index);
await hydratePins();

// A fake content-addressed BLOB storage driver that records put/delete calls.
function fakeStorage() {
  const objects = new Map();
  const puts = [];
  const deletes = [];
  return {
    kind: "local",
    objects,
    puts,
    deletes,
    servesDirectly() {
      return false;
    },
    async put(key, bytes) {
      puts.push(key);
      if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
      return { key, size: bytes.length };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { bytes, size: bytes.length } : null;
    },
    async delete(key) {
      deletes.push(key);
      objects.delete(key);
    },
    async url() {
      return "";
    },
  };
}

const alice = { userId: "alice@x.com", email: "alice@x.com", hd: "x.com" };
const bob = { userId: "bob@x.com", email: "bob@x.com", hd: "x.com" };
const carol = { userId: "carol@y.com", email: "carol@y.com", hd: "y.com" };

let clock = 1000;
const now = () => clock++;

try {
  const storage = fakeStorage();

  // --- Dedup: same bytes + same source pinned twice → one record, one put. ---
  const r1 = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("report v1"),
      name: "report.md",
      ext: ".md",
      kind: "markdown",
      contentType: "text/markdown",
      sourcePath: "/proj/report.md",
      sourceMachineId: "m1",
      share: { scope: "private" },
    },
    { storage, now },
  );
  assert.equal(r1.deduped, false);
  assert.equal(r1.pin.version, 1);

  const r1again = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("report v1"),
      name: "report.md",
      ext: ".md",
      kind: "markdown",
      sourcePath: "/proj/report.md",
      sourceMachineId: "m1",
    },
    { storage, now },
  );
  assert.equal(r1again.deduped, true, "unchanged content must dedup");
  assert.equal(r1again.pin.id, r1.pin.id, "dedup returns the same record");
  assert.equal(storage.puts.length, 1, "dedup must not write storage again");

  // --- Versioning: changed bytes for the same source → new version. ---
  const r2 = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("report v2 CHANGED"),
      name: "report.md",
      ext: ".md",
      kind: "markdown",
      sourcePath: "/proj/report.md",
      sourceMachineId: "m1",
    },
    { storage, now },
  );
  assert.equal(r2.deduped, false);
  assert.equal(r2.pin.version, 2, "changed content increments version");
  assert.notEqual(r2.pin.id, r1.pin.id);
  assert.equal(r2.pin.family, r1.pin.family, "same source stays one family");
  assert.equal(storage.puts.length, 2);
  // Both versions retained.
  assert.ok(await getPinById(r1.pin.id));
  assert.ok(await getPinById(r2.pin.id));

  // --- canSeePin truth table (pure predicate over a record). ---
  const priv = r2.pin; // private, owned by alice
  assert.equal(canSeePin(alice, priv), true, "owner sees own private pin");
  assert.equal(canSeePin(bob, priv), false, "private hidden from others");

  // scope: all
  await updateShare(priv.id, alice, { scope: "all" }, { now });
  let after = await getPinById(priv.id);
  assert.equal(canSeePin(bob, after), true, "all → any logged-in viewer");
  assert.equal(canSeePin(carol, after), true);

  // scope: users (case-insensitive match)
  await updateShare(priv.id, alice, { scope: "users", users: ["BOB@X.COM"] }, { now });
  after = await getPinById(priv.id);
  assert.equal(canSeePin(bob, after), true, "listed user sees it (case-insensitive)");
  assert.equal(canSeePin(carol, after), false, "unlisted user does not");
  assert.equal(canSeePin(alice, after), true, "owner always sees it");

  // scope: org (same Google Workspace hosted domain as the owner)
  await updateShare(priv.id, alice, { scope: "org" }, { now });
  after = await getPinById(priv.id);
  assert.equal(canSeePin(bob, after), true, "same-domain viewer sees org pin");
  assert.equal(canSeePin(carol, after), false, "other-domain viewer does not");
  assert.equal(canSeePin(alice, after), true, "owner always sees it");
  assert.equal(
    canSeePin({ userId: "x@gmail.com", email: "x@gmail.com", hd: "" }, after),
    false,
    "no-hd (consumer) viewer never matches org",
  );

  // --- Owner-only mutation (async → assert.rejects). ---
  await assert.rejects(
    () => updateShare(priv.id, bob, { scope: "all" }),
    (e) => e.status === 403,
    "non-owner cannot re-scope",
  );
  await assert.rejects(
    () => updateShare(priv.id, alice, { scope: "bogus" }),
    (e) => e.status === 400,
    "bad scope rejected",
  );
  await assert.rejects(
    () => deletePin(priv.id, bob, { storage }),
    (e) => e.status === 403,
    "non-owner cannot unpin",
  );

  // --- listPins respects visibility. ---
  // alice's two pins: r1 (private) and priv (shared to bob). bob sees only priv.
  const bobList = await listPins(bob);
  assert.equal(bobList.length, 1);
  assert.equal(bobList[0].id, priv.id);
  const aliceList = await listPins(alice);
  assert.equal(aliceList.length, 2, "owner sees all own pins");
  assert.ok(aliceList[0].shareUrl.startsWith("/pin?token="));

  // --- getPinByToken routes; bad token → null. ---
  assert.equal((await getPinByToken(priv.token)).id, priv.id);
  assert.equal(await getPinByToken("not a token"), null);

  // --- Deletion refcount across shared storage keys. ---
  const r3 = await createPin(
    {
      viewer: bob,
      bytes: Buffer.from("shared bytes"),
      name: "a.txt",
      ext: ".txt",
      sourcePath: "/b/a.txt",
      sourceMachineId: "m1",
    },
    { storage, now },
  );
  const r4 = await createPin(
    {
      viewer: bob,
      bytes: Buffer.from("shared bytes"), // same content, DIFFERENT source path
      name: "a-copy.txt",
      ext: ".txt",
      sourcePath: "/b/elsewhere/a.txt",
      sourceMachineId: "m1",
    },
    { storage, now },
  );
  assert.equal(r3.pin.storageKey, r4.pin.storageKey, "same content → same key");
  assert.notEqual(r3.pin.id, r4.pin.id, "different source → different pin");

  const deletesBefore = storage.deletes.length;
  await deletePin(r3.pin.id, bob, { storage });
  assert.equal(storage.deletes.length, deletesBefore, "key still referenced → no storage delete");
  assert.equal(await getPinById(r3.pin.id), null, "record removed");
  await deletePin(r4.pin.id, bob, { storage });
  assert.equal(storage.deletes.length, deletesBefore + 1, "last reference → storage delete");

  // --- Sanitize-on-read of malformed records seeded directly into the index. ---
  const goodToken = "abcdefghijklmnopqrstuvwx";
  const goodHash = "a".repeat(64);
  await index.put({
    id: "ok",
    ownerId: "alice@x.com",
    name: "../../etc/passwd",
    sha256: goodHash,
    storageKey: "aa/" + goodHash,
    token: goodToken,
    share: { scope: "WIDE_OPEN" }, // invalid → coerced to private
    createdAt: 5,
  });
  await index.put({ id: "bad", name: "x", token: goodToken }); // missing storageKey/sha256 → dropped
  const sanitized = await getPinById("ok");
  assert.ok(sanitized, "valid record kept");
  assert.equal(sanitized.name, "passwd", "path-y name reduced to basename");
  assert.equal(sanitized.share.scope, "private", "bad scope coerced to private");
  assert.equal(await getPinById("bad"), null, "record missing required fields dropped");

  // --- Durability across a simulated restart, via the FILE index backend. ---
  // A new process re-creates a file index over the same path and re-hydrates;
  // pins (and their updated scope) must come back from disk, not vanish.
  _resetPinsCache();
  process.env.TMUX_MOBILE_PINS_CONFIG = path.join(dir, "durable.json");
  const fileIdx = createFilePinIndex();
  setPinIndex(fileIdx);
  await hydratePins();

  const blob = fakeStorage();
  const p = await createPin(
    {
      viewer: alice,
      bytes: Buffer.from("durable artifact"),
      name: "keep.txt",
      ext: ".txt",
      sourcePath: "/d/keep.txt",
      sourceMachineId: "m1",
      share: { scope: "all" },
    },
    { storage: blob, now },
  );
  assert.equal(p.persisted, true, "createPin persisted the record to the file index");
  await updateShare(p.pin.id, alice, { scope: "users", users: ["bob@x.com"] });

  // Simulate a restart: fresh index instance over the SAME file path.
  _resetPinsCache();
  const fileIdx2 = createFilePinIndex();
  setPinIndex(fileIdx2);
  await hydratePins();
  const revived = await getPinById(p.pin.id);
  assert.ok(revived, "pin survived a simulated restart (re-read from the file index)");
  assert.equal(revived.share.scope, "users", "updated scope persisted across restart");
  assert.deepEqual(revived.share.users, ["bob@x.com"]);
  assert.equal((await listPins(alice)).length, 1, "exactly the one durable pin is back");

  // Unpin persists across a restart too.
  await deletePin(p.pin.id, alice, { storage: blob });
  _resetPinsCache();
  setPinIndex(createFilePinIndex());
  await hydratePins();
  assert.equal(await getPinById(p.pin.id), null, "unpin persisted across restart");

  console.log("pins unit tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
