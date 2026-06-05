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
import { readdir } from "node:fs/promises";

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
};
