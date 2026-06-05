// Unit tests for per-agent turn detection, grounded in real pane title/footer
// samples captured from live claude & codex windows.
//
// Detection now returns a { state, confidence } pair (HONEST STATE, Wave 1):
// state ∈ working|idle|unverified, confidence ∈ high|low. The invariants under
// test: confident states only on recognized signals; everything ambiguous or
// unreadable becomes a VISIBLE "unverified" (never a silent drop, never a
// false "idle").

import assert from "node:assert/strict";
import { detectTurn } from "../lib/turn-detection.mjs";

// --- claude: classified from the pane TITLE ---
// Working: title prefixed with a braille spinner glyph + the current task.
assert.deepEqual(
  detectTurn("claude", { title: "⠂ Fix Node server auto-reconnect after cloud run restart" }),
  { state: "working", confidence: "high" },
  "claude braille spinner -> working/high",
);
assert.deepEqual(
  detectTurn("claude", { title: "⠙ Closing the 25 issues" }),
  { state: "working", confidence: "high" },
  "claude braille 2 -> working/high",
);
// Idle: steady marker.
assert.deepEqual(
  detectTurn("claude", { title: "✳ Claude Code" }),
  { state: "idle", confidence: "high" },
  "claude steady -> idle/high",
);

// Unverified, NOT idle: a Claude window whose title we can't read. The dangerous
// case the old code returned null for — it might be blocked on a question.
assert.deepEqual(
  detectTurn("claude", { title: "" }),
  { state: "unverified", confidence: "low" },
  "claude empty title -> unverified (not idle, not dropped)",
);
assert.deepEqual(
  detectTurn("claude", { title: "some unrelated process title" }),
  { state: "unverified", confidence: "low" },
  "claude unrecognized title -> unverified",
);

// --- codex: classified from the pane FOOTER/tail ---
assert.deepEqual(
  detectTurn("codex", { paneTail: "gpt-5.5 xhigh · Context 52% left · ~/x · gpt-5.5 · Goal achieved (23m)" }),
  { state: "idle", confidence: "high" },
  "codex goal-achieved footer -> idle/high",
);
assert.deepEqual(
  detectTurn("codex", { paneTail: "─ Worked for 9m 18s ───\n› Use /skills to list available skills" }),
  { state: "working", confidence: "high" },
  "codex 'Worked for' -> working/high",
);
// Footer present but unrecognized, and no footer at all: both unverified.
assert.deepEqual(
  detectTurn("codex", { paneTail: "nothing relevant here" }),
  { state: "unverified", confidence: "low" },
  "codex unrecognized footer -> unverified",
);
assert.deepEqual(
  detectTurn("codex", { paneTail: "" }),
  { state: "unverified", confidence: "low" },
  "codex no footer -> unverified",
);

// --- other / no agent ---
// A recognized-agent window of an unsupported type stays VISIBLE as unverified,
// never null — gemini must not silently vanish from the attention queue.
assert.deepEqual(
  detectTurn("gemini", { title: "x" }),
  { state: "unverified", confidence: "low" },
  "gemini (unimplemented) -> unverified, never dropped",
);
// No agent in the window at all: null (nothing to show a turn for).
assert.equal(detectTurn(null, {}), null, "no agent -> null");
assert.equal(detectTurn("", {}), null, "empty agent -> null");

// --- INVARIANT: an unrecognized agent never yields a CONFIDENT state ---
for (const at of ["gemini", "aider", "mystery"]) {
  for (const sig of [{}, { title: "✳ Claude Code" }, { paneTail: "Goal achieved" }]) {
    const r = detectTurn(at, sig);
    assert.equal(r.state, "unverified", `unrecognized agent ${at} -> unverified`);
    assert.equal(r.confidence, "low", `unrecognized agent ${at} -> low confidence`);
  }
}

// --- INVARIANT: unverified is ALWAYS low confidence (never high) ---
const samples = [
  detectTurn("claude", { title: "" }),
  detectTurn("codex", { paneTail: "" }),
  detectTurn("gemini", {}),
];
for (const r of samples) {
  if (r && r.state === "unverified") {
    assert.equal(r.confidence, "low", "unverified must be low confidence");
  }
}

console.log("turn-detection unit tests passed");
