// Wire protocol between a local agent (`server.mjs --register`) and the
// controller (`server.mjs --controller`). Pure data + frame helpers, no I/O —
// imported by both
// sides so the contract lives in exactly one place. Bump PROTOCOL_VERSION on
// any breaking frame change.

export const PROTOCOL_VERSION = 1;

// Compatibility version for the code that runs on each connected machine.
// Bump this only when an existing connector must be git-updated for correctness.
// Do not bump it for controller/frontend-only deploys.
export const CONNECTOR_COMPAT_VERSION = "1";

// WebSocket path the agent dials and the hub accepts agents on.
export const AGENT_WS_PATH = "/agent/connect";

// Frame types (the `t` field).
export const MSG = {
  HELLO: "hello", // agent -> hub, once right after connecting
  INFO: "info", // hub -> agent, metadata for this controller instance
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
  // Resolve the git remote (GitHub repo) for a directory, for window metadata.
  // { path } -> { host, owner, name } (empty strings when not a git/remote dir).
  REPO: "repo",
  // Full command line of the foreground process on a tty, for agent detection
  // when the agent runs via an interpreter (e.g. `node /usr/bin/codex`, where
  // pane_current_command is just "node"). { tty } -> { command } (full argv
  // string, or "" if it can't be determined).
  PANECMD: "panecmd",
  // Write an uploaded file to a temp directory on the target machine, for the
  // composer's "attach a file" action. { name, base64 } -> { path, name } (the
  // absolute path the bytes were written to). Name is sanitized to a basename.
  WRITEFILE: "writefile",
  // Walk the process tree under a pid, for the "fork this agent" quick action.
  // { rootPid: number } -> { processes: {pid,ppid,command}[] }.
  PROCESS_TREE: "processTree",
  AGENT_LAST_RESPONSE: "agentLastResponse",
  // { rootPid: number, cwd?: string } ->
  //   { result: null } if the pane isn't running a known agent, otherwise
  //   { result: { kind: "codex" | "claude", sessionId, transcriptPath, text } }
  // text is the agent's most recent assistant message lifted from its own
  // JSONL transcript on the agent machine. cwd is used for Claude Code's
  // filesystem fallback (it doesn't keep its transcript file open, so lsof
  // alone can't find it).
  AGENT_TRANSCRIPT: "agentTranscript",
  // Same detection as AGENT_LAST_RESPONSE, but the result carries every
  // user/assistant turn (filtered to clean dialogue — tool calls, tool
  // results, system reminders, environment context, etc. are dropped):
  //   { result: { kind, sessionId, transcriptPath, turns: [{role, text, t?}] } }
};

// Ops an agent advertises in its hello frame (helloFrame attaches this). The
// controller checks against it before brokering, so a request for an op an
// older connector doesn't support fails fast with a clear "out of date" message
// instead of leaking a raw "unknown op" error. An agent omitting this list
// (pre-capabilities) is treated as supporting only the original three ops.
export const AGENT_OPS = [
  OP.TMUX,
  OP.READDIR,
  OP.BRANCH,
  OP.READFILE,
  OP.REPO,
  OP.PANECMD,
  OP.WRITEFILE,
  OP.PROCESS_TREE,
  OP.AGENT_LAST_RESPONSE,
  OP.AGENT_TRANSCRIPT,
];
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
  "set-option", // per-session @tm_annotation user option (follow-up notes)
  "show-options",
]);

export function isAllowedTmux(args) {
  return Array.isArray(args) && TMUX_SUBCOMMANDS.has(args[0]);
}

export function helloFrame(info) {
  // `ops` advertises this agent's supported operations so the controller can
  // detect a version-skewed (older) connector before brokering a newer op.
  // `connectorVersion` is the coarse "must update local checkout" gate. Raw
  // git `revision` is still passed in `info` for diagnostics and update logs,
  // but server/frontend-only deploys must not make every connector stale.
  return {
    t: MSG.HELLO,
    v: PROTOCOL_VERSION,
    ops: AGENT_OPS,
    connectorVersion: CONNECTOR_COMPAT_VERSION,
    ...info,
  };
}

export function infoFrame(info) {
  return { t: MSG.INFO, ...info };
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
