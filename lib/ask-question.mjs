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
const REVIEW_RE = /Review your answers|Ready to submit your answers/i;

// True if the captured screen currently shows an AskUserQuestion (or its review).
export function isAskQuestion(screen) {
  const s = String(screen || "");
  if (REVIEW_RE.test(s)) return true;
  return FOOTER_RE.test(s) && TAB_BAR_RE.test(s);
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
  if (REVIEW_RE.test(s)) {
    return { review: true, raw: collectReview(lines) };
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
