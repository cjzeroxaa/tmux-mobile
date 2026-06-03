// Unit tests for the AskUserQuestion parser/detector (lib/ask-question.mjs).
// Fixtures are real tmux pane captures (ANSI already stripped) taken while
// driving live Claude Code prompts, so the grammar these assert against is the
// one Claude actually renders.

import assert from "node:assert/strict";
import { isAskQuestion, parseAskQuestion } from "../lib/ask-question.mjs";

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

// --- negative ------------------------------------------------------------------

assert.equal(parseAskQuestion(NOT_A_PROMPT), null, "negative: plain shell -> null");
assert.equal(parseAskQuestion(""), null, "negative: empty -> null");

console.log("ask-question.mjs: all assertions passed");
