import assert from "node:assert/strict";
import http from "node:http";
import { io } from "socket.io-client";
import { createHub } from "../lib/hub.mjs";
import { AGENT_WS_PATH, helloFrame, inventoryFrame } from "../lib/protocol.mjs";

const OWNER = "sonicgg@gmail.com";
const AGENT_ID = "00000000-0000-4000-8000-000000000101";
const viewer = { userId: OWNER, email: OWNER, hd: "" };
const server = http.createServer();
const hub = createHub(server, {
  authenticateAgent: () => viewer,
  livenessIntervalMs: 25,
  inventoryStaleMs: 75,
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

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

let ws;
try {
  ws = io(`http://127.0.0.1:${port}`, {
    path: AGENT_WS_PATH,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  ws.on("connect_error", () => {});
  await new Promise((resolve) => ws.once("connect", resolve));
  ws.send(
    JSON.stringify(
      helloFrame({
        agentId: AGENT_ID,
        machine: "inventory-test",
        os: "darwin",
        arch: "arm64",
        tmux: "rmux 0.6.1",
        mux: "rmux",
        muxCommand: "rmux",
        muxVersion: "rmux 0.6.1",
        revision: "test",
        cwd: "/tmp/tmux-mobile",
        node: process.execPath,
      }),
    ),
  );

  const machine = await waitFor("machine online", () => hub.listMachines(viewer)[0]);
  assert.equal(machine.mux, "rmux", "machine exposes mux kind");
  assert.equal(machine.muxVersion, "rmux 0.6.1", "machine exposes mux version");
  assert.equal(machine.inventoryStatus, "pending", "new connector starts pending");
  assert.equal(machine.agentCount, 0, "pending inventory has no count yet");

  ws.send(
    JSON.stringify(
      inventoryFrame({
        ok: true,
        observedAt: Date.now(),
        durationMs: 7,
        agents: [
          {
            sessionId: "$1",
            sessionName: "work",
            windowId: "@1",
            windowIndex: 0,
            windowName: "codex",
            paneId: "%1",
            cwd: "/tmp",
            kind: "codex",
            status: "idle",
            turnCount: 3,
          },
        ],
      }),
    ),
  );

  const fresh = await waitFor("fresh inventory", () => {
    const snapshot = hub.commandCenterInventory(viewer, machine.id);
    return snapshot?.machine?.inventoryStatus === "fresh" ? snapshot : null;
  });
  assert.equal(fresh.machine.agentCount, 1, "fresh inventory counts agents");
  assert.equal(fresh.agents.length, 1, "fresh inventory exposes agents");
  assert.equal(fresh.agents[0].windowId, "@1");
  const allFresh = hub.listAllCommandCenterInventories();
  assert.equal(allFresh.length, 1, "internal inventory consumer sees every machine");
  assert.equal(allFresh[0].machine.id, machine.id);
  assert.deepEqual(
    allFresh[0].agents,
    fresh.agents,
    "internal inventory consumer reuses the connector-pushed agent cache",
  );

  ws.send(
    JSON.stringify(
      inventoryFrame({
        ok: false,
        observedAt: Date.now(),
        durationMs: 11,
        error: { message: "scan exploded" },
      }),
    ),
  );

  const failed = await waitFor("failed inventory", () => {
    const snapshot = hub.commandCenterInventory(viewer, machine.id);
    return snapshot?.machine?.inventoryStatus === "failed" ? snapshot : null;
  });
  assert.equal(failed.machine.agentCount, 0, "failed inventory does not count old agents");
  assert.equal(failed.agents.length, 0, "failed inventory does not expose old agents");
  assert.match(failed.machine.inventoryError, /scan exploded/);

  ws.send(
    JSON.stringify(
      inventoryFrame({
        ok: true,
        observedAt: Date.now(),
        durationMs: 9,
        agents: [
          {
            sessionId: "$1",
            sessionName: "work",
            windowId: "@1",
            windowIndex: 0,
            windowName: "codex",
            paneId: "%1",
            cwd: "/tmp",
            kind: "codex",
            status: "idle",
            turnCount: 3,
          },
        ],
      }),
    ),
  );

  const stale = await waitFor("stale inventory", () => {
    const snapshot = hub.commandCenterInventory(viewer, machine.id);
    return snapshot?.machine?.inventoryStatus === "stale" ? snapshot : null;
  });
  assert.equal(stale.machine.agentCount, 0, "stale inventory does not count old agents");
  assert.equal(stale.agents.length, 0, "stale inventory does not expose old agents");
  assert.equal(
    hub.listAllCommandCenterInventories()[0].agents.length,
    0,
    "background consumers do not revive stale agents with a live RPC scan",
  );
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(hub.listMachines(viewer).length, 1, "stale inventory does not disconnect machine");

  ws.send(
    JSON.stringify(
      inventoryFrame({
        ok: true,
        observedAt: Date.now(),
        durationMs: 9,
        agents: [
          {
            sessionId: "$2",
            sessionName: "recovered",
            windowId: "@2",
            windowIndex: 0,
            windowName: "codex",
            paneId: "%2",
            cwd: "/tmp",
            kind: "codex",
            status: "idle",
            turnCount: 4,
          },
        ],
      }),
    ),
  );

  const recovered = await waitFor("recovered inventory", () => {
    const snapshot = hub.commandCenterInventory(viewer, machine.id);
    return snapshot?.machine?.inventoryStatus === "fresh" ? snapshot : null;
  });
  assert.equal(recovered.machine.agentCount, 1, "fresh inventory recovers after stale");
  assert.equal(recovered.agents[0].sessionName, "recovered");

  console.log("hub command-center inventory tests passed");
} finally {
  ws?.disconnect();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
