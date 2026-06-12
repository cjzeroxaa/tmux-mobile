import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { createHub } from "../lib/hub.mjs";
import { AGENT_WS_PATH, helloFrame } from "../lib/protocol.mjs";

const OWNER = "sonicgg@gmail.com";
const viewer = { userId: OWNER, email: OWNER, hd: "" };
const server = http.createServer();
const hub = createHub(server, {
  authenticateAgent: () => viewer,
  machineAliases: {
    "macbook-pro-15.local": "MacBook",
    macbook: "MacBook",
  },
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

async function connectMachine(port, machine, revision) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`);
  ws.on("error", () => {});
  await new Promise((resolve) => ws.once("open", resolve));
  ws.send(
    JSON.stringify(
      helloFrame({
        machine,
        os: "darwin",
        arch: "arm64",
        tmux: "tmux 3.5",
        revision,
        cwd: "/tmp/tmux-mobile",
        node: process.execPath,
      }),
    ),
  );
  return ws;
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

let first;
let second;
try {
  first = await connectMachine(port, "MacBook-Pro-15.local", "old");
  const firstMachine = await waitFor("first aliased MacBook", () => {
    const machines = hub.listMachines(viewer);
    return machines.length === 1 && machines[0].rawMachineId === "MacBook-Pro-15.local"
      ? machines[0]
      : null;
  });

  assert.equal(firstMachine.machineId, "MacBook");
  assert.equal(firstMachine.hostname, "MacBook");
  assert.ok(hub.hasMachine(viewer, "MacBook-Pro-15.local"));

  const firstRouteId = firstMachine.id;
  second = await connectMachine(port, "MacBook", "new");
  const secondMachine = await waitFor("replacement aliased MacBook", () => {
    const machines = hub.listMachines(viewer);
    return machines.length === 1 && machines[0].rawMachineId === "MacBook"
      ? machines[0]
      : null;
  });

  assert.equal(secondMachine.id, firstRouteId);
  assert.equal(secondMachine.machineId, "MacBook");
  assert.equal(secondMachine.hostname, "MacBook");
  assert.equal(secondMachine.agentRevision, "new");
  assert.ok(hub.hasMachine(viewer, "MacBook"));
  assert.ok(hub.hasMachine(viewer, "MacBook-Pro-15.local"));

  console.log("hub machine-alias replacement passed");
} finally {
  first?.close();
  second?.close();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
