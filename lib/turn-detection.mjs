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
// HONEST STATE (Wave 1). Detection returns a { state, confidence } pair:
//
//   state      = "working" | "idle" | "unverified"
//   confidence = "high" | "low"
//
// The cardinal rule (see docs/PRODUCT_CONTEXT.md → "Honest state language"): we
// never show false confidence. When the signal is missing or unrecognized — an
// agent we know is running but whose status line we cannot read — we return
// "unverified" (visible, ranked below confirmed items) rather than guessing
// "idle" or dropping the window. "unverified" is ALWAYS low confidence.
//
// All inputs are plain strings already stripped of ANSI by the caller.

// Braille spinner range Claude uses for its working indicator.
const BRAILLE = /[⠀-⣿]/;
// Other working glyphs Claude/various spinners use.
const SPINNER_GLYPHS = /[⠀-⣿✶✻✽✺✷✵◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

const HIGH = "high";
const LOW = "low";

function firstNonSpace(s) {
  const t = String(s || "").trimStart();
  return t.length ? t[0] : "";
}

function working(confidence = HIGH) {
  return { state: "working", confidence };
}
function idle(confidence = HIGH) {
  return { state: "idle", confidence };
}
// Unverified is, by definition, the absence of a confident read — always low.
function unverified() {
  return { state: "unverified", confidence: LOW };
}

// Claude: classify from pane title.
function detectClaudeTurn({ title }) {
  const t = String(title || "").trim();
  // No title at all for a window we believe is Claude: we cannot read the status
  // line. Do NOT assume idle — it might be blocked on a question. Unverified.
  if (!t) return unverified();
  // A leading braille/spinner glyph = actively working (title shows the task).
  if (BRAILLE.test(firstNonSpace(t)) || SPINNER_GLYPHS.test(firstNonSpace(t))) {
    return working();
  }
  // Steady "✳ Claude Code" (or any non-spinner Claude title) = idle / turn ended.
  if (/claude/i.test(t) || t.startsWith("✳")) return idle();
  // Title doesn't look like Claude's — a recognized agent with an unrecognized
  // status line. Surface it as unverified rather than silently dropping it.
  return unverified();
}

// Codex: classify from the pane footer/tail text.
function detectCodexTurn({ paneTail }) {
  const text = String(paneTail || "");
  // No footer captured for a window we believe is codex: unknown, not idle.
  if (!text.trim()) return unverified();
  // BLOCKED ON APPROVAL takes precedence over the idle cue below: codex's approval
  // prompt renders `› 1. Yes, proceed` (a `›`-cursor option) which would otherwise
  // match the idle "^›\s" rule, hiding a blocked agent. The confirm footer is the
  // unambiguous marker that the turn has NOT ended — it's waiting on the user. We
  // return working() (not idle) so even if the ask-detector were bypassed, the
  // turn never reads as a calm "finished". (waitingForInput is the real signal;
  // this just keeps turn honest.) See docs/DETECTION.md (codex prompt FN).
  if (/Press enter to confirm/i.test(text) && /^\s*›\s*\d+\.\s+\S/m.test(text)) {
    return working();
  }
  // Working: LIVE streaming cues only. NB: "Worked for <time>" is PAST-tense — it
  // stays in the footer AFTER a turn completes (it's a duration summary), so it is
  // NOT a working signal on its own (treating it as one misread a settled idle
  // pane as working — caught by the attention-watch shadow run). The live cues are
  // the interrupt hint and the active "Working (…)" / "Thinking" status.
  if (/Esc to interrupt|esc to interrupt|\bThinking\b|Working\s*\(/.test(text)) {
    return working();
  }
  // Idle/turn-ended cues: the settled status footer, the completed-work summary,
  // or the empty input prompt.
  if (/Goal achieved|Context\s+\d+%\s+left|\bWorked for\b|⏎ send|To exit|\n›\s|^›\s/m.test(text)) {
    return idle();
  }
  // Footer present but matches no known pattern (a codex variant / mid-redraw):
  // unverified, never a confident guess.
  return unverified();
}

// Dispatch by agent type. `signals` = { title, paneTail }.
//
// Returns a { state, confidence } object. For an unrecognized agent type that
// nonetheless has a detected agent (e.g. gemini, not yet implemented), we still
// return "unverified" so the window stays VISIBLE and honestly labeled rather
// than vanishing from the attention queue. Pass agentType=null/"" only for
// windows with no detected agent at all.
export function detectTurn(agentType, signals = {}) {
  if (agentType === "claude") return detectClaudeTurn(signals);
  if (agentType === "codex") return detectCodexTurn(signals);
  // A recognized-agent window of an unsupported type (gemini, …): unverified.
  if (agentType) return unverified();
  // No agent in the window at all.
  return null;
}
