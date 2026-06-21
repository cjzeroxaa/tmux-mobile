import assert from "node:assert/strict";
import http from "node:http";
import { io } from "socket.io-client";
import { createHub } from "../lib/hub.mjs";
import { AGENT_WS_PATH, helloFrame } from "../lib/protocol.mjs";

const OWNER = "sonicgg@gmail.com";
const AGENT_ONE = "00000000-0000-4000-8000-000000000001";
const AGENT_TWO = "00000000-0000-4000-8000-000000000002";
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

async function connectMachine(port, machine, revision, agentId = "") {
  // forceNew so each call is a distinct connection (Socket.IO multiplexes by
  // default, which would otherwise share one socket across all three machines).
  const ws = io(`http://127.0.0.1:${port}`, {
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
        agentId,
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
let third;
try {
  first = await connectMachine(port, "MacBook-Pro-15.local", "old", AGENT_ONE);
  const firstMachine = await waitFor("first aliased MacBook", () => {
    const machines = hub.listMachines(viewer);
    return machines.length === 1 && machines[0].rawMachineId === "MacBook-Pro-15.local"
      ? machines[0]
      : null;
  });

  assert.equal(firstMachine.machineId, "MacBook");
  assert.equal(firstMachine.hostname, "MacBook");
  assert.equal(firstMachine.agentId, AGENT_ONE);
  assert.ok(hub.hasMachine(viewer, AGENT_ONE));

  const firstRouteId = firstMachine.id;
  second = await connectMachine(port, "MacBook", "new", AGENT_ONE);
  const secondMachine = await waitFor("replacement aliased MacBook", () => {
    const machines = hub.listMachines(viewer);
    return machines.length === 1 && machines[0].rawMachineId === "MacBook"
      ? machines[0]
      : null;
  });

  assert.equal(secondMachine.id, firstRouteId);
  assert.equal(secondMachine.machineId, "MacBook");
  assert.equal(secondMachine.hostname, "MacBook");
  assert.equal(secondMachine.agentId, AGENT_ONE);
  assert.equal(secondMachine.agentRevision, "new");

  third = await connectMachine(port, "MacBook", "other", AGENT_TWO);
  const twoMachines = await waitFor("same-name different UUID MacBooks", () => {
    const machines = hub.listMachines(viewer);
    return machines.length === 2 ? machines : null;
  });
  assert.deepEqual(
    twoMachines.map((machine) => machine.agentId).sort(),
    [AGENT_ONE, AGENT_TWO],
  );
  assert.notEqual(twoMachines[0].id, twoMachines[1].id);
  assert.equal(hub.hasMachine(viewer, "MacBook"), false);

  console.log("hub machine-alias replacement passed");
} finally {
  first?.disconnect();
  second?.disconnect();
  third?.disconnect();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
