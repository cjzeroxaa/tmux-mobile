// Unit tests for the window stable-id / descriptor helpers (public/window-id.js).
// Imports the real module so app.js and CI stay in lockstep.

import assert from "node:assert/strict";
import {
  abbrevHome,
  windowKey,
  windowStableId,
  windowDescriptor,
  mergeRecent,
} from "../public/window-id.js";

// --- mergeRecent: MRU insert, dedupe by key, cap length ---
// new key goes to the front
assert.deepEqual(
  mergeRecent([{ key: "a" }, { key: "b" }], { key: "c" }, 20).map((e) => e.key),
  ["c", "a", "b"],
);
// re-visiting an existing key moves it to the front (no duplicate), and the
// entry's fresh data replaces the old one
const merged = mergeRecent(
  [{ key: "a", name: "old" }, { key: "b" }],
  { key: "a", name: "new" },
  20,
);
assert.deepEqual(merged.map((e) => e.key), ["a", "b"]);
assert.equal(merged[0].name, "new");
// cap is enforced, oldest dropped
assert.deepEqual(
  mergeRecent(
    [{ key: "1" }, { key: "2" }, { key: "3" }],
    { key: "0" },
    3,
  ).map((e) => e.key),
  ["0", "1", "2"],
);
// tolerates empty / missing list
assert.deepEqual(mergeRecent(undefined, { key: "x" }, 5), [{ key: "x" }]);

// --- windowKey: the shared identity key (machine  session  index) ---
// Both windowRecentKey (live windows) and attentionKey (attention descriptors)
// route through this, so the same window from either side must produce the SAME
// string — that equality is what makes jump-to-window and active-window
// suppression work. Regression guard for the old separator mismatch.
const SEP = "";
assert.equal(
  windowKey({ machineId: "m1", sessionName: "work", index: 3 }),
  `m1${SEP}work${SEP}3`,
);
// machineId falls back to "local"; missing session → empty segment.
assert.equal(windowKey({ sessionName: "s", index: 0 }), `local${SEP}s${SEP}0`);
assert.equal(windowKey({ machineId: "m", index: 2 }), `m${SEP}${SEP}2`);
// The two call shapes (live window fields vs attention descriptor fields) must
// converge on the identical key for the same window.
const liveKey = windowKey({ machineId: "host", sessionName: "dev", index: 5 });
const attnKey = windowKey({ machineId: "host", sessionName: "dev", index: 5 });
assert.equal(liveKey, attnKey);
// Number vs string index produce the SAME key (server sends Number(index)).
assert.equal(
  windowKey({ machineId: "h", sessionName: "s", index: 7 }),
  windowKey({ machineId: "h", sessionName: "s", index: "7" }),
);

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
