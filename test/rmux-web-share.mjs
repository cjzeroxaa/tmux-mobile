import assert from "node:assert/strict";
import {
  parseRmuxWebShareList,
  parseRmuxWebShareOutput,
} from "../lib/backend.mjs";

const parsed = parseRmuxWebShareOutput(
  "share expires at 2026-06-19T00:07:57+00:00\noperator pin 113518\n",
  "rmux: operator URL (keep private):\nrmux:   https://share.rmux.io/#t=abc123\noperator URL emitted on stderr\n",
);

assert.equal(parsed.operatorUrl, "https://share.rmux.io/#t=abc123");
assert.equal(parsed.code, "113518");
assert.equal(parsed.expiresAt, "2026-06-19T00:07:57+00:00");

assert.deepEqual(parseRmuxWebShareList("qxa5zh54 impo:%4 -\n"), [
  { id: "qxa5zh54", target: "impo:%4", expiresAt: "" },
]);

console.log("rmux-web-share unit tests passed");
