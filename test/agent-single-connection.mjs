// Regression test for the "no machine connected" thrash: the agent must hold at
// most ONE live WebSocket to the controller at a time.
//
// The production bug: two independent triggers can race to reconnect the SAME
// dropped connection — the socket `close` handler AND a terminate() from the
// liveness or revision-poll timer. Without an idempotency guard, each calls
// setTimeout(connect), so the agent dials TWICE and ends up with two overlapping
// sockets. The controller keeps one slot per machine, so the two registrations
// evict each other in a connect→disconnect loop and the machine shows as "not
// connected" in the UI.
//
// This test stands up a fake controller that (a) never answers pings (forcing the
// liveness terminate) AND (b) reports a CHANGING revision from /api/health
// (forcing the revision-change terminate) — the two triggers that race. We assert
// the controller never observes more than one concurrently-open connection.

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { AGENT_WS_PATH } from "../lib/protocol.mjs";

// Fast cadence so both triggers fire quickly and overlap. Set BEFORE importing
// agent.mjs (it reads these into module consts at load). Revision polling ON so
// the revision-change terminate path is exercised alongside liveness.
process.env.AGENT_REVISION_POLL_MS = "50";
process.env.AGENT_PING_INTERVAL_MS = "50";
process.env.AGENT_PONG_TIMEOUT_MS = "140";
process.env.AGENT_MAX_BACKOFF_MS = "80";
const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

// /api/health reports an ever-changing revision so the agent's revision poll
// always sees a "deploy" and calls terminate() — racing the liveness terminate.
let revSeq = 0;
const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/api/health")) {
    revSeq += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, revision: `rev-${revSeq}` }));
    return;
  }
  res.writeHead(404);
  res.end();
});
// autoPong:false => never answer pings => liveness terminate fires too.
const wss = new WebSocketServer({ server, path: AGENT_WS_PATH, autoPong: false });

let open = 0;
let maxOpen = 0;
let total = 0;
wss.on("connection", (ws) => {
  open += 1;
  total += 1;
  maxOpen = Math.max(maxOpen, open);
  ws.on("message", () => {});
  ws.on("error", () => {});
  ws.on("close", () => {
    open -= 1;
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const agent = runAgent(`http://127.0.0.1:${port}`, backend);

try {
  // Churn for a few seconds so the two terminate triggers race many times.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.ok(total >= 3, `expected several reconnect cycles, saw ${total}`);
  assert.ok(
    maxOpen <= 1,
    `agent held ${maxOpen} concurrent connections; must be <=1 ` +
      `(overlapping sockets = the machine-not-connected thrash). cycles=${total}`,
  );
  console.log(`agent single-connection e2e passed (${total} cycles, maxConcurrent=${maxOpen})`);
} finally {
  agent.stop();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
}
