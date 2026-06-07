// Compute the tmux send-keys sequence to apply a user's AskUserQuestion answer
// by driving the real Claude TUI (arrows + Enter + tabs), given the *parsed*
// current state. Pure + testable; the server sends the returned key list one at
// a time (with small delays) via tmux send-keys.
//
// Keys are tmux key names: "Up","Down","Left","Right","Enter","Escape", or
// literal text for the free-form path.
//
// Behavior derived from observed interaction:
//   - cursor moves with Up/Down between options.
//   - single-select: Enter on an option selects it and auto-advances.
//   - multi-select: Enter toggles the option's checkbox; a "Submit" pseudo-option
//     (or the tab-bar Submit) ends the question.
//   - across questions: each single-select answer auto-advances; multi-select
//     needs an explicit Submit; final review screen needs "Submit answers".

// Move the cursor from `from` index to `to` index within the option list.
export function moveCursorKeys(from, to) {
  const keys = [];
  if (from < 0 || to < 0) return keys;
  const delta = to - from;
  const key = delta > 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(delta); i += 1) keys.push(key);
  return keys;
}

// Keys to answer a SINGLE-select question by picking option at `targetIndex`
// (an index into parsed.options). Moves the cursor then Enter (which selects +
// auto-advances).
export function singleSelectKeys(parsed, targetIndex) {
  return [...moveCursorKeys(parsed.cursorIndex, targetIndex), "Enter"];
}

// Keys to answer a MULTI-select question. `desiredChecked` is a Set of option
// indices that should end up checked. We toggle (Enter) exactly the options
// whose current `checked` differs from desired, moving the cursor to each, then
// move to the Submit pseudo-option and Enter.
export function multiSelectKeys(parsed, desiredChecked) {
  const keys = [];
  let cursor = parsed.cursorIndex < 0 ? 0 : parsed.cursorIndex;
  const opts = parsed.options;
  for (let i = 0; i < opts.length; i += 1) {
    const o = opts[i];
    if (o.isFreeForm || o.isChat || o.title === "Submit") continue;
    const want = desiredChecked.has(i);
    if (want !== o.checked) {
      keys.push(...moveCursorKeys(cursor, i), "Enter");
      cursor = i;
    }
  }
  // Move to the "Submit" pseudo-option and confirm.
  const submitIndex = opts.findIndex((o) => /^submit$/i.test(o.title));
  if (submitIndex >= 0) {
    keys.push(...moveCursorKeys(cursor, submitIndex), "Enter");
  }
  return keys;
}

// Keys to confirm the final review screen ("1. Submit answers").
export function reviewSubmitKeys(parsed) {
  // The cursor defaults to "1. Submit answers"; Enter confirms.
  const idx = parsed?.options?.findIndex((o) => /submit answers/i.test(o.title));
  if (idx > 0) return [...moveCursorKeys(parsed.cursorIndex, idx), "Enter"];
  return ["Enter"];
}

// Free-form path: selecting "Type something" declines the structured prompt and
// drops into the normal composer. We send Escape to dismiss the prompt, then the
// literal text, then Enter — i.e. answer in plain chat. (Matches the TUI: free
// text is "decline + chat", not a bundled structured answer.)
export function freeFormKeys(text) {
  return ["Escape", { text: String(text || "") }, "Enter"];
}

// Cancel/decline the whole prompt.
export function cancelKeys() {
  return ["Escape"];
}
