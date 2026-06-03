// Unit tests for per-agent turn detection (working / idle / null), grounded in
// real pane title/footer samples captured from live claude & codex windows.

import assert from "node:assert/strict";
import { detectTurn } from "../lib/turn-detection.mjs";

// --- claude: classified from the pane TITLE ---
// Working: title prefixed with a braille spinner glyph + the current task.
assert.equal(
  detectTurn("claude", { title: "⠂ Fix Node server auto-reconnect after cloud run restart" }),
  "working",
  "claude braille spinner -> working",
);
assert.equal(detectTurn("claude", { title: "⠙ Closing the 25 issues" }), "working", "claude braille 2");
// Idle: steady marker.
assert.equal(detectTurn("claude", { title: "✳ Claude Code" }), "idle", "claude steady -> idle");
assert.equal(detectTurn("claude", { title: "" }), null, "claude empty title -> unknown");

// --- codex: classified from the pane FOOTER/tail ---
assert.equal(
  detectTurn("codex", { paneTail: "gpt-5.5 xhigh · Context 52% left · ~/x · gpt-5.5 · Goal achieved (23m)" }),
  "idle",
  "codex goal-achieved footer -> idle",
);
assert.equal(
  detectTurn("codex", { paneTail: "─ Worked for 9m 18s ───\n› Use /skills to list available skills" }),
  "working",
  "codex 'Worked for' -> working",
);
assert.equal(detectTurn("codex", { paneTail: "nothing relevant here" }), null, "codex unknown");

// --- other / no agent ---
assert.equal(detectTurn("gemini", { title: "x" }), null, "gemini not implemented -> null");
assert.equal(detectTurn(null, {}), null, "no agent -> null");

console.log("turn-detection unit tests passed");
