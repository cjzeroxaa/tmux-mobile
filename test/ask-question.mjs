// Unit tests for the AskUserQuestion parser/detector (lib/ask-question.mjs).
// Fixtures are real tmux pane captures (ANSI already stripped) taken while
// driving live Claude Code prompts, so the grammar these assert against is the
// one Claude actually renders.

import assert from "node:assert/strict";
import { isAskQuestion, detectAskQuestion, parseAskQuestion } from "../lib/ask-question.mjs";

// --- Fixtures (verbatim captures, trailing pane chrome trimmed) ----------------

// Single-question, multi-select. Note: a lone "Submit" line follows the
// "Type something" option (its own pseudo-option, not a description).
const MULTI = `
● I'll ask you which testing tools you use.

←  ☐ Testing tools  ✔ Submit  →

Which testing tools do you use?

❯ 1. [ ] Jest
     JavaScript testing framework maintained by Meta, popular with React and Node projects.
  2. [ ] Vitest
     Vite-native unit test framework with fast HMR-style watch mode and Jest-compatible API.
  3. [ ] Playwright
     End-to-end browser automation and testing across Chromium, Firefox, and WebKit.
  4. [ ] Mocha
     Flexible JavaScript test framework, often paired with Chai for assertions.
  5. [ ] Type something
     Submit
  6. [ ] Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// Single-question, single-select (no checkboxes, no Submit pseudo-option, the
// tab bar is just " ☐ Header").
const SINGLE = `
●  I'll ask your favorite season.

 ☐ Season

What is your favorite season?

❯ 1. Spring
     Mild and blossoming.
  2. Summer
     Warm and long days.
  3. Fall
     Crisp and colorful.
  4. Winter
     Cold and quiet.
  5. Type something.
  6. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// Two-question prompt: Color (single) then Fruits (multi). First tab active.
const TWO = `
←  ☐ Color  ☐ Fruits  ✔ Submit  →

What is your favorite color?

❯ 1. Red
     Warm, bold, and energetic.
  2. Green
     Natural, calm, and fresh.
  3. Blue
     Cool, serene, and classic.
  4. Type something.
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// Same two-question prompt after Q1 is answered: Color tab now ☑.
const TWO_AFTER_Q1 = `
←  ☑ Color  ☐ Fruits  ✔ Submit  →

Which fruits do you like?

❯ 1. [ ] Apple
  2. [ ] Banana
  3. [ ] Cherry
  4. [ ] Type something
     Submit
  5. [ ] Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const REVIEW = `
Review your answers

● What is your favorite color?
  → Blue
● Which fruits do you like?
  → Apple, Cherry

❯ 1. Submit answers
  2. Keep editing

Enter to confirm · Arrow keys to navigate · Esc to cancel
`;

const NOT_A_PROMPT = `
ubuntu@host:~$ ls
file-a  file-b
ubuntu@host:~$ echo "Enter to select something unrelated"
`;

// --- isAskQuestion -------------------------------------------------------------

assert.equal(isAskQuestion(MULTI), true, "detect multi-select");
assert.equal(isAskQuestion(SINGLE), true, "detect single-select");
assert.equal(isAskQuestion(TWO), true, "detect two-question");
assert.equal(isAskQuestion(REVIEW), true, "detect review screen");
assert.equal(isAskQuestion(NOT_A_PROMPT), false, "ignore plain shell");
assert.equal(isAskQuestion(""), false, "ignore empty");
assert.equal(isAskQuestion(null), false, "ignore null");

// --- single-select -------------------------------------------------------------

let p = parseAskQuestion(SINGLE);
assert.ok(p && !p.review, "single: parsed, not review");
assert.equal(p.multiSelect, false, "single: not multi-select");
assert.equal(p.questionText, "What is your favorite season?", "single: question text");
assert.deepEqual(p.tabs.map((t) => t.header), ["Season"], "single: one tab");
assert.equal(p.cursorIndex, 0, "single: cursor on first option");
const seasons = p.options.filter((o) => !o.isFreeForm && !o.isChat && !o.isSubmit);
assert.deepEqual(
  seasons.map((o) => o.title),
  ["Spring", "Summer", "Fall", "Winter"],
  "single: option titles",
);
assert.equal(seasons[0].desc, "Mild and blossoming.", "single: folds desc into option");
assert.ok(
  p.options.some((o) => o.isFreeForm),
  "single: has a free-form option",
);
assert.ok(
  p.options.some((o) => o.isChat),
  "single: has a chat option",
);

// --- multi-select --------------------------------------------------------------

p = parseAskQuestion(MULTI);
assert.ok(p && !p.review, "multi: parsed, not review");
assert.equal(p.multiSelect, true, "multi: is multi-select");
assert.equal(p.questionText, "Which testing tools do you use?", "multi: question text");
const tools = p.options.filter((o) => o.multiSelect && !o.isFreeForm && !o.isChat);
assert.deepEqual(
  tools.map((o) => o.title),
  ["Jest", "Vitest", "Playwright", "Mocha"],
  "multi: tool titles",
);
assert.ok(
  tools.every((o) => o.checked === false),
  "multi: nothing checked initially",
);
// The lone "Submit" line must be its own pseudo-option, never a description.
const submit = p.options.find((o) => o.isSubmit);
assert.ok(submit, "multi: Submit pseudo-option exists");
assert.equal(submit.title, "Submit", "multi: Submit title");
const typeSomething = p.options.find((o) => o.isFreeForm);
assert.ok(
  typeSomething && !/submit/i.test(typeSomething.desc || ""),
  "multi: Submit not folded into 'Type something' desc",
);

// --- two-question --------------------------------------------------------------

p = parseAskQuestion(TWO);
assert.deepEqual(
  p.tabs.map((t) => [t.header, t.answered]),
  [["Color", false], ["Fruits", false]],
  "two: both tabs unanswered",
);
assert.equal(p.activeTab, 0, "two: active tab is Color");
assert.equal(p.multiSelect, false, "two: Q1 is single-select");
assert.equal(p.questionText, "What is your favorite color?", "two: Q1 text");

p = parseAskQuestion(TWO_AFTER_Q1);
assert.deepEqual(
  p.tabs.map((t) => [t.header, t.answered]),
  [["Color", true], ["Fruits", false]],
  "two: Color answered after Q1",
);
assert.equal(p.activeTab, 1, "two: active tab advanced to Fruits");
assert.equal(p.multiSelect, true, "two: Q2 is multi-select");
assert.equal(p.questionText, "Which fruits do you like?", "two: Q2 text");

// --- review --------------------------------------------------------------------

p = parseAskQuestion(REVIEW);
assert.ok(p && p.review === true, "review: flagged as review");

// --- exit-plan-mode prompt -----------------------------------------------------

// Real capture (ANSI stripped): the plan-approval confirmation.
const PLAN = `
 Here is Claude's plan:
 Plan: Create hello.txt
 1. Create a file hello.txt in /tmp containing "Hello, world!".

────────────────────────────────────────────────────────────────────────────

 Claude has written up a plan and is ready to execute. Would you like to proceed?

 ❯ 1. Yes, and bypass permissions
   2. Yes, manually approve edits
   3. No, refine with Ultraplan on Claude Code on the web
   4. Tell Claude what to change
      shift+tab to approve with this feedback

 ctrl-g to edit in  Vim
`;

assert.equal(isAskQuestion(PLAN), true, "plan: detected");
p = parseAskQuestion(PLAN);
assert.ok(p && p.plan === true, "plan: flagged plan");
assert.equal(p.multiSelect, false, "plan: single-select");
assert.equal(p.review, false, "plan: not review");
assert.match(p.questionText, /proceed/i, "plan: question text");
assert.equal(p.cursorIndex, 0, "plan: cursor on first option");
assert.deepEqual(
  p.options.map((o) => o.title),
  [
    "Yes, and bypass permissions",
    "Yes, manually approve edits",
    "No, refine with Ultraplan on Claude Code on the web",
    "Tell Claude what to change",
  ],
  "plan: option titles",
);
// "Tell Claude what to change" is the free-form path; the rest are not.
assert.equal(p.options[3].isFreeForm, true, "plan: option 4 is free-form");
assert.ok(
  p.options.slice(0, 3).every((o) => !o.isFreeForm),
  "plan: yes/no options are not free-form",
);

// The plan header text alone (no numbered options yet) must NOT register, so the
// overlay doesn't fire mid-stream while the plan is still printing.
const PLAN_HEADER_ONLY = "\n Claude has written up a plan and is ready to execute. Would you like to proceed?\n";
assert.equal(isAskQuestion(PLAN_HEADER_ONLY), false, "plan: header alone -> not active");

// --- false-positive guards (these mark a window "needs you" when wrong) --------
// Claude's OWN prose discusses plans, reviews, and submitting answers all the
// time. None of these are live TUI prompts; the detector must not fire on them.

// Plan: the header phrase + a numbered list, but NO ❯ cursor. Prose, not a prompt.
assert.equal(
  isAskQuestion(
    "I have written up a plan and am ready to execute. Would you like me to proceed:\n1. Refactor the parser\n2. Add tests\n3. Ship it",
  ),
  false,
  "fp: plan prose + numbered list (no ❯ cursor) -> not active",
);
assert.equal(
  isAskQuestion("The script is ready to execute. Would you like to proceed?\n1. It takes ~5 minutes to run."),
  false,
  "fp: 'ready to execute … proceed?' prose -> not active",
);

// Review: the header phrase but NO selectable "Submit answers" option. Prose.
assert.equal(
  isAskQuestion("Let me review your answers from the form earlier and summarize them below."),
  false,
  "fp: 'review your answers' prose -> not active",
);
assert.equal(
  isAskQuestion("The PR is ready to submit your answers to CI once the tests pass."),
  false,
  "fp: 'ready to submit your answers' prose -> not active",
);
assert.equal(
  isAskQuestion('  // Render the "Review your answers" header above the submit button\n  renderReview();'),
  false,
  "fp: code quoting the review phrase -> not active",
);
// But a real review screen (header + the Submit answers option) still fires.
assert.equal(
  isAskQuestion("Review your answers\n→ Database: PostgreSQL\n❯ 1. Submit answers"),
  true,
  "fp guard keeps real review screen detected",
);

// --- negative ------------------------------------------------------------------

assert.equal(parseAskQuestion(NOT_A_PROMPT), null, "negative: plain shell -> null");
assert.equal(parseAskQuestion(""), null, "negative: empty -> null");

// --- detectAskQuestion: { waiting, confidence } (HONEST STATE, Wave 1) ---------
// Every screen the STRICT detector confirms is high-confidence waiting.
for (const [name, fx] of [["MULTI", MULTI], ["SINGLE", SINGLE], ["TWO", TWO], ["REVIEW", REVIEW], ["PLAN", PLAN]]) {
  assert.deepEqual(
    detectAskQuestion(fx),
    { waiting: true, confidence: "high" },
    `detect: ${name} -> waiting/high`,
  );
}

// Confidently NOT a prompt: plain shell / empty.
assert.deepEqual(detectAskQuestion(NOT_A_PROMPT), { waiting: false, confidence: "high" }, "detect: plain shell -> not waiting");
assert.deepEqual(detectAskQuestion(""), { waiting: false, confidence: "high" }, "detect: empty -> not waiting");

// AMBIGUOUS -> low confidence (visible as unverified, never a confident ❓).
// A checkbox tab bar with NO footer (mid-redraw): structure present, confirming
// footer missing. Likely a prompt, but we cannot be sure.
assert.deepEqual(
  detectAskQuestion("←  ☐ Testing tools  ✔ Submit  →\n\nWhich testing tools do you use?"),
  { waiting: true, confidence: "low" },
  "detect: tab bar, no footer -> low confidence",
);
// A cursor-bearing numbered option with no footer / no plan header.
assert.deepEqual(
  detectAskQuestion("Choose one:\n❯ 1. PostgreSQL\n  2. SQLite"),
  { waiting: true, confidence: "low" },
  "detect: cursor option, no footer -> low confidence",
);

// The loosened branch must STILL not fire on Claude's prose: a numbered list with
// NO cursor and NO checkbox tab bar is not a prompt at any confidence.
assert.deepEqual(
  detectAskQuestion("Here is the plan:\n1. Refactor the parser\n2. Add tests\n3. Ship it"),
  { waiting: false, confidence: "high" },
  "detect: prose numbered list (no cursor/no tab bar) -> not waiting",
);

// --- codex approval prompts (real captures from the attention-watch run) ------
// Codex blocks on approval with a `›`-cursor numbered list + a fixed confirm
// footer. This was a false NEGATIVE before (read as idle/finished). Now: a
// confident waiting.
const CODEX_EDIT_APPROVAL = `  Would you like to make the following edits?
  Reason: command failed; retry without sandbox?
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel`;
const CODEX_CMD_APPROVAL = `  $ python3 fib.py
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`python3 fib.py\` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel`;
assert.equal(isAskQuestion(CODEX_EDIT_APPROVAL), true, "codex edit-approval -> detected");
assert.equal(isAskQuestion(CODEX_CMD_APPROVAL), true, "codex command-approval -> detected");
assert.deepEqual(
  detectAskQuestion(CODEX_EDIT_APPROVAL),
  { waiting: true, confidence: "high" },
  "detect: codex edit-approval -> waiting/high",
);
assert.deepEqual(
  detectAskQuestion(CODEX_CMD_APPROVAL),
  { waiting: true, confidence: "high" },
  "detect: codex command-approval -> waiting/high",
);
// Codex IDLE (the "Worked for" summary + bare `›` placeholder, NO confirm footer)
// must NOT register as a prompt — the discriminator is the confirm footer.
const CODEX_IDLE = `─ Worked for 1m 48s ──
› Implement {feature}
  gpt-5.5 xhigh · Context 97% left · /tmp/x · gpt-5.5`;
assert.deepEqual(
  detectAskQuestion(CODEX_IDLE),
  { waiting: false, confidence: "high" },
  "detect: codex idle (no confirm footer) -> not waiting",
);
// The confirm footer ALONE (e.g. quoted in scrollback) without a `›`-cursor
// option must not fire — both signals required.
assert.deepEqual(
  detectAskQuestion("see the prompt that says Press enter to confirm or esc to cancel"),
  { waiting: false, confidence: "high" },
  "detect: codex confirm-footer phrase alone -> not waiting",
);

console.log("ask-question.mjs: all assertions passed");
