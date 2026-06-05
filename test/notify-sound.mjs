// Unit tests for the attention-chime decision logic (pure shouldChime). Covers
// the contract the user asked for: chime on a NEW waiting/question notification,
// at most once every 10s, suppressed when disabled, and never for unverified.

import assert from "node:assert/strict";
import { shouldChime, NOTIFY_SOUNDS, DEFAULT_NOTIFY_SOUND } from "../public/notify-sound.js";

const OPTS = (over = {}) => ({ enabled: true, now: 0, minIntervalMs: 10000, ...over });
const fresh = () => ({ keys: new Set(), lastAt: null });
const item = (key, reason) => ({ key, reason });

// --- rising edge fires --------------------------------------------------------
{
  const r = shouldChime(fresh(), [item("m/s/1", "question")], OPTS({ now: 1000 }));
  assert.equal(r.chime, true, "new question -> chime");
  assert.equal(r.lastAt, 1000, "lastAt advances on chime");
  assert.ok(r.keys.has("m/s/1::question"), "key recorded");
}

// --- a HELD waiting window does NOT re-chime next tick -------------------------
{
  let st = shouldChime(fresh(), [item("w", "question")], OPTS({ now: 1000 }));
  assert.equal(st.chime, true, "first appearance chimes");
  // same window still waiting, well past the rate-limit window
  const r2 = shouldChime(st, [item("w", "question")], OPTS({ now: 1000 + 60000 }));
  assert.equal(r2.chime, false, "still-waiting (no new edge) does NOT re-chime");
}

// --- rate limit: a NEW window within 10s is suppressed ------------------------
{
  let st = shouldChime(fresh(), [item("a", "question")], OPTS({ now: 1000 }));
  assert.equal(st.chime, true);
  assert.equal(st.lastAt, 1000, "lastAt set on first chime");
  const r2 = shouldChime(st, [item("a", "question"), item("b", "finished")], OPTS({ now: 5000 }));
  assert.equal(r2.chime, false, "new edge within 10s -> suppressed by rate limit");
  assert.equal(r2.lastAt, 1000, "lastAt unchanged when suppressed");
  // ...but once 10s passes, a still-present new edge chimes
  const r3 = shouldChime(r2, [item("a", "question"), item("c", "finished")], OPTS({ now: 11000 }));
  assert.equal(r3.chime, true, "new edge after 10s -> chimes");
}

// --- disabled suppresses entirely --------------------------------------------
{
  const r = shouldChime(fresh(), [item("x", "question")], OPTS({ now: 1000, enabled: false }));
  assert.equal(r.chime, false, "disabled -> no chime");
  // but edge state still advances so re-enabling doesn't immediately fire on a held window
  assert.ok(r.keys.has("x::question"), "edge state tracked even when disabled");
}

// --- unverified never chimes --------------------------------------------------
{
  const r = shouldChime(fresh(), [item("u", "unverified")], OPTS({ now: 1000 }));
  assert.equal(r.chime, false, "unverified hedge -> never chime");
  assert.equal(r.keys.size, 0, "unverified not even tracked as an edge");
}

// --- escalation finished -> question is a NEW edge ---------------------------
{
  let st = shouldChime(fresh(), [item("e", "finished")], OPTS({ now: 0 }));
  assert.equal(st.chime, true, "finished appears -> chime");
  // same window now blocks on a question: distinct reason = new edge (after rate window)
  const r2 = shouldChime(st, [item("e", "question")], OPTS({ now: 11000 }));
  assert.equal(r2.chime, true, "finished -> question escalation re-chimes");
}

// --- empty set: no chime, state clears ---------------------------------------
{
  let st = shouldChime(fresh(), [item("z", "question")], OPTS({ now: 0 }));
  const r2 = shouldChime(st, [], OPTS({ now: 11000 }));
  assert.equal(r2.chime, false, "nothing pending -> no chime");
  assert.equal(r2.keys.size, 0, "edge set cleared so the window can chime again later");
  // window returns -> it's a fresh edge again
  const r3 = shouldChime(r2, [item("z", "question")], OPTS({ now: 22000 }));
  assert.equal(r3.chime, true, "window returning after clearing -> chimes again");
}

// --- sound catalog sanity -----------------------------------------------------
assert.ok(NOTIFY_SOUNDS.some((s) => s.id === DEFAULT_NOTIFY_SOUND), "default is in the catalog");
assert.deepEqual(
  NOTIFY_SOUNDS.map((s) => s.id),
  ["ding", "wolf", "frog", "train"],
  "expected sound ids (incl. wolf/frog/train)",
);

console.log("notify-sound.mjs: all assertions passed");
