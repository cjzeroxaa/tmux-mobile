// Pure helpers for tmux pane modes. Kept in lib/ (not server.mjs) so they're
// unit-testable without booting the server.

// tmux's scrollback pager has TWO mode names that both swallow input:
//   - "copy-mode" (interactive copy)
//   - "view-mode" (read-only — what a program's Ctrl+O output expansion / a
//     scroll-up lands in)
// Either one intercepts keystrokes as pager commands, so input sent while a pane
// is in them never reaches the running program (the text sits in the prompt
// unsubmitted and the window looks dead). Treat both as the pager: the app exits
// it (`-X cancel`) before sending input, and flags it for the "scroll mode" banner.
// `pane_mode` is "" when the pane isn't in any mode.
export function isScrollbackMode(mode) {
  return mode === "copy-mode" || mode === "view-mode";
}
