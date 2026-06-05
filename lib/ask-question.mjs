// Parse + detect Claude Code's AskUserQuestion prompt from a captured tmux pane
// (ANSI already stripped by the caller). The prompt looks like:
//
//   ←  ☒ Database  ☐ ORM  ✔ Submit  →        (tab bar; one tab per question)
//   Which database would you like to add?       (question text)
//   ❯ 1. PostgreSQL                             (options; ❯ = cursor)
//        Powerful open-source relational…        (optional description line[s])
//     2. SQLite
//     5. Type something.                          (free-form escape hatch)
//     6. Chat about this                          (escape hatch)
//   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//
// Single-select options have no checkbox; multi-select options render "[ ]" /
// "[✔]". The active tab's checkbox is ☒ (answered) / ☐ (not). There may be a
// review screen at the end ("Review your answers" + "1. Submit answers").
//
// Pure + dependency-free so it can be unit-tested.

// The footer is the most reliable signature of an active prompt. With a single
// question the tab bar is just " ☐ Header" (no "✔ Submit"/arrows); with multiple
// it's "←  ☒ A  ☐ B  ✔ Submit  →". The footer + a checkbox tab line, OR the
// review screen, identifies the prompt.
const FOOTER_RE = /(?:Enter to select|Enter to confirm).*(?:navigate|cycle)|to navigate\s*·\s*Esc to cancel/i;
const TAB_BAR_RE = /[☐☒☑]\s*\S/; // a checkbox tab (single- or multi-question)
// The review header alone is too weak — Claude's own prose ("let me review your
// answers", "ready to submit your answers to CI") would false-fire and mark the
// window as needing input. The real review screen always renders a selectable
// "Submit answers" option line (with the ❯ cursor), so require both: the header
// phrase AND that submit option. SUBMIT_OPTION_RE matches "❯ 1. Submit answers"
// or a bare "❯ Submit answers" option row.
const REVIEW_HEADER_RE = /Review your answers|Ready to submit your answers/i;
const SUBMIT_OPTION_RE = /^\s*❯?\s*(?:\d+\.\s*)?Submit answers?\b/im;
// Claude's "exit plan mode" confirmation: a header line + a numbered single-select
// of how to proceed. Same interaction shape as a single-select AskUserQuestion
// (cursor + Enter), but with no tab bar / no AskUserQuestion footer, so it needs
// its own detection. The header wording is the stable anchor.
const PLAN_RE = /(?:ready to execute|written up a plan).*(?:proceed|Would you like)|Would you like to proceed\?/i;

// True if the captured screen currently shows an AskUserQuestion (or its review),
// or Claude's exit-plan-mode confirmation. This is the STRICT, high-confidence
// signal: footer + tab bar, the review screen, or a cursor-bearing plan prompt.
// It deliberately requires structure (not just phrases) to avoid false-firing on
// Claude's own prose. Kept as a boolean for existing callers; detectAskQuestion()
// wraps it with a confidence and the loosened "maybe waiting" heuristic.
export function isAskQuestion(screen) {
  const s = String(screen || "");
  if (isReviewScreen(s)) return true;
  if (isPlanPrompt(s)) return true;
  return FOOTER_RE.test(s) && TAB_BAR_RE.test(s);
}

// A cursor-bearing numbered option line: "❯ 1. Something". The ❯ is what the real
// TUI renders for a live single-select; prose never does. This is the anchor for
// the low-confidence "maybe blocked" heuristic below.
const CURSOR_OPTION_RE = /^\s*❯\s*\d+\.\s+\S/m;

// HONEST STATE (Wave 1). Detect whether the pane is blocked on a prompt, with a
// CONFIDENCE so the queue can rank an uncertain window below confirmed ones
// instead of either trusting it (false ❓) or dropping it (a blocked agent that
// silently vanishes — the cardinal sin).
//
// Returns { waiting: boolean, confidence: "high" | "low" }:
//   - waiting:true,  high : the strict isAskQuestion signal (definitely a prompt).
//   - waiting:true,  low  : AMBIGUOUS — structure that often means a prompt but is
//                           missing a confirming signal (e.g. a checkbox tab bar
//                           with no footer yet because the pane is mid-redraw, or
//                           a cursor-bearing numbered option without the footer or
//                           plan header). Surface as "unverified", NEVER a
//                           confident ❓ — preserves the false-positive discipline
//                           that keeps Claude's prose from registering as a prompt.
//   - waiting:false, high : confidently not a prompt.
//
// The loosened branch only ever produces LOW confidence; the confident "needs
// answer" path is exactly the unchanged strict detector.
export function detectAskQuestion(screen) {
  const s = String(screen || "");
  if (isAskQuestion(s)) return { waiting: true, confidence: "high" };

  // Loosened heuristics — each indicates a likely-but-unconfirmed live prompt.
  // A checkbox tab bar present but the footer not yet captured (mid-redraw), OR a
  // cursor-bearing numbered option without the footer/plan header. Both are real
  // signatures of the TUI's selector chrome, which prose does not emit; but
  // without the confirming footer/header we cannot be certain, so: low only.
  const hasTabBar = TAB_BAR_RE.test(s);
  const hasCursorOption = CURSOR_OPTION_RE.test(s);
  if (hasTabBar || hasCursorOption) {
    return { waiting: true, confidence: "low" };
  }
  return { waiting: false, confidence: "high" };
}

// The AskUserQuestion review/confirm screen: the header phrase AND the selectable
// "Submit answers" option. Requiring the option line keeps Claude's own prose that
// merely mentions reviewing/submitting answers from registering as a live prompt.
function isReviewScreen(screen) {
  const s = String(screen || "");
  return REVIEW_HEADER_RE.test(s) && SUBMIT_OPTION_RE.test(s);
}

// The exit-plan-mode prompt = the plan header AND a numbered option carrying the
// ❯ cursor. The cursor is REQUIRED, not optional: Claude routinely writes prose
// like "Would you like to proceed?\n1. step one\n2. step two", which matches the
// header but is not a live prompt. Only the real TUI renders the ❯ selector, so
// requiring it on a numbered line is what separates the prompt from prose.
function isPlanPrompt(screen) {
  const s = String(screen || "");
  if (!PLAN_RE.test(s)) return false;
  return /^\s*❯\s*\d+\.\s+\S/m.test(s);
}

// Extract the per-question tabs from the tab-bar line, e.g.
//   "←  ☒ Database  ☐ ORM  ✔ Submit  →"  -> [{header:"Database",answered:true},
//                                              {header:"ORM",answered:false}]
function parseTabs(line) {
  if (!line) return [];
  const tabs = [];
  // Match "☒ Header" / "☐ Header" / "☑ Header" up to the next box or Submit.
  const re = /([☐☒☑])\s+([^☐☒☑]+?)(?=\s{2,}[☐☒☑✔]|\s+✔|\s*$)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const header = m[2].trim().replace(/\s+→\s*$/, "").trim();
    if (!header || /^Submit$/i.test(header)) continue;
    tabs.push({ header, answered: m[1] === "☒" || m[1] === "☑" });
  }
  return tabs;
}

// Parse one option line. Returns { n, title, multiSelect, checked, isCursor,
// isFreeForm, isChat } or null.
function parseOptionLine(line) {
  // e.g. "❯ 1. [✔] Python"  or  "  2. SQLite"  or "❯ 5. Type something."
  const m = line.match(/^(\s*)(❯)?\s*(\d+)\.\s+(?:\[([ ✔xX])\]\s+)?(.*\S)\s*$/);
  if (!m) return null;
  const isCursor = Boolean(m[2]);
  const n = Number(m[3]);
  const box = m[4]; // undefined for single-select
  const title = m[5].trim();
  return {
    n,
    title,
    multiSelect: box !== undefined,
    checked: box === "✔" || box === "x" || box === "X",
    isCursor,
    isFreeForm: /^type something\.?$/i.test(title),
    isChat: /^chat about this$/i.test(title),
  };
}

// Parse the full prompt into a structured form the UI can render.
// Returns null when the screen isn't an AskUserQuestion.
export function parseAskQuestion(screen) {
  const s = String(screen || "");
  if (!isAskQuestion(s)) return null;
  const lines = s.split("\n");

  // Review screen: a confirmation step, not the question itself.
  if (isReviewScreen(s)) {
    return { review: true, raw: collectReview(lines) };
  }

  // Exit-plan-mode confirmation: parse it as a single-select (no tab bar).
  if (isPlanPrompt(s)) {
    return parsePlanPrompt(lines);
  }

  // Find the tab bar: a multi-question bar has "✔ Submit"; a single-question bar
  // is just a checkbox + header (" ☐ Color"). Prefer the Submit bar; else the
  // first checkbox line that isn't an option line.
  let tabLineIdx = lines.findIndex((l) => /✔\s*Submit/.test(l) && /[☐☒☑]/.test(l));
  if (tabLineIdx === -1) {
    tabLineIdx = lines.findIndex(
      (l) => /[☐☒☑]\s*\S/.test(l) && !parseOptionLine(l),
    );
  }
  const tabs = tabLineIdx >= 0 ? parseTabs(lines[tabLineIdx]) : [];
  const activeTab = tabs.findIndex((t) => !t.answered);

  // The question text is the first non-empty line after the tab bar that isn't
  // an option/footer line.
  let questionText = "";
  let optionsStart = -1;
  for (let i = Math.max(tabLineIdx + 1, 0); i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;
    if (parseOptionLine(lines[i])) {
      optionsStart = i;
      break;
    }
    if (!questionText) questionText = t;
  }

  // Collect option lines + fold description lines (the indented non-numbered
  // lines after an option) into the preceding option. A lone "Submit" line in a
  // multi-select prompt is its own selectable pseudo-option (it gets a cursor),
  // not a description — model it as such.
  const options = [];
  if (optionsStart >= 0) {
    for (let i = optionsStart; i < lines.length; i += 1) {
      if (FOOTER_RE.test(lines[i])) break;
      const opt = parseOptionLine(lines[i]);
      const submitM = lines[i].match(/^(\s*)(❯)?\s*(Submit)\s*$/);
      if (opt) {
        options.push({ ...opt, desc: "" });
      } else if (submitM) {
        options.push({
          n: null,
          title: "Submit",
          multiSelect: false,
          checked: false,
          isCursor: Boolean(submitM[2]),
          isFreeForm: false,
          isChat: false,
          isSubmit: true,
          desc: "",
        });
      } else if (options.length && lines[i].trim() && !/^[─-]{5,}$/.test(lines[i].trim())) {
        // description continuation for the last option (skip rule lines)
        const last = options[options.length - 1];
        last.desc = last.desc ? `${last.desc} ${lines[i].trim()}` : lines[i].trim();
      }
    }
  }

  const multiSelect = options.some((o) => o.multiSelect);
  const cursorIndex = options.findIndex((o) => o.isCursor);

  return {
    review: false,
    tabs,
    activeTab: activeTab === -1 ? Math.max(tabs.length - 1, 0) : activeTab,
    questionText,
    multiSelect,
    cursorIndex,
    options,
  };
}

function collectReview(lines) {
  // Pull the "→ <answers>" summary lines for display.
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("→") || /^[●·]/.test(t)) out.push(t.replace(/^[●·]\s*/, ""));
  }
  return out;
}

// Parse Claude's exit-plan-mode confirmation into the standard single-select
// shape, so the same overlay + single-select driver handle it. The "Tell Claude
// what to change" option is the free-form path (type your feedback). There's no
// tab bar; the "Would you like to proceed?" line is the question text.
function parsePlanPrompt(lines) {
  const headerIdx = lines.findIndex((l) => PLAN_RE.test(l));
  const questionText =
    (headerIdx >= 0 ? lines[headerIdx].trim() : "") || "Claude is ready to proceed.";

  const options = [];
  for (let i = Math.max(headerIdx, 0); i < lines.length; i += 1) {
    const opt = parseOptionLine(lines[i]);
    if (!opt) {
      // Stop once we hit the trailing chrome after the options block.
      if (options.length && /ctrl-g|shift\+tab/i.test(lines[i])) break;
      continue;
    }
    // "Tell Claude what to change" → free-form (type your own feedback).
    const isFreeForm = /tell claude/i.test(opt.title);
    options.push({ ...opt, multiSelect: false, checked: false, isFreeForm, desc: "" });
  }

  const cursorIndex = options.findIndex((o) => o.isCursor);
  return {
    review: false,
    plan: true,
    tabs: [{ header: "Plan", answered: false }],
    activeTab: 0,
    questionText,
    multiSelect: false,
    cursorIndex,
    options,
  };
}
