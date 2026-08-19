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
import { authorizeSshPublicKeyForCurrentUser } from "./ssh-authorized-keys.mjs";
import { detectSshHostCandidates } from "./ssh-hosts.mjs";

const backendStore = new AsyncLocalStorage();
const MUX_COMMANDS = new Set(["tmux", "rmux"]);

// Where composer file uploads land: $TMUX_MOBILE_UPLOAD_DIR, or
// <os tmpdir>/tmux-mobile-uploads by default. Uploaded files are transient temp
// artifacts — their absolute paths are appended into the message box so the
// agent can read them, but they are NOT meaningful working directories or
// commands. Exported so other layers can recognize (and ignore) upload paths;
// e.g. window duplication strips a stale upload path out of the prefilled
// command so a duplicate re-runs the bare agent, not a codex invocation with a
// dead /tmp/tmux-mobile-uploads/IMG_1113.jpeg argument.
export function uploadDir() {
  return (
    process.env.TMUX_MOBILE_UPLOAD_DIR ||
    path.join(os.tmpdir(), "tmux-mobile-uploads")
  );
}

// True if `p` points inside the upload temp dir (an attached-file artifact).
export function isUploadPath(p) {
  const text = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (!text) return false;
  const dir = uploadDir();
  return text === dir || text.startsWith(dir + path.sep) || text.startsWith(dir + "/");
}

// Remove whitespace-separated tokens that are upload-temp-dir paths from a
// command line, so a replayed/prefilled command doesn't carry a stale attached
// file (e.g. `codex /tmp/tmux-mobile-uploads/IMG_1113.jpeg` -> `codex`).
// Returns the cleaned command, trimmed. If stripping empties it, returns "".
export function stripUploadPathsFromCommand(command) {
  const text = String(command || "").trim();
  if (!text) return "";
  const kept = text.split(/\s+/).filter((token) => !isUploadPath(token));
  return kept.join(" ").trim();
}
// Two default inventory intervals: a same-process Codex `/new` changes open
// rollouts without changing the pid/command signature, so keep this short
// enough for the card to follow while still avoiding per-round lsof work.
const AGENT_OPEN_FILES_CACHE_TTL_MS = 8_000;
const TRANSCRIPT_SNAPSHOT_CACHE_MAX_ENTRIES = 64;
const TRANSCRIPT_SNAPSHOT_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const TRANSCRIPT_PENDING_MAX_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_BOUNDARY_BYTES = 4 * 1024;
const agentOpenFilesCache = {
  signature: "",
  checkedAt: 0,
  byPid: new Map(),
};
const codexTranscriptSourceCache = new Map();
const transcriptSnapshotCache = new Map();
const transcriptSnapshotLoads = new Map();
let transcriptSnapshotCacheBytes = 0;
const transcriptSnapshotMetrics = {
  cacheHits: 0,
  rebuilds: 0,
  appends: 0,
  bytesRead: 0,
};

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

export function processTreeFromSnapshot(processes, rootPid) {
  const root = Number(rootPid);
  if (!Number.isFinite(root) || root <= 0 || !Array.isArray(processes)) return [];

  const processesById = new Map();
  const childrenByParent = new Map();
  for (const processInfo of processes) {
    const pid = Number(processInfo?.pid);
    const ppid = Number(processInfo?.ppid);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(ppid)) continue;
    const normalized = {
      pid,
      ppid,
      command: String(processInfo?.command || ""),
    };
    processesById.set(pid, normalized);
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid).push(normalized);
  }

  const first = processesById.get(root);
  if (!first) return [];
  const result = [];
  const queue = [first];
  const seen = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const processInfo = queue[index];
    if (!processInfo || seen.has(processInfo.pid)) continue;
    seen.add(processInfo.pid);
    result.push(processInfo);
    queue.push(...(childrenByParent.get(processInfo.pid) || []));
  }
  return result;
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

function execFileCaptureAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        timeout: options.timeout ?? 10000,
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: stdout || "", stderr: stderr || "" });
      },
    );
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
  async authorizeSshKey({ publicKey, marker } = {}) {
    const systemHostname = os.hostname();
    const sshHosts = await detectSshHostCandidates({ systemHostname });
    return authorizeSshPublicKeyForCurrentUser(
      { publicKey, marker },
      { systemHostname, sshHosts },
    );
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
    const requestedMaxBytes = Number(maxBytes);
    const limit =
      Number.isFinite(requestedMaxBytes) && requestedMaxBytes >= 0
        ? Math.floor(requestedMaxBytes)
        : 5 * 1024 * 1024;
    const handle = await open(target, "r"); // ENOENT / EACCES retain their OS codes
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Not a regular file");
      const length = Math.min(info.size, limit);
      const buffer = await readHandleRange(handle, 0, length);
      return {
        base64: buffer.toString("base64"),
        size: info.size,
        truncated: info.size > length,
      };
    } finally {
      await handle.close();
    }
  },
  // Write an uploaded file to a temp directory on this machine and return its
  // absolute path (for the composer's "attach a file" action). The destination
  // is $TMUX_MOBILE_UPLOAD_DIR, or <os tmpdir>/tmux-mobile-uploads by default.
  // The supplied `name` is reduced to a safe basename; on collision a short
  // numeric suffix is added so an upload never clobbers an existing file.
  async writeTempFile(name, base64) {
    const dir = uploadDir();
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
  async processSnapshot() {
    const out = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return out
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
  },
  async processTree(rootPid) {
    return processTreeFromSnapshot(await this.processSnapshot(), rootPid);
  },
  async agentOpenFilesSnapshot(processes) {
    return loadAgentOpenFilesSnapshot(processes);
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
      // The first observation reads at most the existing 32 MB tail. Later
      // observations stat the file and parse only appended, newline-complete
      // bytes. This keeps Command Center inventory proportional to changes,
      // rather than to every active session's accumulated history.
      const parsed = await readLocalAgentTranscript(
        located.kind,
        located.transcriptPath,
      );
      turns = parsed.turns;
      turnsTotal = parsed.total;
    } catch {}
    return { ...located, turns, turnsTotal };
  },
};

function agentProcessesFromSnapshot(processes) {
  const byPid = new Map();
  for (const processInfo of processes || []) {
    const command = String(processInfo?.command || "");
    if (
      !commandHasExecutable(command, "codex") &&
      !commandHasExecutable(command, "claude")
    ) {
      continue;
    }
    const pid = Number(processInfo?.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    byPid.set(pid, { pid, command });
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

function parseLsofFieldOutput(output) {
  const byPid = new Map();
  let currentPid = 0;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (line.startsWith("p")) {
      currentPid = Number(line.slice(1)) || 0;
      if (currentPid && !byPid.has(currentPid)) byPid.set(currentPid, []);
      continue;
    }
    if (!currentPid || !line.startsWith("n")) continue;
    const filePath = line.slice(1);
    if (
      !filePath.endsWith(".jsonl") ||
      (!filePath.includes("/.codex/sessions/") &&
        !filePath.includes("/.claude/projects/"))
    ) {
      continue;
    }
    const paths = byPid.get(currentPid);
    if (!paths.includes(filePath)) paths.push(filePath);
  }
  return byPid;
}

async function loadAgentOpenFilesSnapshot(processes) {
  const candidates = agentProcessesFromSnapshot(processes);
  const signature = candidates
    .map(({ pid, command }) => `${pid}:${command}`)
    .join("\n");
  if (
    agentOpenFilesCache.signature === signature &&
    Date.now() - agentOpenFilesCache.checkedAt < AGENT_OPEN_FILES_CACHE_TTL_MS
  ) {
    return agentOpenFilesCache.byPid;
  }
  if (candidates.length === 0) {
    agentOpenFilesCache.signature = signature;
    agentOpenFilesCache.checkedAt = Date.now();
    agentOpenFilesCache.byPid = new Map();
    return agentOpenFilesCache.byPid;
  }

  const { error, stdout } = await execFileCaptureAsync(
    "lsof",
    ["-a", "-p", candidates.map(({ pid }) => pid).join(","), "-Fpn"],
    { timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
  );
  // lsof exits 1 when a requested pid disappears (or no selected files
  // remain), while still returning valid records for the other pids. Accept
  // only that ordinary exit status. A timeout/maxBuffer kill can also carry
  // partial stdout; caching it would hide every pid not reached by lsof for
  // the full TTL, so make the caller fall back instead.
  const usableExitOne =
    error &&
    Number(error.code) === 1 &&
    !error.killed &&
    !error.signal;
  if (error && !usableExitOne) throw error;
  agentOpenFilesCache.signature = signature;
  agentOpenFilesCache.checkedAt = Date.now();
  agentOpenFilesCache.byPid = parseLsofFieldOutput(stdout);
  return agentOpenFilesCache.byPid;
}

// Detection logic shared by agentLastResponse and agentTranscript: walk the
// process tree under rootPid, find a codex/claude descendant, locate its
// open JSONL via lsof, fall back to mtime in ~/.claude/projects/<cwd>/ for
// Claude. Returns { kind, sessionId, transcriptPath } or null.
async function locateAgentTranscript(backend, arg) {
  const rootPid = typeof arg === "object" && arg !== null ? arg.rootPid : arg;
  const cwd = typeof arg === "object" && arg !== null ? arg.cwd || "" : "";
  const foreground =
    typeof arg === "object" && arg !== null ? String(arg.foregroundCommand || "") : "";
  const suppliedProcesses =
    typeof arg === "object" && arg !== null && Array.isArray(arg.processes)
      ? arg.processes
      : null;
  const suppliedOpenFiles =
    typeof arg === "object" && arg !== null && arg.openFiles instanceof Map
      ? arg.openFiles
      : null;

  const tree = suppliedProcesses || (await backend.processTree(rootPid));
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
  const groups =
    foregroundKind === "claude"
      ? [
          { kind: "claude", candidates: claudeCandidates },
          { kind: "codex", candidates: codexCandidates },
        ]
      : [
          { kind: "codex", candidates: codexCandidates },
          { kind: "claude", candidates: claudeCandidates },
        ];
  let located = null;
  for (const { kind, candidates } of groups) {
    if (candidates.length === 0) continue;
    let transcriptPath = "";
    if (kind === "claude") {
      // Claude publishes an exact pid -> session id file. Prefer it to lsof:
      // Claude normally opens/appends/closes JSONL files, so lsof is both
      // expensive and usually empty.
      for (const { pid } of candidates) {
        transcriptPath = await findClaudeTranscriptFromSessionFile(pid, cwd);
        if (transcriptPath) break;
      }
    }
    if (!transcriptPath) {
      // Preserve candidate priority: a pane can contain a backgrounded second
      // agent whose rollout is newer, but the first matching process in the
      // pane tree is still the session represented by the card.
      for (const { pid } of candidates) {
        transcriptPath = suppliedOpenFiles
          ? await selectPreferredOpenTranscriptPaths(
              suppliedOpenFiles.get(pid) || [],
              kind,
            )
          : await findOpenTranscriptPath(pid, kind);
        if (transcriptPath) break;
      }
    }
    if (!transcriptPath && kind === "claude" && cwd) {
      transcriptPath = await findRecentClaudeTranscript(cwd);
    }
    if (!transcriptPath) continue;
    located = {
      kind,
      sessionId: extractSessionUuid(transcriptPath),
      transcriptPath,
    };
    break;
  }
  return located;
}

// Match the executable name in a foreground command line. An agent launched
// through an interpreter reports argv like `node …/codex …`, not a bare
// `codex`, so we match the name in three shapes:
//   1. whole token   — `codex`, `/usr/bin/codex`, `codex --flag`
//   2. path segment  — `…/codex/…` (e.g. node …/@openai/codex/dist/cli.js) —
//      the modern npm install runs `node <pkg>/…/cli.js`, so the executable
//      name only survives as the PACKAGE DIRECTORY. Without this a Codex
//      session was mislabeled as plain "node" (its `pane_current_command`),
//      which broke the window title AND the Codex-specific UI (Answer question).
//   3. filename stem — `…/codex.js` / `.mjs` / `.cjs`
// All three keep `codex` bounded by `/`, whitespace, or an extension, so
// unrelated names like `codex-cli`, `codextools/`, or `codex-notes.md` do NOT
// match. Kept local to backend.mjs so the agent (cloud mode) needn't import
// server.mjs.
function commandHasExecutable(command, executable) {
  const cmd = String(command || "");
  const esc = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asToken = new RegExp(`(^|[\\s/])${esc}([\\s]|$)`, "i");
  const asSegment = new RegExp(`[\\s/]${esc}/`, "i");
  const asFile = new RegExp(`(^|[\\s/])${esc}\\.(?:c|m)?js([\\s]|$)`, "i");
  return asToken.test(cmd) || asSegment.test(cmd) || asFile.test(cmd);
}

const TRANSCRIPT_PATTERNS = {
  codex: /(\/[^\s"']+\.codex\/sessions\/[^\s"']+\.jsonl)/,
  claude: /(\/[^\s"']+\.claude\/projects\/[^\s"']+\.jsonl)/,
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findOpenTranscriptPath(pids, kind) {
  const ids = [...new Set((Array.isArray(pids) ? pids : [pids]).map(Number))]
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  if (ids.length === 0) return "";
  let out = "";
  try {
    out = await execFileAsync("lsof", ["-p", ids.join(",")], {
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return "";
  }
  const pattern = TRANSCRIPT_PATTERNS[kind];
  if (!pattern) return "";
  const paths = transcriptPathsFromLsof(out, pattern);
  return selectPreferredOpenTranscriptPaths(paths, kind);
}

function transcriptPathsFromLsof(lsofOutput, pattern) {
  const globalPattern = new RegExp(pattern.source, "g");
  const paths = [];
  const seen = new Set();
  for (const match of String(lsofOutput || "").matchAll(globalPattern)) {
    const transcriptPath = match[1];
    if (!transcriptPath || seen.has(transcriptPath)) continue;
    seen.add(transcriptPath);
    paths.push(transcriptPath);
  }
  return paths;
}

async function codexTranscriptSourceRank(transcriptPath) {
  if (codexTranscriptSourceCache.has(transcriptPath)) {
    return codexTranscriptSourceCache.get(transcriptPath);
  }
  let rank = 1;
  let cacheable = false;
  let handle = null;
  try {
    handle = await open(transcriptPath, "r");
    const info = await handle.stat();
    const prefix = await readHandleRange(handle, 0, Math.min(info.size, 64 * 1024));
    const newline = prefix.indexOf(0x0a);
    const firstLine = prefix.subarray(0, newline >= 0 ? newline : prefix.length).toString("utf8");
    const record = JSON.parse(firstLine);
    if (record?.type === "session_meta") {
      cacheable = true;
      const source = record.payload?.source;
      if (source && typeof source === "object" && source.subagent) {
        rank = 2;
      } else if (source) {
        rank = 0;
      }
    }
  } catch {
    rank = 1;
  } finally {
    await handle?.close().catch(() => {});
  }
  // A rollout can appear in lsof before Codex finishes writing session_meta.
  // Cache only a successfully parsed immutable header; otherwise retry on the
  // next inventory instead of pinning this path to an "unknown" rank forever.
  if (cacheable) {
    codexTranscriptSourceCache.set(transcriptPath, rank);
    while (codexTranscriptSourceCache.size > 512) {
      codexTranscriptSourceCache.delete(codexTranscriptSourceCache.keys().next().value);
    }
  }
  return rank;
}

async function selectPreferredOpenTranscriptPaths(paths, kind, statFile = stat) {
  const pattern = TRANSCRIPT_PATTERNS[kind];
  if (!pattern) return "";
  const uniquePaths = [
    ...new Set(
      (paths || []).filter(
        (item) => item && pattern.test(String(item)),
      ),
    ),
  ];
  if (uniquePaths.length === 0) return "";
  if (uniquePaths.length === 1) return uniquePaths[0];
  const ranked = await Promise.all(
    uniquePaths.map(async (transcriptPath, index) => {
      let mtimeMs = 0;
      try {
        const info = await statFile(transcriptPath);
        mtimeMs = Number(info.mtimeMs || 0);
      } catch {}
      const sourceRank =
        kind === "codex" ? await codexTranscriptSourceRank(transcriptPath) : 0;
      return { transcriptPath, index, mtimeMs, sourceRank };
    }),
  );
  ranked.sort(
    (left, right) =>
      left.sourceRank - right.sourceRank ||
      right.mtimeMs - left.mtimeMs ||
      left.index - right.index,
  );
  return ranked[0]?.transcriptPath || "";
}

export async function selectNewestOpenTranscriptPath(lsofOutput, kind, statFile = stat) {
  const pattern = TRANSCRIPT_PATTERNS[kind];
  if (!pattern) return "";
  const paths = transcriptPathsFromLsof(lsofOutput, pattern);
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
  const suppliedProcesses =
    typeof arg === "object" && arg !== null && Array.isArray(arg.processes)
      ? arg.processes
      : null;
  if (!rootPid || typeof backend?.processTree !== "function" || typeof backend?.readfile !== "function") {
    return null;
  }

  const tree = suppliedProcesses || (await backend.processTree(rootPid));
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
  if (backend === localBackend) {
    const parsed = await readLocalAgentTranscript("claude", transcriptPath, {
      maxBytes,
    });
    return {
      kind: "claude",
      sessionId: session.sessionId,
      transcriptPath,
      turns: parsed.turns,
      turnsTotal: parsed.total,
    };
  }
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

function expandLocalPath(filePath) {
  const requested = String(filePath || "");
  if (requested === "~" || requested.startsWith("~/")) {
    return path.join(os.homedir(), requested.slice(1));
  }
  return path.resolve(requested);
}

async function readHandleRange(handle, start, length) {
  const requestedLength = Math.max(0, Math.floor(Number(length) || 0));
  if (requestedLength === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(requestedLength);
  let offset = 0;
  while (offset < requestedLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      requestedLength - offset,
      Number(start) + offset,
    );
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return offset === requestedLength ? buffer : buffer.subarray(0, offset);
}

function transcriptFileStamp(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mtimeNs: String(info.mtimeNs ?? info.mtimeMs),
  };
}

function sameTranscriptFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function splitCompleteJsonl(
  buffer,
  { dropUntilNewline = false, pendingMaxBytes = TRANSCRIPT_PENDING_MAX_BYTES } = {},
) {
  let candidate = buffer;
  let dropping = dropUntilNewline;
  if (dropping) {
    const firstNewline = candidate.indexOf(0x0a);
    if (firstNewline < 0) {
      return {
        complete: Buffer.alloc(0),
        pending: Buffer.alloc(0),
        dropUntilNewline: true,
        pendingOverflow: false,
      };
    }
    candidate = candidate.subarray(firstNewline + 1);
    dropping = false;
  }

  const lastNewline = candidate.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    if (candidate.length > pendingMaxBytes) {
      return {
        complete: Buffer.alloc(0),
        pending: Buffer.alloc(0),
        dropUntilNewline: true,
        pendingOverflow: true,
      };
    }
    return {
      complete: Buffer.alloc(0),
      pending: Buffer.from(candidate),
      dropUntilNewline: dropping,
      pendingOverflow: false,
    };
  }
  const pendingLength = candidate.length - lastNewline - 1;
  return {
    complete: candidate.subarray(0, lastNewline + 1),
    pending:
      pendingLength <= pendingMaxBytes
        ? Buffer.from(candidate.subarray(lastNewline + 1))
        : Buffer.alloc(0),
    // An incomplete JSONL record larger than the pending cap is discarded.
    // The snapshot is marked for a bounded rebuild after the file changes, so
    // a later newline can recover the complete record without retaining its
    // multi-megabyte partial bytes between inventories.
    dropUntilNewline: dropping || pendingLength > pendingMaxBytes,
    pendingOverflow: pendingLength > pendingMaxBytes,
  };
}

function transcriptSnapshotResult(entry) {
  return { turns: entry.turns, total: entry.total };
}

function transcriptSnapshotBytes(entry) {
  let bytes =
    512 +
    Number(entry?.pending?.length || 0) +
    Number(entry?.boundary?.length || 0);
  for (const turn of entry?.turns || []) {
    bytes +=
      128 +
      Buffer.byteLength(String(turn?.role || ""), "utf8") +
      Buffer.byteLength(String(turn?.text || ""), "utf8") +
      Buffer.byteLength(String(turn?.t || ""), "utf8");
  }
  return bytes;
}

function removeTranscriptSnapshot(key) {
  const entry = transcriptSnapshotCache.get(key);
  if (!entry) return;
  transcriptSnapshotCache.delete(key);
  transcriptSnapshotCacheBytes = Math.max(
    0,
    transcriptSnapshotCacheBytes - Number(entry._cacheBytes || 0),
  );
}

function touchTranscriptSnapshot(key, entry) {
  removeTranscriptSnapshot(key);
  entry._cacheBytes = transcriptSnapshotBytes(entry);
  transcriptSnapshotCache.set(key, entry);
  transcriptSnapshotCacheBytes += entry._cacheBytes;
  while (
    transcriptSnapshotCache.size > TRANSCRIPT_SNAPSHOT_CACHE_MAX_ENTRIES ||
    transcriptSnapshotCacheBytes > TRANSCRIPT_SNAPSHOT_CACHE_MAX_BYTES
  ) {
    removeTranscriptSnapshot(transcriptSnapshotCache.keys().next().value);
  }
}

function transcriptBoundary(buffer) {
  return Buffer.from(buffer.subarray(Math.max(0, buffer.length - TRANSCRIPT_BOUNDARY_BYTES)));
}

async function rebuildTranscriptSnapshot(handle, stamp, kind, maxBytes) {
  const length = Math.min(stamp.size, maxBytes);
  const start = stamp.size - length;
  const raw = await readHandleRange(handle, start, length);
  transcriptSnapshotMetrics.bytesRead += raw.length;

  let candidate = raw;
  let dropUntilNewline = false;
  if (start > 0) {
    const firstNewline = candidate.indexOf(0x0a);
    if (firstNewline < 0) {
      candidate = Buffer.alloc(0);
      dropUntilNewline = true;
    } else {
      candidate = candidate.subarray(firstNewline + 1);
    }
  }
  const split = splitCompleteJsonl(candidate, {
    dropUntilNewline,
    pendingMaxBytes: Math.min(maxBytes, TRANSCRIPT_PENDING_MAX_BYTES),
  });
  const parsed = agentTranscriptTurnsFromCompleteJsonl(
    kind,
    split.complete.toString("utf8"),
  );
  transcriptSnapshotMetrics.rebuilds += 1;
  return {
    ...stamp,
    kind,
    maxBytes,
    turns: parsed.turns,
    total: parsed.total,
    pending: split.pending,
    dropUntilNewline: split.dropUntilNewline,
    forceRebuild: split.pendingOverflow,
    boundary: transcriptBoundary(raw),
  };
}

async function appendTranscriptSnapshot(handle, previous, stamp) {
  const boundaryStart = previous.size - previous.boundary.length;
  const currentBoundary = await readHandleRange(
    handle,
    boundaryStart,
    previous.boundary.length,
  );
  transcriptSnapshotMetrics.bytesRead += currentBoundary.length;
  if (!currentBoundary.equals(previous.boundary)) return null;

  const deltaLength = stamp.size - previous.size;
  if (deltaLength > previous.maxBytes) return null;
  const delta = await readHandleRange(handle, previous.size, deltaLength);
  transcriptSnapshotMetrics.bytesRead += delta.length;
  if (delta.length !== deltaLength) return null;

  const split = splitCompleteJsonl(Buffer.concat([previous.pending, delta]), {
    dropUntilNewline: previous.dropUntilNewline,
    pendingMaxBytes: Math.min(
      previous.maxBytes,
      TRANSCRIPT_PENDING_MAX_BYTES,
    ),
  });
  const parsed = agentTranscriptTurnsFromCompleteJsonl(
    previous.kind,
    split.complete.toString("utf8"),
  );
  const boundary = transcriptBoundary(Buffer.concat([previous.boundary, delta]));
  transcriptSnapshotMetrics.appends += 1;
  return {
    ...stamp,
    kind: previous.kind,
    maxBytes: previous.maxBytes,
    turns: [...previous.turns, ...parsed.turns].slice(-MAX_TRANSCRIPT_TURNS),
    total: previous.total + parsed.total,
    pending: split.pending,
    dropUntilNewline: split.dropUntilNewline,
    forceRebuild: split.pendingOverflow,
    boundary,
  };
}

async function loadLocalAgentTranscript(kind, resolvedPath, maxBytes, key) {
  const handle = await open(resolvedPath, "r");
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error("Not a regular file");
    const stamp = transcriptFileStamp(info);
    const previous = transcriptSnapshotCache.get(key);
    if (
      previous &&
      sameTranscriptFile(previous, stamp) &&
      previous.size === stamp.size &&
      previous.mtimeNs === stamp.mtimeNs
    ) {
      transcriptSnapshotMetrics.cacheHits += 1;
      touchTranscriptSnapshot(key, previous);
      return transcriptSnapshotResult(previous);
    }

    let next = null;
    if (
      previous &&
      sameTranscriptFile(previous, stamp) &&
      stamp.size > previous.size &&
      !previous.forceRebuild
    ) {
      next = await appendTranscriptSnapshot(handle, previous, stamp);
    }
    if (!next) {
      next = await rebuildTranscriptSnapshot(handle, stamp, kind, maxBytes);
    }
    touchTranscriptSnapshot(key, next);
    return transcriptSnapshotResult(next);
  } finally {
    await handle.close();
  }
}

export async function readLocalAgentTranscript(
  kind,
  filePath,
  { maxBytes = TRANSCRIPT_TAIL_BYTES } = {},
) {
  const normalizedKind = String(kind || "").toLowerCase();
  if (normalizedKind !== "codex" && normalizedKind !== "claude") {
    throw new TypeError(`Unsupported transcript kind: ${normalizedKind || "(empty)"}`);
  }
  const numericMaxBytes = Number(maxBytes);
  const limit =
    Number.isFinite(numericMaxBytes) && numericMaxBytes > 0
      ? Math.floor(numericMaxBytes)
      : TRANSCRIPT_TAIL_BYTES;
  const resolvedPath = expandLocalPath(filePath);
  const key = `${normalizedKind}\0${resolvedPath}\0${limit}`;
  if (transcriptSnapshotLoads.has(key)) return transcriptSnapshotLoads.get(key);
  const load = loadLocalAgentTranscript(normalizedKind, resolvedPath, limit, key);
  transcriptSnapshotLoads.set(key, load);
  try {
    return await load;
  } finally {
    if (transcriptSnapshotLoads.get(key) === load) transcriptSnapshotLoads.delete(key);
  }
}

export function resetAgentTranscriptSnapshotCache() {
  transcriptSnapshotCache.clear();
  transcriptSnapshotLoads.clear();
  transcriptSnapshotCacheBytes = 0;
  transcriptSnapshotMetrics.cacheHits = 0;
  transcriptSnapshotMetrics.rebuilds = 0;
  transcriptSnapshotMetrics.appends = 0;
  transcriptSnapshotMetrics.bytesRead = 0;
}

export function agentTranscriptSnapshotMetrics() {
  return {
    ...transcriptSnapshotMetrics,
    entries: transcriptSnapshotCache.size,
    bufferedBytes: transcriptSnapshotCacheBytes,
  };
}

async function readFileTail(filePath, maxBytes) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const start = stats.size - length;
    const buffer = await readHandleRange(handle, start, length);
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
function agentTranscriptTurnsFromCompleteJsonl(kind, jsonlText) {
  const lines = jsonlText.split("\n");
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

function agentTranscriptTurns(kind, jsonlText) {
  return agentTranscriptTurnsFromCompleteJsonl(kind, jsonlText);
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
