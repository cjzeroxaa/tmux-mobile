// Regression test for stable agent identity across restarts: when AGENT_MACHINE
// isn't set, the agent persists the resolved machine name to its config so a
// later restart registers under the SAME name (instead of re-deriving a
// possibly-different os.hostname() and stranding browser sessions waiting on the
// old name). Runs the agent twice against a fake controller, capturing the
// `machine` from each hello frame.

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { AGENT_WS_PATH, MSG } from "../lib/protocol.mjs";

process.env.AGENT_REVISION_POLL_MS = "0";
process.env.AGENT_PING_INTERVAL_MS = "300";
process.env.AGENT_PONG_TIMEOUT_MS = "10000";
delete process.env.AGENT_MACHINE; // force the stored/hostname path

const dir = await mkdtemp(path.join(os.tmpdir(), "tmux-mobile-machine-test-"));
process.env.TMUX_MOBILE_AGENT_CONFIG = path.join(dir, "agent.json");

const { runAgent } = await import("../lib/agent.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

// Fake controller: capture the machine name from each hello frame.
const helloMachines = [];
let onHello = null;
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, revision: "rev", agents: 1 }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server, path: AGENT_WS_PATH });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === MSG.HELLO) {
      helloMachines.push(msg.machine);
      if (onHello) onHello(msg.machine);
    }
  });
  ws.on("error", () => {});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}`;

function runUntilHello() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agent never sent hello")), 5000);
    onHello = (name) => { clearTimeout(timer); resolve(name); };
    const agent = runAgent(url, backend);
    resolveAgent(agent);
  });
}
let _agent;
const resolveAgent = (a) => { _agent = a; };

try {
  // First run: resolves to os.hostname() (no AGENT_MACHINE, empty config) and
  // persists it.
  const first = await runUntilHello();
  assert.ok(first, "first run registered a machine name");
  _agent.stop();

  // The name should now be in the config file.
  const cfg = JSON.parse(await readFile(process.env.TMUX_MOBILE_AGENT_CONFIG, "utf8"));
  assert.equal(cfg.machine, first, "machine name persisted to config");

  // Second run: must register under the SAME name (read from config), even
  // though nothing in the env changed.
  await new Promise((r) => setTimeout(r, 200));
  const second = await runUntilHello();
  _agent.stop();
  assert.equal(second, first, "restart kept the same machine identity");

  console.log("agent machine-persist e2e passed");
  wss.clients.forEach((ws) => ws.terminate());
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  console.error(error.message);
  try { _agent?.stop(); } catch {}
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
}
