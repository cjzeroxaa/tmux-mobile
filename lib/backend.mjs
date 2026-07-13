// The "mux backend" seam. Every place the app touches the local machine goes
// through a Backend, so the same request-handling code serves both modes:
//   - local mode: the default localBackend runs tmux-compatible mux commands
//     plus readdir/etc. on this machine.
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
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDenied } from "./readfile-deny.mjs";

const backendStore = new AsyncLocalStorage();
const MUX_COMMANDS = new Set(["tmux", "rmux"]);

// Parse a git remote URL into { host, owner, name }. Handles the common forms:
//   https://github.com/owner/repo(.git)
//   git@github.com:owner/repo(.git)
//   ssh://git@github.com/owner/repo(.git)
// Returns empty strings on anything it can't parse. Exported for unit testing.
export function parseGitRemote(url) {
  const empty = { host: "", owner: "", name: "" };
  const raw = String(url || "").trim();
  if (!raw) return empty;
  let host = "";
  let path = "";
  // scp-like: git@host:owner/repo.git
  const scp = raw.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return empty;
    }
  }
  const parts = path.replace(/^\/+/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return empty;
  // owner is the first segment, name the last (handles nested groups, e.g. gitlab).
  return { host, owner: parts[0], name: parts[parts.length - 1] };
}

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
    const child = execFile(
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
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(String(options.input));
    }
  });
}

function execFileResultAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        timeout: options.timeout ?? 10000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || stdout || error.message || "").trim();
          const wrapped = new Error(message || `${file} command failed`);
          wrapped.code = error.code;
          wrapped.stderr = stderr;
          wrapped.stdout = stdout;
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(String(options.input));
    }
  });
}

export function normalizeMuxKind(value) {
  const mux = path.basename(String(value || "").trim()).toLowerCase();
  return MUX_COMMANDS.has(mux) ? mux : "";
}

export function muxKindsFromEnv(env = process.env) {
  const explicit = String(env.TMUX_MOBILE_MUXES || "")
    .split(",")
    .map(normalizeMuxKind)
    .filter(Boolean);
  if (explicit.length > 0) return [...new Set(explicit)];

  const single =
    normalizeMuxKind(env.TMUX_MOBILE_MUX) ||
    normalizeMuxKind(env.TMUX_MOBILE_MUX_COMMAND);
  if (single) return [single];
  return ["tmux", "rmux"];
}

function legacyMuxCommandForKind(env, kind) {
  const raw = String(env.TMUX_MOBILE_MUX_COMMAND || "").trim();
  return raw && muxKindFromCommand(raw) === kind ? raw : "";
}

export function muxCommandFromEnv(env = process.env, requestedMux = "") {
  const requested = normalizeMuxKind(requestedMux);
  if (requested === "tmux") {
    return String(env.TMUX_MOBILE_TMUX_COMMAND || legacyMuxCommandForKind(env, "tmux") || "tmux");
  }
  if (requested === "rmux") {
    return String(env.TMUX_MOBILE_RMUX_COMMAND || legacyMuxCommandForKind(env, "rmux") || "rmux");
  }

  const raw = String(
    env.TMUX_MOBILE_MUX_COMMAND || env.TMUX_MOBILE_MUX || env.TMUX_MOBILE_DEFAULT_MUX || "tmux",
  ).trim();
  if (!raw) return "tmux";
  const base = path.basename(raw.toLowerCase());
  if (!MUX_COMMANDS.has(base)) {
    const error = new Error(`Unsupported mux command: ${raw}`);
    error.status = 500;
    throw error;
  }
  return raw;
}

export function muxKindFromCommand(command) {
  const base = path.basename(String(command || "tmux")).toLowerCase();
  return MUX_COMMANDS.has(base) ? base : "tmux";
}

function muxExecArgs(command, args) {
  // launchd starts services without a UTF-8 locale. In that environment tmux
  // replaces control separators such as tabs with "_", which corrupts our
  // tab-delimited format parsing. -u forces UTF-8 output independent of locale.
  // rmux does not support/need tmux's global -u flag.
  return muxKindFromCommand(command) === "tmux" ? ["-u", ...args] : args;
}

export function parseRmuxWebShareOutput(stdout = "", stderr = "") {
  const combined = `${stderr || ""}\n${stdout || ""}`;
  const urlMatch = combined.match(/https?:\/\/[^\s"'<>]+/);
  const pinMatch =
    combined.match(/\boperator\s+(?:pin|code)\s+([A-Za-z0-9-]+)/i) ||
    combined.match(/\bpin\s+([A-Za-z0-9-]+)/i);
  const expiresMatch = combined.match(/\bshare expires at\s+([^\r\n]+)/i);
  const tunnelProviderMatch = combined.match(/\btunnel provider\s+([^\s\r\n]+)/i);
  const tunnelUrlMatch = combined.match(/\btunnel url\s+(https?:\/\/[^\s"'<>]+)/i);
  return {
    operatorUrl: urlMatch ? urlMatch[0] : "",
    code: pinMatch ? pinMatch[1] : "",
    expiresAt: expiresMatch ? expiresMatch[1].trim() : "",
    tunnelProvider: tunnelProviderMatch ? tunnelProviderMatch[1].trim() : "",
    tunnelUrl: tunnelUrlMatch ? tunnelUrlMatch[1].trim() : "",
  };
}

export function parseRmuxWebShareList(stdout = "") {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", target = "", expiresAt = ""] = line.split(/\s+/);
      return { id, target, expiresAt: expiresAt === "-" ? "" : expiresAt };
    })
    .filter((item) => item.id);
}

async function listRmuxWebShares(command) {
  try {
    const stdout = await execFileAsync(command, ["web-share", "list"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseRmuxWebShareList(stdout);
  } catch {
    return [];
  }
}

function isRmuxShareTargetForPane(item, paneId) {
  const target = String(item?.target || "");
  return target === paneId || target.endsWith(`:${paneId}`);
}

export function normalizeRmuxWebShareFrontendUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error("Invalid RMUX web share frontend URL");
    error.status = 400;
    throw error;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    const error = new Error("Invalid RMUX web share frontend URL");
    error.status = 400;
    throw error;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/g, "");
  return `${url.origin}${pathname && pathname !== "/" ? pathname : ""}`;
}

/** @type {{tmux: Function, readdir: Function, processTree: Function}} */
export const localBackend = {
  // Local mode runs current code, so it supports every op it implements.
  supportsOp() {
    return true;
  },
  metadataCacheKey() {
    return `local:${os.hostname()}`;
  },
  muxCommand(mux = "") {
    return muxCommandFromEnv(process.env, mux);
  },
  muxKind() {
    return muxKindFromCommand(this.muxCommand());
  },
  muxKinds() {
    return muxKindsFromEnv();
  },
  tmux(args, options = {}) {
    const command = muxCommandFromEnv(process.env, options.mux);
    return execFileAsync(command, muxExecArgs(command, args), options);
  },
  async rmuxWebShare({ target, ttlSeconds, tunnelProvider, frontendUrl } = {}) {
    const paneId = String(target || "").trim();
    if (!/^%\d+$/.test(paneId)) {
      const error = new Error("RMUX web share target must be a pane id");
      error.status = 400;
      throw error;
    }
    const command = muxCommandFromEnv(process.env, "rmux");
    if (muxKindFromCommand(command) !== "rmux") {
      const error = new Error("RMUX web share requires rmux");
      error.status = 400;
      throw error;
    }

    const before = new Set((await listRmuxWebShares(command)).map((item) => item.id));
    const args = ["web-share", "-t", paneId, "--operator-only"];
    const ttl = Number(ttlSeconds);
    if (Number.isFinite(ttl) && ttl > 0) {
      args.push("--ttl", String(Math.round(ttl)));
    }
    const provider = String(tunnelProvider || "").trim();
    if (provider && provider !== "local" && provider !== "none") {
      if (!/^[A-Za-z0-9._-]+$/.test(provider)) {
        const error = new Error("Invalid RMUX web share tunnel provider");
        error.status = 400;
        throw error;
      }
      args.push("--tunnel-provider", provider);
    }
    const frontend = normalizeRmuxWebShareFrontendUrl(frontendUrl);
    if (frontend) {
      args.push("--frontend-url", frontend);
    }
    const { stdout, stderr } = await execFileResultAsync(command, args, {
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = parseRmuxWebShareOutput(stdout, stderr);
    if (!parsed.operatorUrl) {
      const error = new Error("rmux did not return an operator URL");
      error.status = 502;
      throw error;
    }
    const after = await listRmuxWebShares(command);
    const share =
      after.find((item) => !before.has(item.id) && isRmuxShareTargetForPane(item, paneId)) ||
      after.find((item) => !before.has(item.id)) ||
      after.find((item) => isRmuxShareTargetForPane(item, paneId)) ||
      {};
    return {
      ok: true,
      role: "operator",
      target: share.target || paneId,
      shareId: share.id || "",
      operatorUrl: parsed.operatorUrl,
      code: parsed.code,
      expiresAt: parsed.expiresAt || share.expiresAt || "",
      tunnelProvider: parsed.tunnelProvider || provider,
      tunnelUrl: parsed.tunnelUrl || "",
    };
  },
  async readdir(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  },
  // Read a file for the smart content viewer. `baseDir` (the pane's cwd) is used
  // only to resolve a RELATIVE path (so `./foo.md` works); absolute paths and
  // `..` resolve wherever they point. There is no directory confinement — the
  // boundary is the OS file permissions of the user the agent runs as PLUS a
  // configurable denylist (see lib/readfile-deny.mjs) that blocks sensitive
  // files (SSH/cloud keys, .env, …) even when the OS would allow the read.
  // Returns base64 bytes + the real size; truncates to maxBytes.
  async readfile(filePath, { baseDir = "", maxBytes = 5 * 1024 * 1024 } = {}) {
    // Expand a leading ~ to the user's home so "~/notes.md" works.
    let requestedPath = String(filePath);
    if (requestedPath === "~" || requestedPath.startsWith("~/")) {
      requestedPath = path.join(os.homedir(), requestedPath.slice(1));
    }
    // Relative paths resolve against the pane cwd; absolute paths are used as-is.
    const target = baseDir
      ? path.resolve(baseDir, requestedPath)
      : path.resolve(requestedPath);
    // Apply the denylist against the resolved REAL path, so a symlink or `..`
    // pointing at a denied target (e.g. a link to ~/.ssh/id_rsa) can't slip past.
    // Fall back to the lexical target if realpath fails (e.g. broken symlink) so
    // a missing file still reports cleanly below.
    let realTarget = target;
    try {
      realTarget = await realpath(target);
    } catch {}
    if (isDenied(realTarget) || isDenied(target)) {
      const error = new Error("This file is blocked by the server's denylist");
      error.code = "EACCES";
      error.denied = true;
      throw error;
    }
    const info = await stat(target); // ENOENT -> not found, EACCES -> no perms
    if (!info.isFile()) throw new Error("Not a regular file");
    const buffer = await readFile(target);
    const truncated = buffer.length > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return {
      base64: slice.toString("base64"),
      size: info.size,
      truncated,
    };
  },
  // Write an uploaded file to a temp directory on this machine and return its
  // absolute path (for the composer's "attach a file" action). The destination
  // is $TMUX_MOBILE_UPLOAD_DIR, or <os tmpdir>/tmux-mobile-uploads by default.
  // The supplied `name` is reduced to a safe basename; on collision a short
  // numeric suffix is added so an upload never clobbers an existing file.
  async writeTempFile(name, base64) {
    const dir =
      process.env.TMUX_MOBILE_UPLOAD_DIR ||
      path.join(os.tmpdir(), "tmux-mobile-uploads");
    await mkdir(dir, { recursive: true });

    // Safe basename: drop directory components, then keep only a conservative
    // set (word chars, dot, dash, space); everything else -> "_". Fallback "upload".
    const raw = String(name || "").replace(/^.*[/\\]/, "");
    let base = raw.replace(/[^\w.\- ]+/g, "_").trim();
    if (!base || base === "." || base === "..") base = "upload";

    const buffer = Buffer.from(String(base64 || ""), "base64");

    // Avoid clobbering: file, file-1, file-2, … (suffix before the extension).
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let finalName = base;
    let target = path.join(dir, finalName);
    for (let n = 1; ; n += 1) {
      try {
        await stat(target);
      } catch {
        break; // doesn't exist — use it
      }
      finalName = `${stem}-${n}${ext}`;
      target = path.join(dir, finalName);
    }

    await writeFile(target, buffer, { mode: 0o600 });
    return { path: target, name: finalName };
  },
  // Resolve the git "origin" remote of a directory into { host, owner, name }
  // (e.g. github.com / acme / my-repo). Returns empty strings when the
  // dir isn't a git repo, has no origin, or the URL can't be parsed. Used for
  // window metadata (e.g. turning "PR #123" into a GitHub link).
  async repo(dirPath) {
    try {
      const out = await execFileAsync(
        "git",
        ["-C", dirPath, "remote", "get-url", "origin"],
        { timeout: 4000 },
      );
      return parseGitRemote(out.trim());
    } catch {
      return { host: "", owner: "", name: "" };
    }
  },
  // Full command line of the foreground process on a tty (cross-platform, via
  // ps). Used to detect an agent launched through an interpreter — e.g.
  // `node /usr/bin/codex` reports pane_current_command "node", but the argv here
  // is "node /usr/bin/codex --yolo". Returns "" when it can't be determined.
  async paneCommand(tty) {
    const dev = String(tty || "").replace(/^\/dev\//, "");
    if (!dev) return { command: "" };
    try {
      // The foreground process group has a '+' in STAT; take the first such row's
      // command. -ww prevents truncation of the command column.
      const out = await execFileAsync(
        "ps",
        ["-t", dev, "-o", "stat=,command=", "-ww"],
        { timeout: 4000 },
      );
      for (const line of out.split("\n")) {
        const m = line.match(/^\s*(\S+)\s+(.*)$/);
        if (m && m[1].includes("+") && m[2].trim()) {
          return { command: m[2].trim() };
        }
      }
      return { command: "" };
    } catch {
      return { command: "" };
    }
  },
  // Walk the process tree rooted at `rootPid` (BFS over ps output), for the
  // "fork this agent" quick action. Returns the root plus all descendants as
  // {pid, ppid, command}; empty array for a bad pid.
  async processTree(rootPid) {
    const root = Number(rootPid);
    if (!Number.isFinite(root) || root <= 0) return [];

    const out = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
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
      // Branch + git-dir + the shared common-dir in one git invocation. For a
      // linked worktree (created via `git worktree add`) --git-dir resolves to
      // something inside <main>/.git/worktrees/<name>; the main checkout returns
      // plain ".git". --git-common-dir points at the repo all worktrees share —
      // for a bare-repo-backed worktree that's the bare repo itself.
      const out = await execFileAsync(
        "git",
        [
          "-C",
          dirPath,
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
          "--git-dir",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        { timeout: 4000 },
      );
      const [head = "", gitDir = "", commonDir = ""] = out.trim().split("\n");
      const branch = head === "HEAD" ? "" : head; // detached HEAD -> no branch
      const worktree = /\/worktrees\/[^/]+\/?$/.test(gitDir);
      // "bare" means the shared repo is a bare repo — the case where offering a
      // "New branch" worktree makes sense (the canonical bare-repo + sibling
      // worktrees layout). A worktree is itself non-bare; we ask the COMMON dir.
      let bare = false;
      if (worktree && commonDir) {
        try {
          const cfg = await execFileAsync(
            "git",
            ["--git-dir", commonDir, "config", "--get", "core.bare"],
            { timeout: 4000 },
          );
          bare = cfg.trim() === "true";
        } catch {
          bare = false; // core.bare unset / not readable -> treat as non-bare
        }
      }
      return { branch, worktree, bare, commonDir };
    } catch {
      return { branch: "", worktree: false, bare: false, commonDir: "" };
    }
  },
  // Create a new branch in a new git worktree off `fromDir`. The new worktree is
  // a sibling directory named after the branch (the canonical bare-repo layout):
  //   git -C <fromDir> worktree add -b <branch> <parent(fromDir)>/<branch>
  // Returns { path, branch }. Throws on a bad branch name or a git failure
  // (e.g. branch already exists, or the target dir is occupied).
  async worktreeAdd({ fromDir, branch } = {}) {
    const name = String(branch || "").trim();
    // Allow the safe subset of ref characters; reject anything that could escape
    // the dir or confuse git/the shell. No leading dash, no slashes-to-parent,
    // no whitespace or shell metacharacters.
    if (!name || !/^[A-Za-z0-9._\/-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
      const error = new Error("invalid branch name");
      error.status = 400;
      throw error;
    }
    const base = String(fromDir || "").trim();
    if (!base) {
      const error = new Error("missing source directory");
      error.status = 400;
      throw error;
    }
    // Sibling dir named after the branch. A branch with slashes (feature/x) maps
    // to a single basename to keep the layout flat and predictable.
    const dirName = name.replace(/\//g, "-");
    const parent = path.dirname(base.replace(/\/+$/, ""));
    const target = path.join(parent, dirName);
    await execFileAsync(
      "git",
      ["-C", base, "worktree", "add", "-b", name, target],
      { timeout: 20000 },
    );
    return { path: target, branch: name };
  },
  /**
   * Look for a running Codex or Claude Code agent in the descendants of
   * `rootPid` (typically the pane's pid) and return its *structured* latest
   * assistant message — pulled from the agent's own JSONL transcript on
   * disk, not guessed from terminal output.
   *
   * Two transcript-location strategies, in order:
   *   1. `lsof -p <pid>`. Codex keeps its rollout file open for the whole
   *      session, so this is exact and cheap.
   *   2. (Claude only) most-recently-modified `*.jsonl` in
   *      ~/.claude/projects/<encoded-cwd>/. Claude Code opens-appends-closes
   *      per write, so lsof never sees the file. The encoded cwd is just
   *      the path with '/' replaced by '-' (Claude Code's convention).
   *
   * Returns null when neither strategy finds a transcript; the caller is
   * expected to fall back to the capture-pane / LLM-extract path.
   *
   * Args may be `{ rootPid, cwd }` (preferred) or a bare pid (legacy /
   * Codex-only callers).
   */
  async agentLastResponse(arg) {
    const located = await locateAgentTranscript(this, arg);
    if (!located) return null;
    let text = "";
    try {
      const tail = await readFileTail(located.transcriptPath, 256 * 1024);
      text = agentTranscriptLastAssistant(located.kind, tail);
    } catch {}
    return { ...located, text };
  },
  /**
   * Same detection as agentLastResponse but returns every user/assistant
   * turn parsed from the transcript, filtered to clean dialogue (tool
   * calls/results, system reminders, environment context dropped). Used
   * by the in-app transcript viewer so the user has structured access to
   * what's actually been said back and forth, not just the latest reply.
   * Caps at the last MAX_TRANSCRIPT_TURNS to keep responses bounded.
   */
  async agentTranscript(arg) {
    const located = await locateAgentTranscript(this, arg);
    if (!located) return null;
    let turns = [];
    let turnsTotal = 0;
    try {
      // 32 MB tail (was 1 MB) so even multi-hour Claude / Codex sessions are
      // read fully — Claude turns can easily run 50-100 KB each with tool
      // metadata, so 4 MB only fit ~40 of them, which then ALSO pinned the
      // count badge below. The display payload stays bounded by
      // MAX_TRANSCRIPT_TURNS regardless; turnsTotal is the pre-slice count,
      // so the Command Center's "N turns" badge reports the real depth.
      const tail = await readFileTail(located.transcriptPath, 32 * 1024 * 1024);
      const parsed = agentTranscriptTurns(located.kind, tail);
      turns = parsed.turns;
      turnsTotal = parsed.total;
    } catch {}
    return { ...located, turns, turnsTotal };
  },
};

// Detection logic shared by agentLastResponse and agentTranscript: walk the
// process tree under rootPid, find a codex/claude descendant, locate its
// open JSONL via lsof, fall back to mtime in ~/.claude/projects/<cwd>/ for
// Claude. Returns { kind, sessionId, transcriptPath } or null.
async function locateAgentTranscript(backend, arg) {
  const rootPid = typeof arg === "object" && arg !== null ? arg.rootPid : arg;
  const cwd = typeof arg === "object" && arg !== null ? arg.cwd || "" : "";
  const foreground =
    typeof arg === "object" && arg !== null ? String(arg.foregroundCommand || "") : "";

  const tree = await backend.processTree(rootPid);
  if (tree.length === 0) return null;

  const codexCandidates = tree
    .filter((p) => commandHasExecutable(p.command, "codex"))
    .map((p) => ({ kind: "codex", pid: p.pid }));
  const claudeCandidates = tree
    .filter((p) => commandHasExecutable(p.command, "claude"))
    .map((p) => ({ kind: "claude", pid: p.pid }));

  // When a pane's process tree holds BOTH agents — e.g. a Claude session that
  // shelled out to codex, or a leftover codex still holding its rollout file
  // open — prefer whichever the pane is actually running in the FOREGROUND.
  // Without this, the fixed codex-first scan order silently mislabels a
  // foreground Claude pane as Codex. The foreground command is the only signal
  // that says which agent the user is really looking at; trust it for the tie.
  const foregroundKind = commandHasExecutable(foreground, "claude")
    ? "claude"
    : commandHasExecutable(foreground, "codex")
      ? "codex"
      : "";
  const candidates =
    foregroundKind === "claude"
      ? [...claudeCandidates, ...codexCandidates]
      : [...codexCandidates, ...claudeCandidates];

  for (const { kind, pid } of candidates) {
    let transcriptPath = await findOpenTranscriptPath(pid, kind);
    if (!transcriptPath && kind === "claude") {
      transcriptPath = await findClaudeTranscriptFromSessionFile(pid, cwd);
    }
    if (!transcriptPath && kind === "claude" && cwd) {
      transcriptPath = await findRecentClaudeTranscript(cwd);
    }
    if (!transcriptPath) continue;
    return { kind, sessionId: extractSessionUuid(transcriptPath), transcriptPath };
  }
  return null;
}

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
const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findOpenTranscriptPath(pid, kind) {
  let out = "";
  try {
    out = await execFileAsync("lsof", ["-p", String(pid)], {
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return "";
  }
  return selectNewestOpenTranscriptPath(out, kind);
}

export async function selectNewestOpenTranscriptPath(lsofOutput, kind, statFile = stat) {
  const pattern = TRANSCRIPT_PATTERNS[kind];
  if (!pattern) return "";
  const globalPattern = new RegExp(pattern.source, "g");
  const paths = [];
  const seen = new Set();
  for (const match of String(lsofOutput || "").matchAll(globalPattern)) {
    const transcriptPath = match[1];
    if (!transcriptPath || seen.has(transcriptPath)) continue;
    seen.add(transcriptPath);
    paths.push(transcriptPath);
  }
  if (paths.length === 0) return "";
  if (paths.length === 1) return paths[0];

  const ranked = await Promise.all(
    paths.map(async (transcriptPath, index) => {
      try {
        const info = await statFile(transcriptPath);
        return { transcriptPath, index, mtimeMs: Number(info.mtimeMs || 0) };
      } catch {
        return { transcriptPath, index, mtimeMs: 0 };
      }
    }),
  );
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs || a.index - b.index);
  return ranked[0]?.transcriptPath || "";
}

async function readBackendText(backend, filePath, { maxBytes, baseDir = "" } = {}) {
  if (typeof backend?.readfile !== "function") return null;
  const result = await backend.readfile(filePath, { baseDir, maxBytes });
  return {
    text: Buffer.from(result.base64 || "", "base64").toString("utf8"),
    size: Number(result.size || 0),
    truncated: Boolean(result.truncated),
  };
}

function claudeProjectDir(cwd, homeDir = os.homedir()) {
  if (!cwd) return "";
  return path.join(homeDir, ".claude", "projects", cwd.replace(/\//g, "-"));
}

function claudeProjectPath(cwd, sessionId, homePrefix = "~") {
  return path.posix.join(
    homePrefix,
    ".claude",
    "projects",
    cwd.replace(/\//g, "-"),
    `${sessionId}.jsonl`,
  );
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// Claude Code 2.x writes a lightweight pid -> session record here:
// ~/.claude/sessions/<pid>.json
// This is the exact mapping we need when multiple Claude sessions share the same
// cwd. The older cwd-mtime fallback below otherwise picks the most recently
// updated transcript for every pane in that directory.
export async function findClaudeTranscriptFromSessionFile(
  pid,
  cwd = "",
  { homeDir = os.homedir(), exists = fileExists } = {},
) {
  const sessionInfoPath = path.join(homeDir, ".claude", "sessions", `${pid}.json`);
  let sessionInfo;
  try {
    sessionInfo = JSON.parse(await readFile(sessionInfoPath, "utf8"));
  } catch {
    return "";
  }
  if (Number(sessionInfo?.pid) !== Number(pid)) return "";
  const sessionId = String(sessionInfo?.sessionId || "");
  if (!UUID_EXACT_RE.test(sessionId)) return "";

  const sessionCwd = String(sessionInfo?.cwd || "");
  if (cwd && sessionCwd && !samePath(sessionCwd, cwd)) return "";
  const transcriptCwd = sessionCwd || cwd;
  if (!transcriptCwd) return "";

  const transcriptPath = path.join(claudeProjectDir(transcriptCwd, homeDir), `${sessionId}.jsonl`);
  return (await exists(transcriptPath)) ? transcriptPath : "";
}

export async function findClaudeSessionFromBackend(backend, arg) {
  const rootPid = typeof arg === "object" && arg !== null ? arg.rootPid : arg;
  const cwd = typeof arg === "object" && arg !== null ? arg.cwd || "" : "";
  if (!rootPid || typeof backend?.processTree !== "function" || typeof backend?.readfile !== "function") {
    return null;
  }

  const tree = await backend.processTree(rootPid);
  const candidates = tree
    .filter((p) => commandHasExecutable(p.command, "claude"))
    .map((p) => p.pid);
  for (const pid of candidates) {
    let sessionInfo;
    try {
      const data = await readBackendText(backend, `~/.claude/sessions/${pid}.json`, {
        maxBytes: 64 * 1024,
      });
      sessionInfo = JSON.parse(data?.text || "");
    } catch {
      continue;
    }
    if (Number(sessionInfo?.pid) !== Number(pid)) continue;
    const sessionId = String(sessionInfo?.sessionId || "");
    if (!UUID_EXACT_RE.test(sessionId)) continue;
    const sessionCwd = String(sessionInfo?.cwd || "");
    if (cwd && sessionCwd && !samePath(sessionCwd, cwd)) continue;
    const transcriptCwd = sessionCwd || cwd;
    if (!transcriptCwd) continue;
    return {
      kind: "claude",
      pid,
      sessionId,
      cwd: transcriptCwd,
      transcriptPath: claudeProjectPath(transcriptCwd, sessionId),
    };
  }
  return null;
}

export async function readClaudeTranscriptFromSession(backend, session, { maxBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
  if (!session?.sessionId || !session?.cwd || typeof backend?.readfile !== "function") return null;
  const transcriptPath = session.transcriptPath || claudeProjectPath(session.cwd, session.sessionId);
  const data = await readBackendText(backend, transcriptPath, { maxBytes });
  if (!data || data.truncated) return null;
  const parsed = agentTranscriptTurns("claude", data.text);
  return {
    kind: "claude",
    sessionId: session.sessionId,
    transcriptPath,
    turns: parsed.turns,
    turnsTotal: parsed.total,
  };
}

/**
 * Find the most-recently-modified Claude Code transcript for a given working
 * directory. Used as fallback when lsof comes up empty (Claude writes its
 * jsonl in short-lived opens, so lsof never sees it).
 *
 *   cwd "/Users/homo/src/tmux-mobile"
 *     → ~/.claude/projects/-Users-homo-src-tmux-mobile/<uuid>.jsonl
 *
 * The mtime heuristic picks whichever session was last appended to — the
 * one the running claude process is actively talking on. If the user has
 * multiple parallel sessions in the same cwd we'll still pick the most
 * recently active, which is the right answer for "Read me the last reply."
 */
async function findRecentClaudeTranscript(cwd) {
  if (!cwd) return "";
  const dir = claudeProjectDir(cwd);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const candidates = entries.filter(
    (entry) => !entry.isDirectory() && entry.name.endsWith(".jsonl"),
  );
  if (candidates.length === 0) return "";

  const stats = await Promise.all(
    candidates.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      try {
        const info = await stat(filePath);
        return { path: filePath, mtimeMs: info.mtimeMs };
      } catch {
        return { path: filePath, mtimeMs: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0].path;
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

const MAX_TRANSCRIPT_TURNS = 40;
const TRANSCRIPT_TAIL_BYTES = 32 * 1024 * 1024;

/**
 * Parse a transcript tail (Claude or Codex JSONL) into a clean list of
 * {role, text, t?} turns suitable for a user-facing transcript view.
 *
 * Filters out:
 *   - tool_use / tool_result content blocks
 *   - thinking / reasoning blocks
 *   - records whose text payload is empty after filtering
 *   - "system" user messages: <environment_context>, <system-reminder>,
 *     [Request interrupted by user], Caveat: prefixes (CC injects these
 *     into the user-role record but they aren't actual user input)
 *
 * Returns { turns, total } in chronological order. `turns` is capped at the
 * last MAX_TRANSCRIPT_TURNS so the response stays bounded for long sessions.
 * `total` is the un-capped count (within the tail window) — the Command
 * Center surfaces this so its "N turns" badge isn't pinned at the slice
 * length; the in-app transcript viewer uses the `turns` array directly.
 */
function agentTranscriptTurns(kind, jsonlText) {
  const lines = jsonlText.split("\n");
  // If we started mid-line (tail boundary), drop the first incomplete row.
  if (lines.length && jsonlText.length === TRANSCRIPT_TAIL_BYTES) lines.shift();
  const turns = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const turn = kind === "codex"
      ? turnFromCodexRecord(obj)
      : turnFromClaudeRecord(obj);
    if (turn) turns.push(turn);
  }
  return {
    turns: turns.slice(-MAX_TRANSCRIPT_TURNS),
    total: turns.length,
  };
}

// Claude Code's user-role record is a catch-all: real user prompts share it
// with tool results, command echoes, environment context, system reminders,
// interrupt notices, caveats — anything the CLI needs to push into the
// turn stream. Detect injected text rather than enumerating every wrapper
// tag (Claude keeps adding new ones):
//   - Anything starting with an XML-style tag like <foo> or <foo-bar> is a
//     wrapper Claude Code uses for system-injected content
//     (<environment_context>, <system-reminder>, <local-command-stdout>,
//     <local-command-caveat>, <command-name>, <command-message>, …).
//   - "[Request interrupted by user]" is what gets stamped when you cancel.
//   - "Caveat:" prefixes the explanatory note Claude leaves for itself.
const INJECTED_OPENING_TAG_RE = /^<[a-zA-Z][\w-]*>/;

function isInjectedUserText(text) {
  const trimmed = text.trimStart();
  if (INJECTED_OPENING_TAG_RE.test(trimmed)) return true;
  if (trimmed.startsWith("[Request interrupted by user]")) return true;
  if (trimmed.startsWith("Caveat:")) return true;
  return false;
}

function turnFromClaudeRecord(obj) {
  const message = obj?.message;
  if (!message) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((c) => c && c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  if (role === "user" && isInjectedUserText(text)) return null;
  return obj.timestamp ? { role, text, t: obj.timestamp } : { role, text };
}

function turnFromCodexRecord(obj) {
  if (obj?.type !== "response_item") return null;
  const payload = obj.payload;
  if (!payload || payload.type !== "message") return null;
  const role = payload.role;
  if (role !== "user" && role !== "assistant") return null;
  const content = payload.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (c) =>
          c && (c.type === "input_text" || c.type === "output_text" || c.type === "text"),
      )
      .map((c) => c.text || "")
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  if (role === "user" && isInjectedUserText(text)) return null;
  return obj.timestamp ? { role, text, t: obj.timestamp } : { role, text };
}
