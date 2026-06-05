// Fixture-driven detection tests grounded in REAL tmux pane captures (taken with
// `tmux capture-pane -p`, so ANSI is already stripped — the same text the server
// feeds detection after cleanTerminalText). These guard the honest-state contract
// against the actual grammar Claude/Codex render, not synthetic strings.
//
// Detection reliability is a definition-of-done prerequisite for the triage
// redesign (docs/PRODUCT_CONTEXT.md → "Honest state language"): the queue must
// never show false confidence on real output. Add new fixtures as you encounter
// states the detector gets wrong — this corpus is meant to grow.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectTurn } from "../lib/turn-detection.mjs";
import { detectAskQuestion } from "../lib/ask-question.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");

// --- claude, idle, no prompt -------------------------------------------------
// A real idle Claude window: the empty "❯" composer + the footer chrome. The
// pane BODY must not register as a live prompt at any confidence (no checkbox tab
// bar, no cursor-bearing numbered option — only the empty composer prompt). Turn
// itself comes from the OSC title (not in the body), asserted in turn-detection.
{
  const screen = fixture("claude-idle.txt");
  assert.deepEqual(
    detectAskQuestion(screen),
    { waiting: false, confidence: "high" },
    "fixture claude-idle: body is confidently NOT a prompt",
  );
  // The matching title for this capture is the steady marker.
  assert.deepEqual(
    detectTurn("claude", { title: "✳ Claude Code" }),
    { state: "idle", confidence: "high" },
    "fixture claude-idle: steady title -> idle/high",
  );
}

// --- codex, idle -------------------------------------------------------------
// Codex's settled footer ("Goal achieved", "Context NN% left") lives in the pane
// body, so turn is detectable from the captured tail directly.
{
  const screen = fixture("codex-idle.txt");
  const tail = screen.split("\n").slice(-12).join("\n");
  assert.deepEqual(
    detectTurn("codex", { paneTail: tail }),
    { state: "idle", confidence: "high" },
    "fixture codex-idle: settled footer -> idle/high",
  );
  // And the idle codex screen is not a prompt.
  assert.deepEqual(
    detectAskQuestion(screen),
    { waiting: false, confidence: "high" },
    "fixture codex-idle: not a prompt",
  );
}

// --- codex, blocked on an approval prompt (real capture) ---------------------
// Codex's approval prompt was a false NEGATIVE (read as idle/finished) until the
// attention-watch shadow run surfaced it. Now: a confident waiting, and turn must
// not read as a calm idle.
{
  const screen = fixture("codex-approval-prompt.txt");
  assert.deepEqual(
    detectAskQuestion(screen),
    { waiting: true, confidence: "high" },
    "fixture codex-approval: waiting/high (was a false negative)",
  );
  const tail = screen.split("\n").slice(-12).join("\n");
  assert.notEqual(
    detectTurn("codex", { paneTail: tail }).state,
    "idle",
    "fixture codex-approval: turn is NOT idle while blocked",
  );
}

// --- codex, idle with a persistent "Worked for" summary (real capture) -------
// "Worked for <time>" persists in the footer after a turn ends, so this settled
// pane must read idle, NOT working (the bug the shadow run corrected).
{
  const screen = fixture("codex-idle-worked-for.txt");
  const tail = screen.split("\n").slice(-12).join("\n");
  assert.deepEqual(
    detectTurn("codex", { paneTail: tail }),
    { state: "idle", confidence: "high" },
    "fixture codex-idle-worked-for: persistent 'Worked for' -> idle/high",
  );
  assert.deepEqual(
    detectAskQuestion(screen),
    { waiting: false, confidence: "high" },
    "fixture codex-idle-worked-for: not a prompt",
  );
}

console.log("detection-fixtures: all assertions passed");
