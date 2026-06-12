// Regression test for the deploy case: when the controller shuts down (SIGTERM
// during a Cloud Run revision rollout), it closes agent WebSockets via
// hub.shutdown(). The agent must see that close and reconnect immediately,
// rather than staying pinned to the dying instance until its socket dies on its
// own.
//
// We model a revision rollover faithfully: instance A (hub on a fixed port)
// accepts the agent, then shuts down and its server is torn down; instance B
// starts on the SAME port (the stable controller URL) and the agent must
// reconnect and re-register there on its own.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

// Fast reconnect for the test; set before importing the agent (module-load consts).
process.env.AGENT_REVISION_POLL_MS = "0"; // testing the SIGTERM-close path, not revision poll
process.env.AGENT_PING_INTERVAL_MS = "200";
process.env.AGENT_PONG_TIMEOUT_MS = "600";
process.env.AGENT_MAX_BACKOFF_MS = "300";
process.env.AGENT_MACHINE = "shutdown-test-machine";
process.env.TMUX_MOBILE_AGENT_ID = "10000000-0000-4000-8000-000000000006";

const { runAgent } = await import("../lib/agent.mjs");
const { createHub } = await import("../lib/hub.mjs");

const backend = {
  tmux: async () => "tmux 3.4",
  readdir: async () => [],
  branch: async () => ({ branch: "", worktree: false }),
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Stand up a controller "instance" (http server + hub) on a fixed port.
async function startInstance(port) {
  const server = http.createServer();
  const hub = createHub(server, { authenticateAgent: () => "default" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, hub };
}

async function stopInstance(instance, { graceful }) {
  if (graceful) instance.hub.shutdown(); // SIGTERM path: close agent sockets
  await new Promise((resolve) => instance.server.close(resolve));
}

async function waitFor(label, predicate, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const port = await getFreePort();
let instanceA = await startInstance(port);
const agent = runAgent(`http://127.0.0.1:${port}`, backend);
let instanceB = null;

try {
  // 1. Agent connects and registers with instance A.
  await waitFor("registered with instance A", () =>
    instanceA.hub.hasMachine("default", "shutdown-test-machine"),
  );

  // 2. Instance A shuts down gracefully (closes agent sockets) and goes away.
  await stopInstance(instanceA, { graceful: true });

  // 3. Instance B comes up on the same port (the new revision).
  instanceB = await startInstance(port);

  // 4. The agent must reconnect and register with B on its own — quickly,
  //    because the graceful close fired its reconnect immediately.
  await waitFor("reconnected to instance B", () =>
    instanceB.hub.hasMachine("default", "shutdown-test-machine"),
  );

  console.log("agent shutdown-reconnect e2e passed");
  agent.stop();
  if (instanceB) await stopInstance(instanceB, { graceful: false }).catch(() => {});
  process.exit(0);
} catch (error) {
  console.error(error.message);
  agent.stop();
  process.exit(1);
}
