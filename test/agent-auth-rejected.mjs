// Regression test: a permanent auth rejection on the agent connection must STOP
// the reconnect loop with an actionable message, not retry forever. The
// controller rejects in a Socket.IO handshake middleware with err.data.code
// "auth"; the agent must treat that as permanent. (Reported from a new machine
// running `node server.mjs --register …` that was rejected and looped.)

import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "socket.io";
import { AGENT_WS_PATH } from "../lib/protocol.mjs";

process.env.TMUX_MOBILE_AGENT_ID = "10000000-0000-4000-8000-000000000001";
const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

// A "controller" whose auth middleware rejects every connection (as the real hub
// does when authenticateAgent returns null — bad/missing/expired token).
let attempts = 0;
const server = http.createServer();
const io = new Server(server, { path: AGENT_WS_PATH, transports: ["websocket"] });
io.use((_socket, next) => {
  attempts += 1;
  const error = new Error("forbidden");
  error.data = { code: "auth" };
  next(error);
});
io.on("connection", () => {});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const hubUrl = `http://127.0.0.1:${port}`;

const events = [];
const handle = runAgent(hubUrl, backend, {
  logEvent: (event, payload) => events.push({ event, payload }),
});

// Wait long enough that, if it were retrying, several attempts would have fired
// (backoff starts at 1s). We expect exactly ONE attempt and a clean stop.
await new Promise((resolve) => setTimeout(resolve, 2500));

const rejected = events.find((e) => e.event === "agent_auth_rejected");
assert.ok(rejected, "logs agent_auth_rejected on a rejected handshake");
assert.match(rejected.payload.message, /--login/, "message tells the user to re-login");

assert.ok(
  events.some((e) => e.event === "agent_stopped"),
  "logs agent_stopped (loop halted)",
);
assert.ok(
  !events.some((e) => e.event === "agent_reconnect_scheduled"),
  "does NOT schedule a reconnect on a permanent auth rejection",
);
assert.equal(attempts, 1, "only attempts the connection once (no retry loop)");

handle.stop();
io.close();
server.close();
console.log("agent-auth-rejected test passed");
process.exit(0);
