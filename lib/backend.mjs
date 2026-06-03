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
import path from "node:path";

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
  // Read a file for the smart content viewer, confined to the baseDir subtree.
  // Both the requested path and baseDir are resolved through realpath so that
  // symlinks can't be used to escape the boundary (e.g. a symlink in cwd
  // pointing at ~/.ssh). Returns base64 bytes + the real size; truncates to
  // maxBytes. Throws on a path outside baseDir or a non-regular file.
  async readfile(filePath, { baseDir = "", maxBytes = 5 * 1024 * 1024 } = {}) {
    if (!baseDir) throw new Error("baseDir is required");
    const resolvedBaseReal = await realpath(path.resolve(baseDir));
    // Resolve the requested path relative to baseDir (absolute paths are honored
    // but still boundary-checked below).
    const requested = path.resolve(resolvedBaseReal, filePath);
    let realTarget;
    try {
      realTarget = await realpath(requested);
    } catch {
      throw new Error("File not found");
    }
    const withSep = resolvedBaseReal.endsWith(path.sep)
      ? resolvedBaseReal
      : resolvedBaseReal + path.sep;
    if (realTarget !== resolvedBaseReal && !realTarget.startsWith(withSep)) {
      const error = new Error("Path is outside the allowed directory");
      error.code = "EACCES";
      throw error;
    }
    const info = await stat(realTarget);
    if (!info.isFile()) throw new Error("Not a regular file");
    const buffer = await readFile(realTarget);
    const truncated = buffer.length > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return {
      base64: slice.toString("base64"),
      size: info.size,
      truncated,
    };
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
