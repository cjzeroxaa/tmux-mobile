// Unit tests for per-agent mode/effort/model parsing. The fixture strings are
// copied verbatim from live captures (claude 2.1.162, codex-cli 0.136.0) so the
// parser is pinned to real footer text, not assumptions.

import assert from "node:assert/strict";
import { detectAgentMode, AGENT_MODES } from "../lib/agent-mode.mjs";

// ── Claude mode line variants (the four cycle states) ──
const claudeFooter = (modeLine) =>
  `❯ Try "how do I log an error?"\n` +
  `  /tmp/x  Opus 4.8 (1M context)                ● high · /effort\n` +
  `  ${modeLine}`;

let r = detectAgentMode("claude", {
  paneTail: claudeFooter("⏸ plan mode on (shift+tab to cycle) · ← for agents"),
});
assert.equal(r.mode, "plan", "claude plan mode");
assert.equal(r.label, "Plan", "claude plan label");
assert.equal(r.effort, "high", "claude effort parsed");
assert.equal(r.model, "Opus 4.8 (1M context)", "claude model parsed");

r = detectAgentMode("claude", {
  paneTail: claudeFooter("⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"),
});
assert.equal(r.mode, "acceptEdits", "claude accept edits");
assert.equal(r.label, "Accept edits", "claude accept-edits label");

r = detectAgentMode("claude", {
  paneTail: claudeFooter("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"),
});
assert.equal(r.mode, "bypass", "claude bypass mode");

r = detectAgentMode("claude", {
  paneTail: claudeFooter("⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"),
});
assert.equal(r.mode, "auto", "claude auto mode");

// Default/normal: no "<x> on" line, but a Claude title present.
r = detectAgentMode("claude", { title: "✳ Claude Code", paneTail: "  /tmp/x  Sonnet 4.6   ● medium · /effort" });
assert.equal(r.mode, "normal", "claude normal mode fallback");
assert.equal(r.effort, "medium", "claude effort medium");
assert.equal(r.model, "Sonnet 4.6", "claude sonnet model");

// The effort glyph varies by level/state — all must parse to the same field.
assert.equal(
  detectAgentMode("claude", { paneTail: "Opus 4.8 (1M context)  ○ low · /effort" }).effort,
  "low",
  "effort hollow ○",
);
assert.equal(
  detectAgentMode("claude", { paneTail: "Opus 4.8 (1M context)  ◉ xhigh · /effort" }).effort,
  "xhigh",
  "effort target ◉ (xhigh)",
);
// max/ultracode render on a separate ✦ line, not the "· /effort" form.
assert.equal(
  detectAgentMode("claude", {
    paneTail: "Opus 4.8 (1M context)\n  ✦ ultracode · xhigh effort + dynamic workflows",
  }).effort,
  "ultracode",
  "effort ✦ ultracode line",
);

// ── Codex footer variants ──
r = detectAgentMode("codex", {
  paneTail:
    "  gpt-5.5 high · Context 100% left · /tmp/x · gpt-5.5 Plan mode (shift+tab to cycle)",
});
assert.equal(r.mode, "plan", "codex plan mode");
assert.equal(r.label, "Plan", "codex plan label");
assert.equal(r.model, "gpt-5.5", "codex model");
assert.equal(r.effort, "high", "codex effort");

r = detectAgentMode("codex", {
  paneTail: "  gpt-5.5 xhigh · Context 100% left · /tmp/x · gpt-5.5",
});
assert.equal(r.mode, "fullAccess", "codex no-suffix => full access");
assert.equal(r.effort, "xhigh", "codex xhigh effort");

// ── Unknown agent / empty ──
r = detectAgentMode("gemini", { paneTail: "whatever" });
assert.equal(r.mode, null, "unknown agent => null mode");
r = detectAgentMode("claude", { paneTail: "" });
assert.equal(r.mode, null, "empty pane => null mode");

// ── Binding table sanity ──
assert.equal(AGENT_MODES.claude.cycleKey, "BTab", "claude cycle key");
assert.equal(AGENT_MODES.codex.cycleKey, "BTab", "codex cycle key (same chord)");
assert.deepEqual(
  AGENT_MODES.claude.effort.levels,
  ["low", "medium", "high", "xhigh", "max", "ultracode"],
  "claude effort slider levels in order",
);

console.log("agent-mode unit tests passed");
