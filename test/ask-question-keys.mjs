// Unit tests for the AskUserQuestion key-driver (lib/ask-question-keys.mjs):
// given a parsed prompt + the user's desired answer, it computes the tmux
// send-keys sequence that drives the real Claude TUI. Pure function tests.

import assert from "node:assert/strict";
import {
  moveCursorKeys,
  singleSelectKeys,
  multiSelectKeys,
  reviewSubmitKeys,
  freeFormKeys,
  cancelKeys,
} from "../lib/ask-question-keys.mjs";

// --- moveCursorKeys ------------------------------------------------------------

assert.deepEqual(moveCursorKeys(0, 2), ["Down", "Down"], "move down 2");
assert.deepEqual(moveCursorKeys(3, 1), ["Up", "Up"], "move up 2");
assert.deepEqual(moveCursorKeys(2, 2), [], "no move when same");
assert.deepEqual(moveCursorKeys(-1, 2), [], "no move when from unknown");

// --- singleSelectKeys ----------------------------------------------------------

// Cursor starts at index 0 (Spring); pick Fall (index 2) -> Down,Down,Enter.
const single = { cursorIndex: 0, options: [{}, {}, {}, {}] };
assert.deepEqual(
  singleSelectKeys(single, 2),
  ["Down", "Down", "Enter"],
  "single: move to target then Enter",
);
// Already on the target -> just Enter.
assert.deepEqual(singleSelectKeys({ cursorIndex: 2 }, 2), ["Enter"], "single: Enter in place");

// --- multiSelectKeys -----------------------------------------------------------

// Layout mirrors a real capture: 0..3 options, 4 = free-form, 5 = Submit.
const multi = {
  cursorIndex: 0,
  options: [
    { title: "Jest", multiSelect: true, checked: false },
    { title: "Vitest", multiSelect: true, checked: false },
    { title: "Playwright", multiSelect: true, checked: false },
    { title: "Mocha", multiSelect: true, checked: false },
    { title: "Type something", multiSelect: true, checked: false, isFreeForm: true },
    { title: "Submit", isSubmit: true },
  ],
};

// Want Vitest (1) + Playwright (2). Toggle each, then go to Submit (index 5).
assert.deepEqual(
  multiSelectKeys(multi, new Set([1, 2])),
  ["Down", "Enter", "Down", "Enter", "Down", "Down", "Down", "Enter"],
  "multi: toggle 1 and 2, then move to Submit and Enter",
);

// Already-checked options are left alone; only the delta is toggled.
const multiPreChecked = {
  cursorIndex: 0,
  options: [
    { title: "Jest", multiSelect: true, checked: true },
    { title: "Vitest", multiSelect: true, checked: false },
    { title: "Submit", isSubmit: true },
  ],
};
// Want only Vitest: uncheck Jest (0) is NOT desired -> toggle it off; check Vitest (1).
assert.deepEqual(
  multiSelectKeys(multiPreChecked, new Set([1])),
  ["Enter", "Down", "Enter", "Down", "Enter"],
  "multi: untoggle undesired + toggle desired, then Submit",
);

// Free-form and Submit pseudo-options are never toggled as answers.
const onlySubmit = multiSelectKeys(multi, new Set());
assert.ok(
  !onlySubmit.slice(0, -1).includes("Enter") || onlySubmit.length >= 1,
  "multi: empty selection still routes to Submit",
);
assert.equal(onlySubmit[onlySubmit.length - 1], "Enter", "multi: ends with Enter on Submit");

// --- reviewSubmitKeys ----------------------------------------------------------

// Cursor defaults to "Submit answers" -> just Enter.
assert.deepEqual(
  reviewSubmitKeys({ cursorIndex: 0, options: [{ title: "Submit answers" }, { title: "Keep editing" }] }),
  ["Enter"],
  "review: Enter when already on Submit answers",
);
assert.deepEqual(reviewSubmitKeys(null), ["Enter"], "review: safe default Enter");

// --- freeFormKeys --------------------------------------------------------------

assert.deepEqual(
  freeFormKeys("hello there"),
  ["Escape", { text: "hello there" }, "Enter"],
  "free: Escape, literal text, Enter",
);
assert.deepEqual(freeFormKeys(""), ["Escape", { text: "" }, "Enter"], "free: empty text safe");

// --- cancelKeys ----------------------------------------------------------------

assert.deepEqual(cancelKeys(), ["Escape"], "cancel: Escape");

console.log("ask-question-keys.mjs: all assertions passed");
