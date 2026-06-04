// Unit test for isScrollbackMode (lib/pane-mode.mjs). The scrollback pager that
// swallows tmux input has TWO mode names — copy-mode AND view-mode — and missing
// view-mode was a real regression (Enter/send silently eaten on devbox1, where
// Claude Code's Ctrl+O output expansion lands panes in view-mode). Lock both in.

import assert from "node:assert/strict";
import { isScrollbackMode } from "../lib/pane-mode.mjs";

// Both pager modes count.
assert.equal(isScrollbackMode("copy-mode"), true, "copy-mode is the pager");
assert.equal(isScrollbackMode("view-mode"), true, "view-mode is the pager (the regression)");

// Not in any mode (pane_mode is "" then), or an unrelated value, does not.
assert.equal(isScrollbackMode(""), false, "no mode -> not pager");
assert.equal(isScrollbackMode(undefined), false, "undefined -> not pager");
assert.equal(isScrollbackMode(null), false, "null -> not pager");
assert.equal(isScrollbackMode("some-program-mode"), false, "other mode -> not pager");

console.log("pane-mode unit tests passed");
