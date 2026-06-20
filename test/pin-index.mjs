// Unit tests for the pluggable PinIndex backends (lib/pin-index.mjs). Covers the
// memory and file drivers: get/put/all/delete round-trips, upsert semantics,
// idempotent delete, and — for the file driver — durability across a fresh
// instance over the same path (the "restart" case). The firestore driver needs a
// live database and is exercised separately during deploy verification, not here.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "tmux-mobile-pinindex-"));

const { createPinIndex, createMemoryPinIndex, createFilePinIndex } = await import(
  "../lib/pin-index.mjs"
);

function rec(id, extra = {}) {
  return { id, name: `${id}.txt`, ...extra };
}

async function exercise(index, label) {
  await index.load();
  assert.deepEqual(await index.all(), [], `${label}: starts empty`);
  assert.equal(await index.get("nope"), null, `${label}: missing → null`);

  await index.put(rec("a", { scope: "private" }));
  await index.put(rec("b"));
  assert.equal((await index.all()).length, 2, `${label}: two records`);
  assert.equal((await index.get("a")).scope, "private", `${label}: get returns record`);

  // put is an upsert by id.
  await index.put(rec("a", { scope: "all" }));
  assert.equal((await index.all()).length, 2, `${label}: upsert doesn't add`);
  assert.equal((await index.get("a")).scope, "all", `${label}: upsert overwrites`);

  // delete is idempotent.
  await index.delete("a");
  assert.equal(await index.get("a"), null, `${label}: deleted → null`);
  assert.equal((await index.all()).length, 1, `${label}: one left`);
  await index.delete("a"); // must not throw
}

try {
  // --- factory selection ---
  delete process.env.TMUX_MOBILE_PIN_INDEX;
  assert.equal((await createPinIndex()).kind, "memory", "default is memory");
  assert.equal((await createPinIndex({ TMUX_MOBILE_PIN_INDEX: "file", TMUX_MOBILE_PINS_CONFIG: path.join(dir, "f.json") })).kind, "file");
  await assert.rejects(() => createPinIndex({ TMUX_MOBILE_PIN_INDEX: "wat" }), /Unknown TMUX_MOBILE_PIN_INDEX/);

  // --- memory driver ---
  await exercise(createMemoryPinIndex(), "memory");

  // --- file driver ---
  const filePath = path.join(dir, "pins.json");
  await exercise(createFilePinIndex({ TMUX_MOBILE_PINS_CONFIG: filePath }), "file");

  // --- file driver durability: a fresh instance over the same path re-reads. ---
  const a = createFilePinIndex({ TMUX_MOBILE_PINS_CONFIG: path.join(dir, "durable.json") });
  await a.put(rec("keep", { scope: "users" }));
  const b = createFilePinIndex({ TMUX_MOBILE_PINS_CONFIG: path.join(dir, "durable.json") });
  await b.load();
  const got = await b.get("keep");
  assert.ok(got, "file index: record survives a fresh instance (restart)");
  assert.equal(got.scope, "users");

  console.log("pin-index unit tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
