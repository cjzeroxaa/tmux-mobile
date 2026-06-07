// Per-agent mode + effort/model detection, and the per-agent binding table.
//
// Companion to turn-detection.mjs. Where that answers "is the agent working?",
// this answers "what permission MODE is it in, and (Claude) at what effort /
// model?" — by parsing the agent's own footer text, which both Claude Code and
// Codex render live. We parse rather than track optimistically so the UI shows
// the REAL state even if the user cycled the mode by typing in the pane.
//
// Both Claude AND Codex cycle modes with Shift+Tab (tmux key name `BTab`) —
// verified live (claude 2.1.162, codex-cli 0.136.0). The cycle KEY is therefore
// shared; only the mode LABELS differ per agent, so each agent's recognizer is
// separate. All inputs are plain strings already stripped of ANSI by the caller.

// ── Per-agent bindings ──────────────────────────────────────────────────────
// One declarative table so adding an agent / fixing a chord is a one-line edit
// (mirrors WINDOW_METADATA + turn-detection extensibility).
export const AGENT_MODES = {
  claude: {
    cycleKey: "BTab", // Shift+Tab cycles permission modes
    // The Shift+Tab ring MEMBERSHIP depends on launch flags (e.g. a session
    // started with --dangerously-skip-permissions includes "bypass"), and the
    // order is fixed by Claude, not us. Verified ring (one launch):
    //   acceptEdits → plan → bypass → auto → normal → (loops)
    // We do NOT rely on this order to jump modes — setAgentMode cycles one step
    // and re-reads the REAL mode until it matches, so it's correct for whatever
    // ring the running session actually has. This list is informational + the
    // set of modes the UI may offer.
    modes: ["normal", "auto", "acceptEdits", "plan", "bypass"],
    // Effort is a model/session setting driven via the in-TUI /effort slider
    // (NOT prompt text). Levels are a horizontal slider: ←/→ to move, Enter to
    // confirm. Order matters — index distance = number of arrow presses.
    effort: {
      command: "/effort",
      levels: ["low", "medium", "high", "xhigh", "max", "ultracode"],
    },
    modelCommand: "/model",
  },
  codex: {
    cycleKey: "BTab", // Codex also cycles with Shift+Tab
    // Codex couples mode↔effort and exposes model via /model; effort-only
    // control is a fast-follow, so no slider wired in v1.
    effort: null,
    modelCommand: "/model",
  },
};

// ── Claude ──────────────────────────────────────────────────────────────────
// Footer mode line, e.g.:
//   "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
//   "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
//   "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"
//   "⏸ plan mode on (shift+tab to cycle) · ← for agents"   (plan uses ⏸)
// Effort + model line, e.g.:
//   "<cwd>  Opus 4.8 (1M context)        ● high · /effort"
const CLAUDE_MODE_PATTERNS = [
  { re: /plan mode on/i, mode: "plan", label: "Plan" },
  { re: /accept edits on/i, mode: "acceptEdits", label: "Accept edits" },
  { re: /bypass permissions on/i, mode: "bypass", label: "Bypass" },
  { re: /auto mode on/i, mode: "auto", label: "Auto" },
];

function detectClaudeMode(text) {
  const out = { mode: null, label: "", effort: null, model: null };
  for (const p of CLAUDE_MODE_PATTERNS) {
    if (p.re.test(text)) {
      out.mode = p.mode;
      out.label = p.label;
      break;
    }
  }
  // No "<x> on" line means the default mode (no bang-bang prefix in the footer).
  if (!out.mode && /claude/i.test(text)) {
    out.mode = "normal";
    out.label = "Normal";
  }
  // Effort: the footer marks the current level next to "/effort" — but the GLYPH
  // varies by level/state (observed: ○ hollow, ● filled, ◉ target for xhigh) and
  // max/ultracode render on a separate "✦ <level> …" line instead. Match either
  // shape; tolerate the marker being absent entirely at narrow widths.
  const LV = "low|medium|high|xhigh|max|ultracode";
  const effort =
    text.match(new RegExp(`[●○◉◎]\\s*(${LV})\\b[^\\n]*\\/effort`, "i")) ||
    text.match(new RegExp(`✦\\s*(${LV})\\b`, "i"));
  if (effort) out.effort = effort[1].toLowerCase();
  // Model: a "Opus 4.8" / "Sonnet 4.6" style token near the cwd/effort line.
  const model = text.match(/\b(Opus|Sonnet|Haiku)\s+[\d.]+(?:\s*\(1M[^)]*\))?/i);
  if (model) out.model = model[0].replace(/\s+/g, " ").trim();
  return out;
}

// ── Codex ─────────────────────────────────────────────────────────────────
// Footer, e.g.:
//   "gpt-5.5 high · Context 100% left · <cwd> · gpt-5.5 Plan mode (shift+tab to cycle)"
//   "gpt-5.5 xhigh · Context 100% left · <cwd> · gpt-5.5"        (no suffix = full access)
const CODEX_MODE_PATTERNS = [
  { re: /\bPlan mode\b/i, mode: "plan", label: "Plan" },
  { re: /\bRead[- ]only\b/i, mode: "readOnly", label: "Read-only" },
  { re: /\bAuto\b\s*(mode)?/i, mode: "auto", label: "Auto" },
  { re: /\bFull access\b/i, mode: "fullAccess", label: "Full access" },
];

function detectCodexMode(text) {
  const out = { mode: null, label: "", effort: null, model: null };
  for (const p of CODEX_MODE_PATTERNS) {
    if (p.re.test(text)) {
      out.mode = p.mode;
      out.label = p.label;
      break;
    }
  }
  // The footer always shows "<model> <effort> ·" — grab both.
  const m = text.match(
    /\b(gpt[\w.-]+)\s+(low|medium|high|xhigh|max|minimal)\b/i,
  );
  if (m) {
    out.model = m[1];
    out.effort = m[2].toLowerCase();
  }
  // No explicit mode word with a model present = full-access / YOLO default.
  if (!out.mode && out.model) {
    out.mode = "fullAccess";
    out.label = "Full access";
  }
  return out;
}

// Dispatch by agent type. `signals` = { title, paneTail } (same shape as
// detectTurn). Returns { mode, label, effort, model } — fields are null/""
// when not detected. Returns all-null for unrecognized agents.
export function detectAgentMode(agentType, signals = {}) {
  const text = `${signals.title || ""}\n${signals.paneTail || ""}`;
  if (agentType === "claude") return detectClaudeMode(text);
  if (agentType === "codex") return detectCodexMode(text);
  return { mode: null, label: "", effort: null, model: null };
}
