// Per-agent turn detection: is the agent in a window actively working, or has
// its turn ended (idle, waiting for input)? Each agent exposes the signal
// differently, so detection is per agent type and uses the best signal:
//
//   - claude: the pane TITLE (set by Claude Code via OSC). While working it is
//     prefixed with a braille spinner glyph (U+2800–U+28FF, the cycling dots)
//     and shows the current task; when idle it's a steady marker like
//     "✳ Claude Code". Title is the agent's own status line — the cleanest cue.
//
//   - codex: codex does NOT put a status glyph in its title, so use the pane
//     FOOTER text — "Worked for …" / an interrupt hint means working; the model
//     status footer ("… Goal achieved", "Context …% left") / idle "›" prompt
//     means the turn ended.
//
// Returns "working" | "idle" | null (null = not a recognized agent / unknown).
// All inputs are plain strings already stripped of ANSI by the caller.

// Braille spinner range Claude uses for its working indicator.
const BRAILLE = /[⠀-⣿]/;
// Other working glyphs Claude/various spinners use.
const SPINNER_GLYPHS = /[⠀-⣿✶✻✽✺✷✵◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

function firstNonSpace(s) {
  const t = String(s || "").trimStart();
  return t.length ? t[0] : "";
}

// Claude: classify from pane title.
function detectClaudeTurn({ title }) {
  const t = String(title || "").trim();
  if (!t) return null;
  // A leading braille/spinner glyph = actively working (title shows the task).
  if (BRAILLE.test(firstNonSpace(t)) || SPINNER_GLYPHS.test(firstNonSpace(t))) {
    return "working";
  }
  // Steady "✳ Claude Code" (or any non-spinner Claude title) = idle / turn ended.
  if (/claude/i.test(t) || t.startsWith("✳")) return "idle";
  // Title doesn't look like Claude's; fall back to unknown.
  return null;
}

// Codex: classify from the pane footer/tail text.
function detectCodexTurn({ paneTail }) {
  const text = String(paneTail || "");
  if (!text) return null;
  // Working: codex shows a live "Worked for <time>" header / interrupt hint while
  // streaming, before it settles.
  if (/\bWorked for\b|Esc to interrupt|esc to interrupt|Thinking|Working\b/.test(text)) {
    return "working";
  }
  // Idle/turn-ended cues: the settled status footer or the empty input prompt.
  if (/Goal achieved|Context\s+\d+%\s+left|⏎ send|To exit|\n›\s|^›\s/m.test(text)) {
    return "idle";
  }
  return null;
}

// Dispatch by agent type. `signals` = { title, paneTail }.
export function detectTurn(agentType, signals = {}) {
  if (agentType === "claude") return detectClaudeTurn(signals);
  if (agentType === "codex") return detectCodexTurn(signals);
  // gemini and others: not implemented yet (returns null = unknown).
  return null;
}
