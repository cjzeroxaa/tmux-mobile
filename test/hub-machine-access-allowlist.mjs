import assert from "node:assert/strict";
import http from "node:http";
import { io } from "socket.io-client";
import { createHub } from "../lib/hub.mjs";
import { AGENT_WS_PATH, helloFrame } from "../lib/protocol.mjs";

const OWNER = { userId: "owner@rebyte.ai", email: "owner@rebyte.ai", hd: "rebyte.ai" };
const SPECIAL = { userId: "xuc2078@gmail.com", email: "xuc2078@gmail.com", hd: "" };
const STRANGER = { userId: "stranger@gmail.com", email: "stranger@gmail.com", hd: "" };
const AGENT_ONE = "00000000-0000-4000-8000-000000000011";
const AGENT_TWO = "00000000-0000-4000-8000-000000000012";

const server = http.createServer();
const hub = createHub(server, {
  authenticateAgent: () => OWNER,
  machineAliases: {
    "ip-172-31-7-169.ec2.internal": "MSB-REBYTE",
  },
  machineAccessAllowlist: {
    "msb rebyte": [SPECIAL.email],
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

async function connectMachine(port, machine, agentId) {
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
        os: "linux",
        arch: "arm64",
        tmux: "tmux 3.5",
        revision: "test",
        cwd: "/tmp/tmux-mobile",
        node: process.execPath,
      }),
    ),
  );
  return ws;
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

let rebyte;
let other;
try {
  rebyte = await connectMachine(port, "ip-172-31-7-169.ec2.internal", AGENT_ONE);
  const specialMachine = await waitFor("special viewer sees MSB-REBYTE", () => {
    const machines = hub.listMachines(SPECIAL);
    return machines.length === 1 && machines[0].hostname === "MSB-REBYTE" ? machines[0] : null;
  });

  assert.equal(specialMachine.machineId, "MSB-REBYTE");
  assert.equal(hub.hasMachine(SPECIAL, specialMachine.id), true);
  assert.equal(hub.hasMachine(SPECIAL, "MSB-REBYTE"), true);
  assert.deepEqual(hub.listMachines(STRANGER), [], "unlisted gmail user sees no owner machine");

  other = await connectMachine(port, "owner-private-box", AGENT_TWO);
  await waitFor("owner sees both machines", () => hub.listMachines(OWNER).length === 2);
  assert.deepEqual(
    hub.listMachines(SPECIAL).map((machine) => machine.hostname),
    ["MSB-REBYTE"],
    "special allowlist is scoped to the named machine only",
  );

  console.log("hub machine access allowlist tests passed");
} finally {
  rebyte?.disconnect();
  other?.disconnect();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
