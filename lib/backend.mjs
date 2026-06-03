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

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDenied } from "./readfile-deny.mjs";

const backendStore = new AsyncLocalStorage();

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

/** @type {{tmux: Function, readdir: Function}} */
export const localBackend = {
  // Local mode runs current code, so it supports every op it implements.
  supportsOp() {
    return true;
  },
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
  // Resolve the git "origin" remote of a directory into { host, owner, name }
  // (e.g. github.com / sycamore-labs / kernel). Returns empty strings when the
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
};
