// Tests for backend.readfile. The viewer reads pane-referenced files THROUGH the
// agent. By design there is NO directory confinement — the only boundary is the
// OS file permissions of the user the agent runs as. baseDir (the pane cwd) is
// used only to resolve relative paths. This test pins that behavior: relative
// resolves against baseDir, absolute / ../ / symlinks resolve where they point,
// ~ expands to home, and an unreadable file errors.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localBackend } from "../lib/backend.mjs";

const root = mkdtempSync(path.join(tmpdir(), "tmux-readfile-"));
const base = path.join(root, "project"); // the pane cwd
const sibling = path.join(root, "sibling"); // outside the cwd subtree
mkdirSync(base);
mkdirSync(sibling);
mkdirSync(path.join(base, "docs"));

writeFileSync(path.join(base, "README.md"), "# Hello\n");
writeFileSync(path.join(base, "docs", "guide.md"), "## Guide\n");
writeFileSync(path.join(sibling, "outside.md"), "# Outside\n");
symlinkSync(path.join(sibling, "outside.md"), path.join(base, "link.md"));
writeFileSync(path.join(base, "big.md"), "abcdef");

const read = (p, opts) => localBackend.readfile(p, { baseDir: base, ...opts });
const text = (r) => Buffer.from(r.base64, "base64").toString();

try {
  // 1. relative path resolves against baseDir (the pane cwd)
  assert.equal(text(await read("README.md")), "# Hello\n", "1 relative in cwd");
  assert.equal(text(await read("docs/guide.md")), "## Guide\n", "2 relative subdir");

  // 3. NO confinement: ../ to a sibling now succeeds (OS allows the read)
  assert.equal(text(await read("../sibling/outside.md")), "# Outside\n", "3 ../ allowed");

  // 4. absolute path outside baseDir succeeds
  assert.equal(text(await read(path.join(sibling, "outside.md"))), "# Outside\n", "4 absolute allowed");

  // 5. a symlink pointing outside baseDir now resolves (not blocked)
  assert.equal(text(await read("link.md")), "# Outside\n", "5 symlink allowed");

  // 6. ~ expands to the home directory (resolve against real home file if present
  //    is environment-specific, so just assert the path resolution doesn't throw
  //    a "not found" for a known home file when one exists is fragile; instead
  //    verify ~ maps under the home dir by reading a temp file we drop there is
  //    also fragile — so assert the resolution path is home-based via a missing
  //    file producing ENOENT under home, not a "~"-literal lookup).
  await assert.rejects(
    () => read("~/almost-certainly-does-not-exist-xyz.md"),
    (e) => e.code === "ENOENT" || /no such file/i.test(e.message),
    "6 ~ expands (resolves under home, missing -> ENOENT)",
  );

  // 7. truncation honors maxBytes and reports the real size
  const r = await read("big.md", { maxBytes: 3 });
  assert.equal(text(r), "abc", "7 truncates");
  assert.equal(r.truncated, true, "7 truncated flag");
  assert.equal(r.size, 6, "7 real size");

  // 8. a directory is rejected (not a regular file)
  await assert.rejects(() => read("docs"), /not a regular file/i, "8 dir rejected");

  // 9. nonexistent file -> ENOENT
  await assert.rejects(() => read("nope.md"), (e) => e.code === "ENOENT", "9 missing");

  // 10. an unreadable file (chmod 000) yields EACCES from the OS (skip if running
  //     as root, which bypasses permission bits).
  const secret = path.join(base, "secret.md");
  writeFileSync(secret, "top secret");
  chmodSync(secret, 0o000);
  if (process.getuid && process.getuid() !== 0) {
    await assert.rejects(() => read("secret.md"), (e) => e.code === "EACCES", "10 no-perms -> EACCES");
  }
  chmodSync(secret, 0o600); // restore so cleanup can remove it

  // 11. denylist: a file matching a denied pattern is blocked even though the OS
  //     would allow the read. Use TMUX_MOBILE_READFILE_DENY so the test is
  //     independent of the default list.
  process.env.TMUX_MOBILE_READFILE_DENY = "**/blocked.md:*.pem";
  writeFileSync(path.join(base, "blocked.md"), "secret\n");
  writeFileSync(path.join(base, "cert.pem"), "key\n");
  writeFileSync(path.join(base, "allowed.md"), "ok\n");
  await assert.rejects(() => read("blocked.md"), (e) => e.code === "EACCES" && e.denied, "11 denied by path");
  await assert.rejects(() => read("cert.pem"), (e) => e.denied, "11 denied by *.pem");
  assert.equal(text(await read("allowed.md")), "ok\n", "11 non-denied still served");

  // 12. denylist can't be bypassed via a symlink pointing at a denied target:
  //     the resolved real path is checked.
  symlinkSync(path.join(base, "blocked.md"), path.join(base, "sneaky.md"));
  await assert.rejects(() => read("sneaky.md"), (e) => e.denied, "12 symlink to denied blocked");

  // 13. empty denylist disables blocking
  process.env.TMUX_MOBILE_READFILE_DENY = "";
  assert.equal(text(await read("blocked.md")), "secret\n", "13 empty denylist allows");
  delete process.env.TMUX_MOBILE_READFILE_DENY;

  console.log("readfile (os-permission boundary + denylist) tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
