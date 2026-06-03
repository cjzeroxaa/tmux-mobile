// Security test for backend.readfile path confinement. The smart content viewer
// reads pane-referenced files THROUGH the agent; readfile must serve only files
// within the pane's cwd subtree and refuse ../ escapes, absolute paths outside
// the base, and symlink escapes. A regression here would let the controller read
// arbitrary files on the agent's machine (e.g. ~/.ssh/id_rsa).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localBackend } from "../lib/backend.mjs";

const root = mkdtempSync(path.join(tmpdir(), "tmux-readfile-"));
const base = path.join(root, "project"); // the pane cwd
const outside = path.join(root, "secret"); // a sibling the user must NOT reach
mkdirSync(base);
mkdirSync(outside);
mkdirSync(path.join(base, "docs"));

writeFileSync(path.join(base, "README.md"), "# Hello\n");
writeFileSync(path.join(base, "docs", "guide.md"), "## Guide\n");
writeFileSync(path.join(outside, "id_rsa"), "PRIVATE KEY");
// A symlink inside base that points outside it.
symlinkSync(path.join(outside, "id_rsa"), path.join(base, "escape-link"));
// A 3-byte over a tiny cap, to exercise truncation.
writeFileSync(path.join(base, "big.md"), "abcdef");

try {
  // 1. file directly in cwd
  let r = await localBackend.readfile("README.md", { baseDir: base });
  assert.equal(Buffer.from(r.base64, "base64").toString(), "# Hello\n", "1 reads cwd file");
  assert.equal(r.truncated, false);

  // 2. file in a subdirectory of cwd
  r = await localBackend.readfile("docs/guide.md", { baseDir: base });
  assert.equal(Buffer.from(r.base64, "base64").toString(), "## Guide\n", "2 reads subdir file");

  // 3. ../ escape is rejected
  await assert.rejects(
    () => localBackend.readfile("../secret/id_rsa", { baseDir: base }),
    (e) => e.code === "EACCES",
    "3 blocks ../ escape",
  );

  // 4. absolute path outside base is rejected
  await assert.rejects(
    () => localBackend.readfile(path.join(outside, "id_rsa"), { baseDir: base }),
    (e) => e.code === "EACCES",
    "4 blocks absolute outside path",
  );

  // 5. symlink inside base pointing outside is rejected (realpath escape)
  await assert.rejects(
    () => localBackend.readfile("escape-link", { baseDir: base }),
    (e) => e.code === "EACCES",
    "5 blocks symlink escape",
  );

  // 6. truncation honors maxBytes and reports real size
  r = await localBackend.readfile("big.md", { baseDir: base, maxBytes: 3 });
  assert.equal(Buffer.from(r.base64, "base64").toString(), "abc", "6 truncates to maxBytes");
  assert.equal(r.truncated, true, "6 reports truncated");
  assert.equal(r.size, 6, "6 reports real size");

  // 7. missing baseDir throws
  await assert.rejects(() => localBackend.readfile("README.md", {}), "7 requires baseDir");

  // 8. nonexistent file -> not found (not a confinement error)
  await assert.rejects(
    () => localBackend.readfile("nope.md", { baseDir: base }),
    /not found/i,
    "8 missing file",
  );

  console.log("readfile-confine security tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
