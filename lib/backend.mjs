// The "tmux backend" seam. Every place the app touches the local machine goes
// through a Backend, so the same request-handling code serves both modes:
//   - local mode: the default localBackend runs tmux/readdir on this machine.
//   - cloud mode: the hub pushes a per-request remote backend (see lib/hub.mjs)
//     onto backendStore so the exact same code reaches the selected machine.
//
// Backend interface (kept here on purpose, separate from implementations):
//   tmux(args: string[], options?: {maxBuffer?, timeout?}) => Promise<string stdout>
//     rejects with an Error whose .message is the tmux stderr and .code the exit code
//   readdir(path: string) => Promise<{name: string, isDirectory: boolean}[]>
//   processTree(rootPid) => Promise<{pid: number, ppid: number, command: string}[]>

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";

const backendStore = new AsyncLocalStorage();

/** Run `fn` with `backend` active for everything it (a)waits on. */
export function withBackend(backend, fn) {
  return backendStore.run(backend, fn);
}

/** The backend for the current request, defaulting to the local machine. */
export function currentBackend() {
  return backendStore.getStore() || localBackend;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        timeout: options.timeout ?? 10000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message || "").trim();
          const wrapped = new Error(message || `${file} command failed`);
          wrapped.code = error.code;
          wrapped.stderr = stderr;
          reject(wrapped);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** @type {{tmux: Function, readdir: Function, processTree: Function}} */
export const localBackend = {
  tmux(args, options = {}) {
    return execFileAsync("tmux", args, options);
  },
  async readdir(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  },
  async processTree(rootPid) {
    const root = Number(rootPid);
    if (!Number.isFinite(root) || root <= 0) return [];

    const out = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const processes = out
      .split(/\r?\n/)
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3] || "",
        };
      })
      .filter(Boolean);

    const childrenByParent = new Map();
    for (const processInfo of processes) {
      if (!childrenByParent.has(processInfo.ppid)) {
        childrenByParent.set(processInfo.ppid, []);
      }
      childrenByParent.get(processInfo.ppid).push(processInfo);
    }

    const result = [];
    const queue = processes.filter((processInfo) => processInfo.pid === root);
    const seen = new Set();
    while (queue.length > 0) {
      const processInfo = queue.shift();
      if (!processInfo || seen.has(processInfo.pid)) continue;
      seen.add(processInfo.pid);
      result.push(processInfo);
      queue.push(...(childrenByParent.get(processInfo.pid) || []));
    }
    return result;
  },
  async branch(dirPath) {
    try {
      // Two pieces of info in one git invocation: current branch and the
      // path to this checkout's .git. For a linked worktree (created via
      // `git worktree add`) --git-dir resolves to something inside
      // <main>/.git/worktrees/<name>; the main checkout returns plain ".git"
      // (or an absolute path ending in /.git).
      const out = await execFileAsync(
        "git",
        ["-C", dirPath, "rev-parse", "--abbrev-ref", "HEAD", "--git-dir"],
        { timeout: 4000 },
      );
      const [head = "", gitDir = ""] = out.trim().split("\n");
      const branch = head === "HEAD" ? "" : head; // detached HEAD -> no branch
      const worktree = /\/worktrees\/[^/]+\/?$/.test(gitDir);
      return { branch, worktree };
    } catch {
      return { branch: "", worktree: false }; // not a git repo / git missing
    }
  },
  /**
   * Look for a running Codex or Claude Code agent in the descendants of
   * `rootPid` (typically the pane's pid) and return its *structured* latest
   * assistant message — pulled from the agent's own JSONL transcript on
   * disk, not guessed from terminal output.
   *
   * Returns null when no known agent is running, or when we can find the
   * agent process but not its transcript (e.g. lsof unavailable, or the
   * agent doesn't keep the file open). The caller is expected to fall back
   * to the capture-pane / LLM-extract path in that case.
   *
   * Steps:
   *   1. Walk the process tree to find codex/claude descendant pids.
   *   2. lsof each candidate to find which `*.jsonl` it has open under
   *      `~/.codex/sessions/` or `~/.claude/projects/`.
   *   3. Read the file tail and walk backwards to the most recent
   *      `role === "assistant"` message. The two CLIs use different
   *      JSONL shapes; agentTranscriptLastAssistant handles both.
   */
  async agentLastResponse(rootPid) {
    const tree = await this.processTree(rootPid);
    if (tree.length === 0) return null;

    const candidates = [
      ...tree
        .filter((p) => commandHasExecutable(p.command, "codex"))
        .map((p) => ({ kind: "codex", pid: p.pid })),
      ...tree
        .filter((p) => commandHasExecutable(p.command, "claude"))
        .map((p) => ({ kind: "claude", pid: p.pid })),
    ];

    for (const { kind, pid } of candidates) {
      const transcriptPath = await findOpenTranscriptPath(pid, kind);
      if (!transcriptPath) continue;
      const sessionId = extractSessionUuid(transcriptPath);
      let text = "";
      try {
        const tail = await readFileTail(transcriptPath, 256 * 1024);
        text = agentTranscriptLastAssistant(kind, tail);
      } catch {
        // Transcript briefly unreadable (rotation, etc.) — return the path
        // we found so the caller still has the session id, but no text.
      }
      return { kind, sessionId, transcriptPath, text };
    }
    return null;
  },
};

// Match the executable name as a whole word — same shape as the
// detectForkableAgent helper on the hub side, kept local to backend.mjs so
// the agent (cloud mode) doesn't need to import server.mjs.
function commandHasExecutable(command, executable) {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[\\s/])${escaped}([\\s]|$)`, "i");
  return pattern.test(String(command || ""));
}

const TRANSCRIPT_PATTERNS = {
  codex: /(\/[^\s"']+\.codex\/sessions\/[^\s"']+\.jsonl)/,
  claude: /(\/[^\s"']+\.claude\/projects\/[^\s"']+\.jsonl)/,
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function findOpenTranscriptPath(pid, kind) {
  let out = "";
  try {
    out = await execFileAsync("lsof", ["-p", String(pid)], {
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return "";
  }
  const match = TRANSCRIPT_PATTERNS[kind].exec(out);
  return match ? match[1] : "";
}

function extractSessionUuid(transcriptPath) {
  const match = UUID_RE.exec(transcriptPath);
  return match ? match[0] : "";
}

async function readFileTail(filePath, maxBytes) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const start = stats.size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Walk a transcript JSONL backwards and return the last assistant message
 * as a single string. Handles both shapes:
 *   Claude Code: {message: {role, content: [{type: "text", text}, …]}}
 *   Codex CLI:   {type: "response_item",
 *                  payload: {type: "message", role,
 *                            content: [{type: "output_text"|"input_text", text}]}}
 */
function agentTranscriptLastAssistant(kind, jsonlText) {
  const lines = jsonlText.split("\n");
  // If the tail started mid-line, drop the first incomplete row.
  if (lines.length && jsonlText.length === 256 * 1024) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const text = kind === "codex"
      ? assistantTextFromCodexRecord(obj)
      : assistantTextFromClaudeRecord(obj);
    if (text) return text.trim();
  }
  return "";
}

function assistantTextFromCodexRecord(obj) {
  if (!obj || obj.type !== "response_item") return "";
  const payload = obj.payload || {};
  if (payload.type !== "message" || payload.role !== "assistant") return "";
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && (c.type === "output_text" || c.type === "text"))
    .map((c) => c.text || "")
    .join("\n");
}

function assistantTextFromClaudeRecord(obj) {
  const message = obj?.message;
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
}
