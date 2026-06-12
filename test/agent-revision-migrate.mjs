// Regression test for revision-poll migration: on a Cloud Run deploy the agent's
// live WebSocket keeps the OLD instance alive, so the controller never gets
// SIGTERM. The agent must instead notice the controller's /api/health revision
// changed and re-dial itself. Here one server stays up the whole time (the
// stable URL / WS), but the revision it reports flips; the agent should
// terminate and reconnect when it does.

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { AGENT_WS_PATH } from "../lib/protocol.mjs";

process.env.AGENT_REVISION_POLL_MS = "150"; // fast poll for the test
process.env.AGENT_PING_INTERVAL_MS = "200";
process.env.AGENT_PONG_TIMEOUT_MS = "600";
process.env.AGENT_MACHINE = "revision-test-machine";
process.env.TMUX_MOBILE_AGENT_ID = "10000000-0000-4000-8000-000000000004";

const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

let revision = "rev-A";
let wsConnectionCount = 0;
let resolveReconnect;
const reconnected = new Promise((resolve) => {
  resolveReconnect = resolve;
});

// One HTTP server for the whole test: serves /api/health (with the current
// revision) and accepts the agent WebSocket upgrade. autoPong stays on so the
// liveness check is satisfied — only the revision drives the re-dial.
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, revision }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server, path: AGENT_WS_PATH });
wss.on("connection", (ws) => {
  wsConnectionCount += 1;
  ws.on("message", () => {}); // swallow hello
  ws.on("error", () => {});
  if (wsConnectionCount >= 2) resolveReconnect(wsConnectionCount);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const agent = runAgent(`http://127.0.0.1:${port}`, backend);

try {
  // Let the agent connect and capture baseline revision rev-A.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(wsConnectionCount, 1, "agent should have connected once");

  // Deploy: the controller now reports a new revision.
  revision = "rev-B";

  // The agent should poll, see the change, terminate, and reconnect.
  const which = await Promise.race([
    reconnected,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("agent did not re-dial after revision change")), 5_000),
    ),
  ]);
  assert.ok(which >= 2, "expected a second connection after the revision flip");

  console.log("agent revision-migrate e2e passed");
  agent.stop();
  wss.clients.forEach((ws) => ws.terminate());
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  agent.stop();
  process.exit(1);
}
