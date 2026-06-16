import assert from "node:assert/strict";
import http from "node:http";
import { createHub } from "../lib/hub.mjs";
import { runAgent } from "../lib/agent.mjs";

const OWNER = "sonicgg@gmail.com";
const viewer = { userId: OWNER, email: OWNER, hd: "" };
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, revision: "test" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const hub = createHub(server, {
  authenticateAgent: () => viewer,
  currentRevision: "test",
});

function waitFor(label, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        const result = predicate();
        if (result) {
          clearInterval(timer);
          resolve(result);
          return;
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 25);
  });
}

const backend = {
  async tmux() {
    return "tmux 3.5\n";
  },
};

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

let agent;
try {
  agent = runAgent(`http://127.0.0.1:${port}`, backend, {
    inventoryProvider: async () => ({
      agents: [
        {
          sessionId: "$1",
          sessionName: "publish",
          windowId: "@1",
          windowIndex: 0,
          windowName: "codex",
          paneId: "%1",
          cwd: "/tmp",
          kind: "codex",
          status: "idle",
          turnCount: 1,
        },
      ],
    }),
  });

  const machine = await waitFor("published inventory", () => {
    const item = hub.listMachines(viewer)[0];
    if (!item) return null;
    const snapshot = hub.commandCenterInventory(viewer, item.id);
    return snapshot?.machine?.inventoryStatus === "fresh" ? snapshot : null;
  });

  assert.equal(machine.machine.agentCount, 1);
  assert.equal(machine.agents[0].sessionName, "publish");

  console.log("agent inventory publish test passed");
} finally {
  agent?.stop();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
