// When the controller accepts a replacement connector for the same canonical
// machine, it force-disconnects the old socket. Socket.IO delivers that as an
// "io server disconnect", which suppresses auto-reconnect — so the old agent
// process must stop (and log it) instead of fighting the replacement.

import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "socket.io";
import { AGENT_WS_PATH } from "../lib/protocol.mjs";

process.env.AGENT_MAX_BACKOFF_MS = "80";
process.env.AGENT_MACHINE = "replaced-test-machine";
process.env.TMUX_MOBILE_AGENT_ID = "10000000-0000-4000-8000-000000000003";

const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.5",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

const server = http.createServer();
const io = new Server(server, { path: AGENT_WS_PATH, transports: ["websocket"] });
const events = [];
let connections = 0;

io.on("connection", (socket) => {
  connections += 1;
  // On the agent's hello, simulate REPLACED: force-disconnect it.
  socket.on("message", () => socket.disconnect(true));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const agent = runAgent(`http://127.0.0.1:${port}`, backend, {
  logEvent(event, details = {}) {
    events.push({ event, details });
  },
});

try {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(connections, 1, "replaced agent must not reconnect");
  assert.ok(
    events.some((entry) => entry.event === "agent_stopped"),
    "replaced agent logs agent_stopped",
  );
  assert.ok(
    !events.some((entry) => entry.event === "agent_reconnect_scheduled"),
    "replaced agent does not schedule reconnect",
  );
  console.log("agent replaced-stops test passed");
} finally {
  agent.stop();
  io.close();
  await new Promise((resolve) => server.close(resolve));
}
