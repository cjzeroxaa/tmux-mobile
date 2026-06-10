// Regression test for the graceful-deploy REDIAL handoff: the controller pushes
// a { t: "redial" } control frame down the live agent WebSocket, and the agent
// must reconnect immediately (terminate → existing reconnect path) — without
// waiting for the slower revision poll. Mirrors agent-revision-migrate.mjs but
// drives the re-dial via the pushed frame instead of a revision flip.

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { AGENT_WS_PATH, MSG } from "../lib/protocol.mjs";

// Disable the revision poll so the ONLY thing that can trigger a re-dial here is
// the REDIAL frame — proves the frame itself works.
// Isolate agent config: persistence must never touch the real ~/.config copy.
process.env.TMUX_MOBILE_AGENT_CONFIG = `/tmp/tmux-mobile-test-agent-test_agent_redial_mjs-${process.pid}.json`;
process.env.AGENT_REVISION_POLL_MS = "0";
process.env.AGENT_PING_INTERVAL_MS = "200";
process.env.AGENT_PONG_TIMEOUT_MS = "10000";
process.env.AGENT_MACHINE = "redial-test-machine";

const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

let wsConnectionCount = 0;
let resolveReconnect;
const reconnected = new Promise((resolve) => {
  resolveReconnect = resolve;
});

const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, revision: "rev-X", agents: wsConnectionCount }));
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
  if (wsConnectionCount === 1) {
    // First connection: simulate a deploy handoff by asking the agent to redial.
    setTimeout(() => {
      try {
        ws.send(JSON.stringify({ t: MSG.REDIAL }));
      } catch {}
    }, 300);
  } else if (wsConnectionCount >= 2) {
    resolveReconnect(wsConnectionCount);
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const agent = runAgent(`http://127.0.0.1:${port}`, backend);

try {
  const which = await Promise.race([
    reconnected,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("agent did not re-dial after REDIAL frame")), 5_000),
    ),
  ]);
  assert.ok(which >= 2, "expected a second connection after REDIAL");

  console.log("agent redial e2e passed");
  agent.stop();
  wss.clients.forEach((ws) => ws.terminate());
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  agent.stop();
  process.exit(1);
}
