// Unit tests for the window stable-id / descriptor helpers (public/window-id.js).
// Imports the real module so app.js and CI stay in lockstep.

import assert from "node:assert/strict";
import {
  abbrevHome,
  windowStableId,
  windowDescriptor,
} from "../public/window-id.js";

// --- abbrevHome ---
assert.equal(abbrevHome("/home/ubuntu/g/tmux-mobile"), "~/g/tmux-mobile");
assert.equal(abbrevHome("/Users/ming/proj"), "~/proj");
assert.equal(abbrevHome("/root"), "~");
assert.equal(abbrevHome("/root/x"), "~/x");
assert.equal(abbrevHome("/opt/elsewhere"), "/opt/elsewhere"); // untouched
assert.equal(abbrevHome(""), "");

// --- windowStableId: host/session:index ---
assert.equal(
  windowStableId({ host: "ip-172-31-23-216", sessionName: "work", index: 0 }),
  "ip-172-31-23-216/work:0",
);
assert.equal(
  windowStableId({ host: "t.dev.sycamore.sh", sessionName: "mysession", index: 3 }),
  "t.dev.sycamore.sh/mysession:3",
);
// host falls back to "local" when missing
assert.equal(windowStableId({ sessionName: "s", index: 2 }), "local/s:2");
// empty session name still produces a parseable id
assert.equal(windowStableId({ host: "h", sessionName: "", index: 1 }), "h/:1");

// --- windowDescriptor: id (index:name · cwd ⎇ branch · worktree) ---
assert.equal(
  windowDescriptor({
    host: "t.dev.sycamore.sh",
    sessionName: "mysession",
    index: 3,
    name: "claude",
    cwd: "/home/ubuntu/g/tmux-mobile",
    branch: "feature-x",
    worktree: true,
  }),
  "t.dev.sycamore.sh/mysession:3 (3:claude · ~/g/tmux-mobile ⎇ feature-x · worktree)",
);
// no branch / no worktree / cwd only
assert.equal(
  windowDescriptor({
    host: "ip-172-31-23-216",
    sessionName: "work",
    index: 0,
    name: "shell",
    cwd: "/root/proj",
  }),
  "ip-172-31-23-216/work:0 (0:shell · ~/proj)",
);
// bare: no cwd, branch, or worktree
assert.equal(
  windowDescriptor({ host: "h", sessionName: "s", index: 2, name: "vim" }),
  "h/s:2 (2:vim)",
);
// worktree without branch still flags the worktree
assert.equal(
  windowDescriptor({
    host: "h",
    sessionName: "s",
    index: 4,
    name: "x",
    worktree: true,
  }),
  "h/s:4 (4:x · worktree)",
);

console.log("window-id unit tests passed");
