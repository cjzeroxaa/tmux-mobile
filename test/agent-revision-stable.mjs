// Regression test for ECS/ALB rolling deploys: /api/health is a separate
// load-balanced request from the live WebSocket, so it can briefly alternate
// old/new revisions. The agent should not chase that flap; it should reconnect
// only after the new revision is observed in consecutive health polls.

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { AGENT_WS_PATH, infoFrame } from "../lib/protocol.mjs";

process.env.AGENT_REVISION_POLL_MS = "50";
process.env.AGENT_REVISION_STABLE_POLLS = "3";
process.env.AGENT_PING_INTERVAL_MS = "100";
process.env.AGENT_PONG_TIMEOUT_MS = "500";
process.env.AGENT_MACHINE = "revision-stable-machine";

const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

let stable = false;
let healthSeq = 0;
let wsConnectionCount = 0;
let resolveReconnect;
const reconnected = new Promise((resolve) => {
  resolveReconnect = resolve;
});

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/api/health")) {
    const revision = stable
      ? "rev-B"
      : healthSeq++ % 2 === 0
        ? "rev-B"
        : "rev-A";
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
  ws.send(
    JSON.stringify(
      infoFrame({ revision: wsConnectionCount === 1 ? "rev-A" : "rev-B" }),
    ),
  );
  ws.on("message", () => {});
  ws.on("error", () => {});
  if (wsConnectionCount >= 2) resolveReconnect(wsConnectionCount);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const agent = runAgent(`http://127.0.0.1:${port}`, backend);

try {
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(
    wsConnectionCount,
    1,
    "agent should not reconnect while health revisions are flapping",
  );

  stable = true;
  const which = await Promise.race([
    reconnected,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("agent did not re-dial after stable revision")), 3_000),
    ),
  ]);
  assert.ok(which >= 2, "expected a second connection after stable revision");

  console.log("agent revision-stable e2e passed");
} finally {
  agent.stop();
  wss.clients.forEach((ws) => ws.terminate());
  wss.close();
  await new Promise((resolve) => server.close(resolve));
}
