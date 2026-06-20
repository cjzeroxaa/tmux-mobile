// Unit tests for the local artifact-storage driver (lib/artifact-storage.mjs).
// Covers: content-addressed keys, put->get round-trip, write-once idempotency,
// delete (and delete of a missing key), get of a missing key, and the local
// driver's url()/servesDirectly() contract. Uses a throwaway dir via
// TMUX_MOBILE_ARTIFACT_DIR. Cloud (gcs/s3) round-trips are intentionally not
// exercised here — they need live buckets/creds and are skipped in CI.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "tmux-mobile-artifacts-"));
process.env.TMUX_MOBILE_ARTIFACT_DIR = dir;
delete process.env.TMUX_MOBILE_ARTIFACT_STORAGE; // ensure local default

const { createArtifactStorage, createLocalArtifactStorage, contentKey, presignEnabled } =
  await import("../lib/artifact-storage.mjs");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

try {
  // presign is off by default (proxy mode), on only with the explicit flag.
  assert.equal(presignEnabled({}), false, "presign off by default");
  assert.equal(presignEnabled({ TMUX_MOBILE_ARTIFACT_PRESIGN: "1" }), true, "presign opt-in");

  // contentKey: shard prefix + full hash + sanitized extension.
  const h = sha256(Buffer.from("hello"));
  assert.equal(contentKey(h, ".png"), `${h.slice(0, 2)}/${h}.png`);
  assert.equal(contentKey(h, ""), `${h.slice(0, 2)}/${h}`);
  // A bogus extension is dropped rather than smuggled into the key.
  assert.equal(contentKey(h, "../evil"), `${h.slice(0, 2)}/${h}`);
  assert.throws(() => contentKey("not-a-hash", ".png"));

  // The default factory returns the local driver and reports it cannot serve
  // bytes directly (the serve route must stream from get()).
  const storage = await createArtifactStorage();
  assert.equal(storage.kind, "local");
  assert.equal(storage.servesDirectly(), false);
  assert.equal(await storage.url("anything"), "");

  // put -> get round-trips identical bytes.
  const bytes = Buffer.from("the quick brown fox");
  const key = contentKey(sha256(bytes), ".txt");
  const putRes = await storage.put(key, bytes, { contentType: "text/plain" });
  assert.equal(putRes.key, key);
  assert.equal(putRes.size, bytes.length);
  const got = await storage.get(key);
  assert.ok(got, "expected bytes back");
  assert.ok(got.bytes.equals(bytes), "round-tripped bytes must match");

  // Write-once idempotency: a second put of the same key does NOT rewrite the
  // file (mtime unchanged), and returns the existing size.
  const { statSync } = await import("node:fs");
  const target = path.join(dir, key);
  const mtime1 = statSync(target).mtimeMs;
  await new Promise((r) => setTimeout(r, 10));
  const putAgain = await storage.put(key, bytes, { contentType: "text/plain" });
  assert.equal(putAgain.size, bytes.length);
  assert.equal(statSync(target).mtimeMs, mtime1, "write-once: file not rewritten");

  // overwrite:true forces a rewrite of a mutable key (the pin index uses this).
  const mutableKey = "index/pins.json";
  await storage.put(mutableKey, Buffer.from("v1"), { overwrite: true });
  await storage.put(mutableKey, Buffer.from("v2-longer"), { overwrite: true });
  const reread = await storage.get(mutableKey);
  assert.equal(reread.bytes.toString(), "v2-longer", "overwrite rewrites the object");
  await storage.delete(mutableKey);

  // get of a missing key -> null.
  assert.equal(await storage.get(contentKey(sha256(Buffer.from("absent")))), null);

  // delete removes it; get is then null; delete of a missing key is a no-op.
  await storage.delete(key);
  assert.equal(await storage.get(key), null);
  await storage.delete(key); // idempotent, must not throw

  // createLocalArtifactStorage is the sync convenience factory.
  const local = createLocalArtifactStorage();
  assert.equal(local.kind, "local");

  console.log("artifact-storage unit tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
