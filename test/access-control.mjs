import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAccessControlFile } from "../lib/access-control.mjs";

const config = readAccessControlFile(
  path.join(import.meta.dirname, "..", "config", "access-control.json"),
);
assert.deepEqual(config, {
  version: 1,
  machineVisibility: "owner-only",
  superAdminEmails: ["sonicgg@gmail.com"],
});

const dir = mkdtempSync(path.join(os.tmpdir(), "tmux-mobile-access-control-"));
const invalid = path.join(dir, "invalid.json");
writeFileSync(
  invalid,
  JSON.stringify({
    version: 1,
    machineVisibility: "domain",
    superAdminEmails: ["sonicgg@gmail.com"],
  }),
);
assert.throws(
  () => readAccessControlFile(invalid),
  /machineVisibility must be "owner-only"/,
);

console.log("access-control unit tests passed");
