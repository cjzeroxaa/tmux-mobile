// Regression test for the half-open-connection bug: when the controller
// (Cloud Run) restarts, the old WebSocket can be silently orphaned — no
// close/error reaches the agent, so the agent must detect the dead peer via
// its own ping/pong timeout and reconnect. Here a fake hub accepts the agent
// connection but NEVER answers pings (autoPong disabled); the agent should
// terminate the dead socket and dial again.

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { AGENT_WS_PATH } from "../lib/protocol.mjs";

// Squeeze production's 10s/25s cadence into a fast test window. These must be
// set BEFORE importing agent.mjs, which reads them into module-level consts at
// load time — hence the dynamic import below.
// Isolate agent config: persistence must never touch the real ~/.config copy.
process.env.TMUX_MOBILE_AGENT_CONFIG = `/tmp/tmux-mobile-test-agent-test_agent_liveness_mjs-${process.pid}.json`;
process.env.AGENT_REVISION_POLL_MS = "0"; // not under test here; keep hermetic
process.env.AGENT_PING_INTERVAL_MS = "100";
process.env.AGENT_PONG_TIMEOUT_MS = "300";
const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

const server = http.createServer();
// autoPong:false => the server never answers the agent's pings, simulating a
// peer whose TCP connection is silently dead (Cloud Run restart).
const wss = new WebSocketServer({ server, path: AGENT_WS_PATH, autoPong: false });

let connectionCount = 0;
let resolveReconnect;
const reconnected = new Promise((resolve) => {
  resolveReconnect = resolve;
});

wss.on("connection", (ws) => {
  connectionCount += 1;
  ws.on("message", () => {}); // swallow the hello frame
  ws.on("error", () => {}); // terminate() on the client surfaces here; ignore
  if (connectionCount >= 2) resolveReconnect(connectionCount);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const hubUrl = `http://127.0.0.1:${port}`;

const agent = runAgent(hubUrl, backend);

try {
  const which = await Promise.race([
    reconnected,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("agent did not reconnect after dead peer")), 5_000),
    ),
  ]);
  assert.ok(which >= 2, "expected a second (reconnected) agent connection");
  console.log("agent liveness reconnect e2e passed");
} finally {
  agent.stop();
  wss.clients.forEach((ws) => ws.terminate());
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  setTimeout(() => process.exit(0), 100);
}
