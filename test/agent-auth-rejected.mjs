// Regression test: a permanent auth rejection (HTTP 403) on the agent WebSocket
// upgrade must STOP the reconnect loop with an actionable message, not retry
// forever with an opaque "Unexpected server response: 403". (Reported from a new
// machine running `node server.mjs --register …` that 403'd and looped.)

import assert from "node:assert/strict";
import http from "node:http";
import { AGENT_WS_PATH } from "../lib/protocol.mjs";

// Isolate agent config: persistence must never touch the real ~/.config copy.
process.env.TMUX_MOBILE_AGENT_CONFIG = `/tmp/tmux-mobile-test-agent-test_agent_auth_rejected_mjs-${process.pid}.json`;
process.env.AGENT_REVISION_POLL_MS = "0";
const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

// A "controller" that rejects every WebSocket upgrade with 403 (as the real hub
// does when authenticateAgent returns null — bad/missing/expired token).
let upgradeAttempts = 0;
const server = http.createServer();
server.on("upgrade", (req, socket) => {
  if (req.url === AGENT_WS_PATH) upgradeAttempts += 1;
  socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden");
  socket.destroy();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const hubUrl = `http://127.0.0.1:${port}`;

const events = [];
const handle = runAgent(hubUrl, backend, {
  logEvent: (event, payload) => events.push({ event, payload }),
});

// Wait long enough that, if it were retrying, several attempts would have fired
// (backoff starts at 1s). We expect exactly ONE upgrade and a clean stop.
await new Promise((resolve) => setTimeout(resolve, 2500));

const rejected = events.find((e) => e.event === "agent_auth_rejected");
assert.ok(rejected, "logs agent_auth_rejected on 403");
assert.equal(rejected.payload.status, 403, "reports the 403 status");
assert.match(rejected.payload.message, /--login/, "message tells the user to re-login");

assert.ok(
  events.some((e) => e.event === "agent_stopped"),
  "logs agent_stopped (loop halted)",
);
assert.ok(
  !events.some((e) => e.event === "agent_reconnect_scheduled"),
  "does NOT schedule a reconnect on a permanent auth rejection",
);
assert.equal(upgradeAttempts, 1, "only attempts the connection once (no retry loop)");

handle.stop();
server.close();
console.log("agent-auth-rejected test passed");
process.exit(0);
