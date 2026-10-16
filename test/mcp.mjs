import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newMcpKey, createMcpAuthenticator } from "../lib/mcp-access.mjs";
import { createMcpHttpHandler, selectMcpSessions, pageMcpTurns } from "../lib/mcp-server.mjs";

const owner = "owner@example.com";
const { key, record } = newMcpKey(owner);
let stored = record, now = 1, reads = 0;
const authenticate = createMcpAuthenticator({ store: { read: async () => { reads++; return stored; } }, superAdmins: [owner], now: () => now });
assert.equal(await authenticate(), null);
assert.equal(await authenticate("Bearer browser-session"), null);
assert.equal(reads, 0);
assert.ok((await Promise.all(Array.from({ length: 100 }, () => authenticate(`Bearer ${key}`)))).every(v => v.email === owner));
assert.equal(reads, 1, "Concurrent checks coalesce the database read");
assert.equal(await authenticate(`Bearer ${newMcpKey(owner).key}`), null);
stored = { ...record, ownerEmail: "other@example.com" }; now += 31_000;
assert.equal(await authenticate(`Bearer ${key}`), null, "Non-admin record cannot grant access");
stored = { ...record, revoked: true }; now += 31_000;
assert.equal(await authenticate(`Bearer ${key}`), null);
stored = record; now += 31_000;

const inventory = { machines: [{ id: "m1", hostname: "laptop", inventoryStatus: "stale" }], agents: Array.from({ length: 8 }, (_, i) => ({
  machineId: "m1", machineHostname: "laptop", mux: "tmux", paneId: `%${i}`, status: i % 2 ? "running" : "idle",
  lastActivityAt: new Date(1700000000000 + i * 1000).toISOString(),
  lastAssistantText: i === 7 ? "x".repeat(7000) : "done",
})) };
const recent = selectMcpSessions(inventory);
assert.deepEqual(recent.sessions.map(s => s.paneId), ["%7", "%6", "%5", "%4", "%3"]);
assert.equal(recent.sessions[0].lastAssistantTruncated, true);
assert.equal(recent.machines[0].inventoryStatus, "stale");
assert.equal(selectMcpSessions(inventory, { status: "running" }).sessions.length, 4);
assert.equal(selectMcpSessions(inventory, { machineId: "absent" }).sessions.length, 0);
const turns = Array.from({ length: 30 }, (_, i) => ({ role: "user", text: String(i).repeat(1000) }));
const last = pageMcpTurns({ turns }, { limit: 5 });
assert.deepEqual(last.turns, turns.slice(25));
assert.deepEqual(pageMcpTurns({ turns }, { before: last.nextBefore, limit: 5 }).turns, turns.slice(20, 25));

let mutations = [], archives = 0;
const service = {
  machines: async viewer => { assert.equal(viewer.email, owner); return { machines: inventory.machines }; },
  inventory: async () => inventory,
  run: async (viewer, action, args) => { mutations.push({ viewer, action, args }); return { ok: true }; },
  conversation: async () => { archives++; return { turns }; },
};
const handler = createMcpHttpHandler({ authenticate, service, allowedOrigins: ["https://eng.xyznot.com", "https://eng.impo.ai"] });
const server = http.createServer((req, res) => handler(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
const client = new Client({ name: "tmax-test", version: "1" });
try {
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${key}`, origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${key}` } })).status, 405);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 14);
  assert.equal(tools.find(t => t.name === "close_window").annotations.destructiveHint, true);
  const result = await client.callTool({ name: "get_active_sessions", arguments: {} });
  assert.equal(result.structuredContent.sessions.length, 5);
  assert.equal(archives, 0, "Active summary never reads S3");
  await client.callTool({ name: "list_machines", arguments: {} });
  const invalid = await client.callTool({ name: "send_prompt", arguments: { machineId: "m1", paneId: "%1", text: "hello" } });
  assert.equal(invalid.isError, true, "mux must be explicit");
  assert.equal(mutations.length, 0);
  const args = { machineId: "m1", mux: "rmux", paneId: "%1", text: "hello\n世界", enter: true };
  const sent = await client.callTool({ name: "send_prompt", arguments: args });
  assert.equal(sent.structuredContent.ok, true);
  assert.deepEqual(mutations[0].args, args);
  await client.callTool({ name: "read_conversation", arguments: { machineId: "m1", kind: "pi", agentSessionId: "test", limit: 5 } });
  assert.equal(archives, 1);
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log("MCP: real SDK handshake/tools, auth, origin, exact targets, activity ordering and history pagination passed");
