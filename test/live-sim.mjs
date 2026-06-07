// LIVE simulation harness (manual / not in npm test — it spins up real tmux).
//
// Drives a scratch tmux session into the Claude/Codex interaction states the
// detector must handle, using the SAME tmux mechanisms the real agents use:
//   - Claude turn: the OSC 2 pane title (\033]2;<title>\007), read via pane_title.
//   - Codex turn: footer text printed into the pane body, read via capture-pane.
//   - AskUserQuestion: the prompt chrome (tab bar / cursor / footer) in the body.
//   - copy-mode: real `tmux copy-mode` so pane_mode is non-empty.
// Then runs the ACTUAL detection functions (detectTurn / detectAskQuestion) plus
// isScrollbackMode against the live capture, and prints PASS/FAIL per case.
//
// Run: node test/live-sim.mjs   (requires tmux; cleans up its own session)

import { execFileSync } from "node:child_process";
import { detectTurn } from "../lib/turn-detection.mjs";
import { detectAskQuestion } from "../lib/ask-question.mjs";
import { isScrollbackMode } from "../lib/pane-mode.mjs";

const SESSION = `detsim-${process.pid}`;
const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
// Reliable synchronous sleep (execFileSync('sleep') raced; Atomics.wait blocks
// the thread deterministically).
const _sab = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(_sab, 0, 0, ms);

// Send a literal string to a pane WITHOUT tmux interpreting key names, then a
// real Enter. (send-keys -l does NOT interpret "\n" — multi-line input must be
// sent one line at a time, each followed by Enter.)
function sendLine(target, text) {
  tmux("send-keys", "-t", target, "-l", text);
  tmux("send-keys", "-t", target, "Enter");
}
// Set the pane title exactly as a program would, via the OSC 2 escape. We print
// it through the shell so tmux captures it into pane_title, then POLL until the
// title actually lands (send-keys is async; reading too soon races the redraw).
// Set the pane title AND hold it: a bare `printf` exits immediately, after which
// tmux re-derives pane_title from the idle shell (resetting it to ""). A real
// agent is a long-running foreground process that keeps its title set, so we
// reproduce that by setting the OSC then blocking in the foreground (sleep). The
// caller must endRender() to release it before the next case.
function setTitle(target, title) {
  sendLine(target, `{ printf '\\033]2;${title}\\007'; sleep 30; }`);
  const ok = waitFor(() => tmux("list-panes", "-t", target, "-F", "#{pane_title}").replace(/\n$/, "") === title, 2000);
  if (!ok) throw new Error(`setTitle timeout: "${title}" never landed`);
}

// Poll a predicate until true or timeout (ms). Returns whether it became true.
function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (pred()) return true;
    } catch {
      /* keep polling */
    }
    sleep(40);
  }
  return false;
}
function clearPane(target) {
  sendLine(target, "clear");
  sleep(120);
}

// Render a multi-line block into the pane body by echoing each line into the
// shell (printf %s\n keeps the text verbatim, including leading spaces and
// unicode), then poll until a sentinel substring appears in the capture. This is
// exactly the byte stream the real agents put on screen; the server reads it back
// the same way (capture-pane -p).
function renderBody(target, lines, sentinel) {
  // Print all lines then BLOCK (sleep) in the foreground so the shell prompt does
  // NOT return below the text. This reproduces a real agent TUI, whose footer is
  // pinned at the very bottom of the pane with nothing under it — the condition
  // the server's tail-slice (last 12 lines) relies on. A trailing shell prompt
  // would push the footer out of that window (a sim artifact, not a real state).
  clearPane(target);
  const printfs = lines
    .map((l) => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}'`)
    .join("; ");
  sendLine(target, `{ ${printfs}; sleep 30; }`);
  if (!waitFor(() => tmux("capture-pane", "-p", "-t", target).includes(sentinel), 2000)) {
    throw new Error(`render timeout: sentinel "${sentinel}" never appeared`);
  }
}

// Stop the blocking renderBody (Ctrl-C the foreground sleep) so the next case
// starts from a clean shell prompt.
function endRender(target) {
  tmux("send-keys", "-t", target, "C-c");
  sleep(120);
}

// The codex tail the server reads: the last 12 lines. We first drop trailing
// blank rows because a real codex pane pins its footer to the BOTTOM row with no
// blanks under it, whereas our echo-into-a-shell leaves the cursor below the text
// (blank rows beneath). Dropping trailing blanks reproduces the real bottom-row
// footer that the server's slice(-12) actually lands on.
function codexTail(body) {
  const lines = body.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-12).join("\n");
}

// Read what the server reads: { title, mode, body }. Read each field on its OWN
// line (not one tab-joined line) — pane_mode is empty when not in a pager, and a
// tab-joined line with an empty leading field gets mangled by trim()/split. The
// real server avoids this by anchoring its format with non-empty pane_id first;
// here we just query the fields separately.
function readPane(target) {
  const mode = tmux("list-panes", "-t", target, "-F", "#{pane_mode}").replace(/\n$/, "");
  const title = tmux("list-panes", "-t", target, "-F", "#{pane_title}").replace(/\n$/, "");
  const body = tmux("capture-pane", "-p", "-t", target);
  return { mode, title, body };
}

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}\n      got ${JSON.stringify(actual)}` +
      (ok ? "" : `\n      exp ${JSON.stringify(expected)}`),
  );
}

function cleanup() {
  try {
    // stdio ignored so the "can't find session" line (when none exists yet)
    // doesn't print to the console.
    execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

try {
  cleanup();
  // Short pane height: the server reads the LAST 12 lines for codex turn, so the
  // footer must be within the bottom of the pane. A 14-row pane means rendered
  // content naturally fills the tail window instead of sitting far above it.
  tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "14");
  const T = `${SESSION}:0`;
  sleep(400); // let the shell come up
  // Quiet the prompt + disable the shell's own title-setting so it can't fight
  // the OSC titles we set in the Claude cases.
  sendLine(T, "PROMPT_COMMAND=''; PS1='$ '");
  sendLine(T, "clear");
  sleep(300);

  // === CASE 1: Claude working — braille-spinner title =======================
  setTitle(T, "⠙ Refactor the parser");
  sleep(250);
  {
    const p = readPane(T);
    check("claude working (braille title)", detectTurn("claude", { title: p.title }), {
      state: "working",
      confidence: "high",
    });
  }
  endRender(T);

  // === CASE 2: Claude idle — steady marker title ============================
  setTitle(T, "✳ Claude Code");
  sleep(250);
  {
    const p = readPane(T);
    check("claude idle (steady title)", detectTurn("claude", { title: p.title }), {
      state: "idle",
      confidence: "high",
    });
  }
  endRender(T);

  // === CASE 3: Claude title unreadable -> unverified ========================
  // Simulate a window we believe is Claude but whose title is an unrelated
  // process name (e.g. it spawned a subshell that retitled the pane).
  setTitle(T, "node");
  sleep(250);
  {
    const p = readPane(T);
    check("claude unreadable title -> unverified", detectTurn("claude", { title: p.title }), {
      state: "unverified",
      confidence: "low",
    });
  }
  endRender(T);

  // === CASE 4: AskUserQuestion (single-select) live in the body =============
  // Render the real prompt chrome (tab bar + question + cursor option + footer).
  renderBody(
    T,
    [
      "←  ☐ Database  ✔ Submit  →",
      "",
      "Which database would you like to add?",
      "",
      "❯ 1. PostgreSQL",
      "  2. SQLite",
      "  5. Type something.",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ],
    "Which database",
  );
  {
    const p = readPane(T);
    check("askquestion live -> waiting/high", detectAskQuestion(p.body), {
      waiting: true,
      confidence: "high",
    });
  }
  endRender(T);

  // === CASE 5: Ambiguous prompt (tab bar, NO footer) -> waiting/low =========
  renderBody(
    T,
    ["←  ☐ Testing tools  ✔ Submit  →", "", "Which testing tools do you use?"],
    "Which testing tools",
  );
  {
    const p = readPane(T);
    check("ambiguous prompt (no footer) -> waiting/low", detectAskQuestion(p.body), {
      waiting: true,
      confidence: "low",
    });
  }
  endRender(T);

  // === CASE 6: Claude prose mentioning a plan -> NOT waiting ================
  // The false-positive guard: prose that talks about proceeding/numbered steps
  // but has no ❯ cursor and no checkbox tab bar must not register.
  renderBody(
    T,
    [
      "I have written up a plan and am ready to proceed:",
      "1. Refactor the parser",
      "2. Add tests",
      "3. Ship it",
    ],
    "ready to proceed",
  );
  {
    const p = readPane(T);
    check("plan prose (no chrome) -> not waiting", detectAskQuestion(p.body), {
      waiting: false,
      confidence: "high",
    });
  }
  endRender(T);

  // === CASE 7: Codex working — live interrupt hint =========================
  // The LIVE working cue is the interrupt hint / "Working (…)", NOT "Worked for"
  // (that's a past-tense summary that persists when idle — see turn-detection).
  renderBody(T, ["◦ Working (3s • esc to interrupt)", "› Implement {feature}"], "esc to interrupt");
  {
    const p = readPane(T);
    const tail = codexTail(p.body);
    check("codex working (esc to interrupt)", detectTurn("codex", { paneTail: tail }), {
      state: "working",
      confidence: "high",
    });
  }
  endRender(T);

  // === CASE 8: Codex idle — settled footer =================================
  renderBody(
    T,
    ["› Improve documentation", "", "gpt-5.5 xhigh · Context 52% left · ~/x · Goal achieved (23m)"],
    "Goal achieved",
  );
  {
    const p = readPane(T);
    const tail = codexTail(p.body);
    check("codex idle (Goal achieved footer)", detectTurn("codex", { paneTail: tail }), {
      state: "idle",
      confidence: "high",
    });
  }
  endRender(T);

  // === CASE 9: Codex unrecognized footer -> unverified =====================
  renderBody(T, ["some random output with no codex footer markers"], "random output");
  {
    const p = readPane(T);
    const tail = codexTail(p.body);
    check("codex unrecognized footer -> unverified", detectTurn("codex", { paneTail: tail }), {
      state: "unverified",
      confidence: "low",
    });
  }
  endRender(T);

  // === CASE 10: real copy-mode -> isScrollbackMode true =====================
  // The scrollback pager swallows input; the server reads pane_mode for this.
  tmux("copy-mode", "-t", T);
  sleep(200);
  {
    const p = readPane(T);
    check("copy-mode detected via pane_mode", isScrollbackMode(p.mode), true);
  }
  tmux("send-keys", "-t", T, "-X", "cancel"); // exit copy-mode
  sleep(150);
  {
    const p = readPane(T);
    check("copy-mode cleared", isScrollbackMode(p.mode), false);
  }

  // === CASE 11: Gemini (unsupported) stays visible as unverified ===========
  setTitle(T, "Gemini doing something");
  sleep(200);
  {
    const p = readPane(T);
    check("gemini unsupported -> unverified (visible)", detectTurn("gemini", { title: p.title }), {
      state: "unverified",
      confidence: "low",
    });
  }
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
