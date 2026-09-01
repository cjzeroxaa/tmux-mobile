import assert from "node:assert/strict";

import {
  projectFileBrowserEntries,
  resolveFileBrowserDirectory,
} from "../lib/file-browser.mjs";

assert.deepEqual(resolveFileBrowserDirectory("/Users/cj/src/cc", "sources/app"), {
  root: "/Users/cj/src/cc",
  directoryPath: "/Users/cj/src/cc/sources/app",
  relativePath: "sources/app",
});
assert.deepEqual(resolveFileBrowserDirectory("/Users/cj/src/cc", ""), {
  root: "/Users/cj/src/cc",
  directoryPath: "/Users/cj/src/cc",
  relativePath: "",
});
assert.throws(
  () => resolveFileBrowserDirectory("/Users/cj/src/cc", "../secrets"),
  (error) => error.status === 403,
);
assert.throws(() => resolveFileBrowserDirectory("/Users/cj/src/cc", "/etc"), /must be relative/);
assert.throws(() => resolveFileBrowserDirectory("~/src/cc", ""), /root must be absolute/);

assert.deepEqual(
  projectFileBrowserEntries("/repo", [
    { name: "z10.ts", isDirectory: false },
    { name: "z2.ts", isDirectory: false },
    { name: "src", isDirectory: true },
    { name: ".git", isDirectory: true },
    { name: "node_modules", isDirectory: true },
    { name: ".env.example", isDirectory: false },
  ]),
  {
    entries: [
      { name: "src", path: "/repo/src", isDirectory: true },
      { name: ".env.example", path: "/repo/.env.example", isDirectory: false },
      { name: "z2.ts", path: "/repo/z2.ts", isDirectory: false },
      { name: "z10.ts", path: "/repo/z10.ts", isDirectory: false },
    ],
    truncated: false,
  },
);
assert.equal(projectFileBrowserEntries("/repo", [{ name: "a" }, { name: "b" }], 1).truncated, true);

console.log("file browser path tests passed");
