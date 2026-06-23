import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cardStarKey } from "../public/card-stars.js";

const dir = mkdtempSync(path.join(tmpdir(), "tmux-mobile-card-stars-"));

const {
  createCardStarStore,
  createFileCardStarStore,
  createMemoryCardStarStore,
  describeUserCardStars,
  resetUserCardStars,
  sanitizeCardStarKeys,
  updateUserCardStars,
} = await import("../lib/user-card-stars.mjs");

try {
  const stableA = cardStarKey({
    machineId: "m1",
    mux: "tmux",
    sessionName: "work",
    windowIndex: 2,
    windowId: "@9",
    paneId: "%3",
  });
  const stableB = cardStarKey({
    machineId: "m1",
    mux: "tmux",
    sessionName: "work",
    windowIndex: 2,
    windowId: "@99",
    paneId: "%33",
  });
  assert.equal(stableA, stableB, "stable card star key ignores runtime window/pane ids");
  assert.notEqual(
    stableA,
    cardStarKey({ machineId: "m1", mux: "rmux", sessionName: "work", windowIndex: 2 }),
    "mux is part of the key",
  );
  assert.notEqual(
    stableA,
    cardStarKey({ machineId: "m2", mux: "tmux", sessionName: "work", windowIndex: 2 }),
    "machine is part of the key",
  );

  const fallback = cardStarKey({ machineId: "m1", mux: "tmux", windowId: "@9" });
  assert.ok(fallback.includes("live"), "missing session/index falls back to a live id");

  assert.deepEqual(sanitizeCardStarKeys(["a", "a", "", 3, "b"]), ["a", "b"]);
  assert.throws(
    () => sanitizeCardStarKeys(null, { strict: true }),
    (error) => error.status === 400,
  );

  assert.equal((await createCardStarStore({ TMUX_MOBILE_CARD_STARS_STORE: "memory" })).kind, "memory");
  await assert.rejects(
    () => createCardStarStore({ TMUX_MOBILE_CARD_STARS_STORE: "wat" }),
    /Unknown TMUX_MOBILE_CARD_STARS_STORE/,
  );

  const memory = createMemoryCardStarStore();
  assert.deepEqual((await describeUserCardStars(memory, "alice")).keys, []);
  assert.equal((await describeUserCardStars(memory, "alice")).customized, false);
  await updateUserCardStars(memory, "alice", ["k1", "k2"], { now: () => 456 });
  assert.deepEqual((await describeUserCardStars(memory, "alice")).keys, ["k1", "k2"]);
  assert.equal((await describeUserCardStars(memory, "alice")).updatedAt, 456);
  assert.deepEqual((await describeUserCardStars(memory, "bob")).keys, []);
  await updateUserCardStars(memory, "alice", []);
  assert.equal((await describeUserCardStars(memory, "alice")).customized, true);
  assert.deepEqual((await describeUserCardStars(memory, "alice")).keys, []);
  await resetUserCardStars(memory, "alice");
  assert.equal((await describeUserCardStars(memory, "alice")).customized, false);

  const cfg = path.join(dir, "card-stars.json");
  const a = createFileCardStarStore({ TMUX_MOBILE_CARD_STARS_CONFIG: cfg });
  await updateUserCardStars(a, "alice@example.com", ["from-disk"]);
  const b = createFileCardStarStore({ TMUX_MOBILE_CARD_STARS_CONFIG: cfg });
  await b.load();
  assert.deepEqual((await describeUserCardStars(b, "alice@example.com")).keys, ["from-disk"]);

  console.log("card-stars unit tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
