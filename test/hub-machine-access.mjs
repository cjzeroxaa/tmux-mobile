import assert from "node:assert/strict";
import http from "node:http";
import { io } from "socket.io-client";
import { createHub } from "../lib/hub.mjs";
import { AGENT_WS_PATH, helloFrame } from "../lib/protocol.mjs";

const OWNER = { userId: "owner@rebyte.ai", email: "owner@rebyte.ai", hd: "rebyte.ai" };
const COLLEAGUE = {
  userId: "colleague@rebyte.ai",
  email: "colleague@rebyte.ai",
  hd: "rebyte.ai",
};
const STRANGER = { userId: "stranger@gmail.com", email: "stranger@gmail.com", hd: "" };
const ADMIN = { userId: "sonicgg@gmail.com", email: "sonicgg@gmail.com", hd: "" };
const SRP_USER = { userId: "engineer@srp.one", email: "engineer@srp.one", hd: "srp.one" };
const SRP_LOOKALIKE = {
  userId: "engineer@srp.one.evil",
  email: "engineer@srp.one.evil",
  hd: "srp.one.evil",
};
const AGENT_ONE = "00000000-0000-4000-8000-000000000011";
const AGENT_TWO = "00000000-0000-4000-8000-000000000012";

const server = http.createServer();
const hub = createHub(server, {
  authenticateAgent: () => OWNER,
  superAdminEmails: [ADMIN.email],
  machineShares: [
    {
      ownerEmail: OWNER.email,
      agentId: AGENT_ONE,
      domains: ["srp.one"],
    },
  ],
  machineAliases: {
    "msb-build-rebyte": "MSB-REBYTE",
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
  rebyte = await connectMachine(port, "msb-build-rebyte", AGENT_ONE);
  const ownerMachine = await waitFor("owner sees MSB-REBYTE", () => {
    const machines = hub.listMachines(OWNER);
    return machines.length === 1 && machines[0].hostname === "MSB-REBYTE" ? machines[0] : null;
  });

  assert.equal(ownerMachine.machineId, "MSB-REBYTE");
  assert.equal(hub.hasMachine(OWNER, ownerMachine.id), true);
  assert.equal(hub.hasMachine(OWNER, "MSB-REBYTE"), true);
  assert.deepEqual(hub.listMachines(COLLEAGUE), [], "same-domain user sees no owner machine");
  assert.deepEqual(hub.listMachines(STRANGER), [], "unlisted gmail user sees no owner machine");
  assert.equal(hub.listMachines(SRP_USER).length, 1, "shared domain sees the selected machine");
  assert.equal(hub.hasMachine(SRP_USER, ownerMachine.id), true, "shared domain can route to it");
  assert.equal(
    hub.sshAuthorizationTarget(SRP_USER, ownerMachine.id),
    null,
    "machine share does not grant owner-only SSH authorization",
  );
  assert.deepEqual(hub.listMachines(SRP_LOOKALIKE), [], "domain matching is exact");
  assert.equal(hub.listMachines(ADMIN).length, 1, "super-admin sees the owner machine");

  other = await connectMachine(port, "owner-private-box", AGENT_TWO);
  await waitFor("owner sees both machines", () => hub.listMachines(OWNER).length === 2);
  assert.deepEqual(
    hub.listMachines(COLLEAGUE),
    [],
    "same-domain user remains isolated when more machines connect",
  );
  assert.equal(hub.listMachines(ADMIN).length, 2, "super-admin sees every machine");
  assert.deepEqual(
    hub.listMachines(SRP_USER).map((machine) => machine.id),
    [ownerMachine.id],
    "domain share does not expose the owner's other machines",
  );

  console.log("hub owner-only machine access tests passed");
} finally {
  rebyte?.disconnect();
  other?.disconnect();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
