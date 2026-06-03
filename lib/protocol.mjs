// Wire protocol between a local agent (`server.mjs --register`) and the hub
// (`server.mjs --hub`). Pure data + frame helpers, no I/O — imported by both
// sides so the contract lives in exactly one place. Bump PROTOCOL_VERSION on
// any breaking frame change.

export const PROTOCOL_VERSION = 1;

// WebSocket path the agent dials and the hub accepts agents on.
export const AGENT_WS_PATH = "/agent/connect";

// Frame types (the `t` field).
export const MSG = {
  HELLO: "hello", // agent -> hub, once right after connecting
  REQ: "req", // hub -> agent
  RES: "res", // agent -> hub, answering a req by id
};

// The complete set of operations the hub can ask an agent to perform. This is
// the entire surface an agent must implement; everything else (format strings,
// parsing, id validation, AI) stays on the hub, so agents are dumb executors
// and tmux behavior never drifts between local and cloud mode.
export const OP = {
  TMUX: "tmux", // { args: string[], options?: {maxBuffer?,timeout?} } -> { stdout }
  READDIR: "readdir", // { path: string } -> { entries: {name,isDirectory}[] }
  BRANCH: "branch", // { path: string } -> { branch: string, worktree: boolean }
  // Read a file for the smart content viewer. { path, baseDir, maxBytes } ->
  // { base64, size, truncated }. The agent confines `path` to the `baseDir`
  // subtree (the pane's cwd) and refuses anything outside it.
  READFILE: "readfile",
};

// Ops an agent advertises in its hello frame (helloFrame attaches this). The
// controller checks against it before brokering, so a request for an op an
// older connector doesn't support fails fast with a clear "out of date" message
// instead of leaking a raw "unknown op" error. An agent omitting this list
// (pre-capabilities) is treated as supporting only the original three ops.
export const AGENT_OPS = [OP.TMUX, OP.READDIR, OP.BRANCH, OP.READFILE];
export const LEGACY_AGENT_OPS = [OP.TMUX, OP.READDIR, OP.BRANCH];

// Defense-in-depth: an agent only runs tmux subcommands on this list, so even a
// compromised/buggy hub cannot make it run e.g. `tmux kill-server`.
export const TMUX_SUBCOMMANDS = new Set([
  "list-sessions",
  "list-windows",
  "list-panes",
  "capture-pane",
  "send-keys",
  "set-buffer",
  "paste-buffer",
  "new-session",
  "rename-session",
  "new-window",
  "rename-window",
  "kill-window",
  "display-message",
]);

export function isAllowedTmux(args) {
  return Array.isArray(args) && TMUX_SUBCOMMANDS.has(args[0]);
}

export function helloFrame(info) {
  // `ops` advertises this agent's supported operations so the controller can
  // detect a version-skewed (older) connector before brokering a newer op.
  return { t: MSG.HELLO, v: PROTOCOL_VERSION, ops: AGENT_OPS, ...info };
}

export function reqFrame(id, op, payload) {
  return { t: MSG.REQ, id, op, ...payload };
}

export function resOk(id, result) {
  return { t: MSG.RES, id, ok: true, ...result };
}

export function resErr(id, error) {
  return {
    t: MSG.RES,
    id,
    ok: false,
    error: { message: error?.message || String(error), code: error?.code },
  };
}
