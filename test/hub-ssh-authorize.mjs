import assert from "node:assert/strict";
import http from "node:http";
import { io } from "socket.io-client";
import { createHub } from "../lib/hub.mjs";
import {
  AGENT_OPS,
  AGENT_WS_PATH,
  MSG,
  OP,
  helloFrame,
  resOk,
} from "../lib/protocol.mjs";

const OWNER = { userId: "owner@example.com", email: "owner@example.com", hd: "example.com" };
const COLLEAGUE = {
  userId: "colleague@example.com",
  email: "colleague@example.com",
  hd: "example.com",
};
const ALLOWLISTED = {
  userId: "friend@gmail.com",
  email: "friend@gmail.com",
  hd: "",
};
const ADMIN = { userId: "admin@gmail.com", email: "admin@gmail.com", hd: "" };
const AGENT_ID = "00000000-0000-4000-8000-000000000071";

const server = http.createServer();
const hub = createHub(server, {
  authenticateAgent: () => OWNER,
  superAdminEmails: [ADMIN.email],
  machineAliases: { "owner-mac.local": "Owner Mac" },
  machineAccessAllowlist: { "Owner Mac": [ALLOWLISTED.email] },
});

function waitFor(label, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        const value = predicate();
        if (value) {
          clearInterval(timer);
          resolve(value);
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
    }, 20);
  });
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const connector = io(`http://127.0.0.1:${port}`, {
  path: AGENT_WS_PATH,
  transports: ["websocket"],
  reconnection: false,
  forceNew: true,
});
connector.on("connect_error", () => {});
await new Promise((resolve) => connector.once("connect", resolve));
connector.send(
  JSON.stringify(
    helloFrame({
      agentId: AGENT_ID,
      machine: "owner-mac.local",
      systemHostname: "owner-mac.local",
      username: "owner",
      sshHosts: ["owner-mac.local", "owner.example.ts.net", "100.64.0.71"],
      os: "darwin",
      arch: "arm64",
      revision: "test",
    }),
  ),
);

try {
  const machine = await waitFor("owner machine", () => hub.listMachines(OWNER)[0]);
  assert.equal(machine.systemHostname, "owner-mac.local");
  assert.equal(machine.username, "owner");
  assert.deepEqual(machine.sshHosts, [
    "owner-mac.local",
    "owner.example.ts.net",
    "100.64.0.71",
  ]);

  assert.ok(hub.sshAuthorizationTarget(OWNER, machine.id), "owner may authorize");
  assert.ok(hub.sshAuthorizationTarget(ADMIN, machine.id), "super admin may authorize");
  assert.equal(
    hub.sshAuthorizationTarget(COLLEAGUE, machine.id),
    null,
    "same-domain visibility does not grant a permanent shell",
  );
  assert.equal(
    hub.sshAuthorizationTarget(ALLOWLISTED, machine.id),
    null,
    "machine allowlist visibility does not grant a permanent shell",
  );
  assert.equal(
    hub.sshAuthorizationTarget(OWNER, "Owner Mac"),
    null,
    "authorization refuses alias fallback",
  );
  assert.equal(
    hub.sshAuthorizationTarget(OWNER, "owner-mac.local"),
    null,
    "authorization refuses hostname fallback",
  );

  let received = null;
  connector.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.t !== MSG.REQ || message.op !== OP.SSH_AUTHORIZE_KEY) return;
    received = message;
    connector.send(
      JSON.stringify(
        resOk(message.id, {
          installed: true,
          present: true,
          changed: true,
          fingerprint: "SHA256:test",
          systemHostname: "owner-mac.local",
          username: "owner",
          sshHosts: ["owner-mac.local", "owner.example.ts.net"],
          port: 22,
        }),
      ),
    );
  });

  const result = await hub.authorizeSshKey(OWNER, machine.id, {
    publicKey: "ssh-ed25519 AAAA",
    marker: "cjmux-ios:1111111111111111:2222222222222222",
  });
  assert.equal(result.installed, true);
  assert.equal(result.present, true);
  assert.equal(result.username, "owner");
  assert.deepEqual(result.sshHosts, ["owner-mac.local", "owner.example.ts.net"]);
  assert.equal(received.publicKey, "ssh-ed25519 AAAA");
  assert.equal(received.marker, "cjmux-ios:1111111111111111:2222222222222222");
  assert.deepEqual(
    Object.keys(received)
      .filter((key) => !["t", "id", "op"].includes(key))
      .sort(),
    ["marker", "publicKey"],
    "the Connector request contains no private credential or target path/user",
  );

  await assert.rejects(
    hub.authorizeSshKey(COLLEAGUE, machine.id, {
      publicKey: "ssh-ed25519 AAAA",
      marker: "cjmux-ios:1111111111111111:2222222222222222",
    }),
    (error) => error.status === 403,
  );

  const oldHello = {
    ...helloFrame({ machine: "old.local" }),
    ops: AGENT_OPS.filter((op) => op !== OP.SSH_AUTHORIZE_KEY),
  };
  assert.ok(!oldHello.ops.includes(OP.SSH_AUTHORIZE_KEY));

  console.log("hub SSH authorization tests passed");
} finally {
  connector.disconnect();
  hub.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
