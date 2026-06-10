// Unit test for the git-worktree backend ops backing the "New branch" action:
//   - branch() detects a bare-repo-backed worktree (bare:true)
//   - worktreeAdd() creates a sibling worktree named after the branch
//   - branch-name validation rejects dangerous input
// Builds a real bare repo + worktree in a temp dir.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const { localBackend } = await import("../lib/backend.mjs");

const root = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-wt-test-"));
const bare = path.join(root, "repo.git");
const main = path.join(root, "main");

try {
  // Bare repo + an initial commit (seeded via a temp clone) + a worktree.
  await exec("git", ["init", "-q", "--bare", bare]);
  const seed = path.join(root, "seed");
  await exec("git", ["clone", "-q", bare, seed]);
  await exec("git", ["-C", seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "-q", "origin", "HEAD:main"]);
  await rm(seed, { recursive: true, force: true });
  await exec("git", ["-C", bare, "worktree", "add", "-q", main, "main"]);

  // 1. branch() reports a bare-backed worktree.
  const info = await localBackend.branch(main);
  assert.equal(info.branch, "main", "branch name");
  assert.equal(info.worktree, true, "is a worktree");
  assert.equal(info.bare, true, "backed by a bare repo");

  // 2. worktreeRoot is authoritative: the parent of the shared (.bare) git dir.
  //    Here the bare repo is <root>/repo.git, so the worktree root is <root>.
  const wtRoot = await localBackend.worktreeRoot(main);
  assert.equal(wtRoot, root, "worktree root = parent of the bare git dir");

  // 3. worktreeAdd creates <root>/<branch> on that branch.
  const created = await localBackend.worktreeAdd({ fromDir: main, branch: "feature-x" });
  assert.equal(created.branch, "feature-x");
  assert.equal(created.root, root, "reports the worktree root");
  assert.equal(created.path, path.join(root, "feature-x"), "<root>/<branch>");
  await stat(created.path); // throws if it doesn't exist
  const head = (await exec("git", ["-C", created.path, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  assert.equal(head, "feature-x", "new worktree is on the new branch");

  // 4. a slashed branch preserves the slash as a real subdirectory.
  const slashed = await localBackend.worktreeAdd({ fromDir: main, branch: "fix/typo" });
  assert.equal(slashed.path, path.join(root, "fix", "typo"), "slash -> nested dir, preserved");
  assert.equal(slashed.branch, "fix/typo", "branch keeps the slash");
  await stat(slashed.path);

  // 5. validation: reject dangerous / empty / malformed names (but a single
  //    internal slash like "feature/x" is allowed — tested above).
  for (const bad of [
    "", "  ", "-rf", "a b", "..", "../escape", "a;b", "a$(x)",
    "/abs", "trailing/", "double//slash",
  ]) {
    await assert.rejects(
      () => localBackend.worktreeAdd({ fromDir: main, branch: bad }),
      /invalid branch name/i,
      `should reject ${JSON.stringify(bad)}`,
    );
  }

  // 5. a non-bare repo reports bare:false (this very project).
  const here = await localBackend.branch(process.cwd());
  assert.equal(here.bare, false, "regular checkout is not bare-backed");

  console.log("worktree-add unit tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
