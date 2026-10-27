import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const temp = await mkdtemp(path.join(os.tmpdir(), "tmax-upload-http-"));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const api = `http://127.0.0.1:${port}`;
const secret = "upload-test-only-secret";
const email = "upload-test@example.com";
function token(type) {
  const body = Buffer.from(JSON.stringify({ type, userId: email, email, hd: "", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const cookie = `tmux_mobile_session=${token("session")}`;
process.env.TMUX_MOBILE_AGENT_CONFIG = path.join(temp, "agent.json");
process.env.TMUX_MOBILE_AGENT_ID = "a018a714-1fc7-4185-aede-e0a85c647001";
process.env.TMUX_MOBILE_UPLOAD_DIR = path.join(temp, "uploads");
process.env.AGENT_TOKEN = token("agent");
process.env.AGENT_MACHINE = "upload-test";
const child = spawn(process.execPath, ["server.mjs", "--controller"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SESSION_SECRET: secret,
    GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test",
    GOOGLE_DEVICE_CLIENT_ID: "test", GOOGLE_DEVICE_CLIENT_SECRET: "test", OPENAI_API_KEY: "test",
    ALLOW_ALL_GOOGLE_USERS: "1", TMUX_MOBILE_TRANSCRIPT_ARCHIVE_ENABLED: "0",
    TMUX_MOBILE_ARTIFACT_STORAGE: "local", TMUX_MOBILE_ARTIFACT_DIR: path.join(temp, "artifacts"),
    TMUX_MOBILE_COMMENT_INDEX: "memory", TMUX_MOBILE_PIN_INDEX: "memory" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "", agent;
child.stdout.on("data", data => output += data);
child.stderr.on("data", data => output += data);
async function waitFor(check) {
  for (let i = 0; i < 150; i++) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Controller/Connector did not become ready: ${output}`);
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const originalFetch = globalThis.fetch;
let transferToken, downloadStarted = false, tmuxCalls = 0;
globalThis.fetch = (url, options) => {
  if (String(url).endsWith("/agent/file-upload") && options?.signal) transferToken = options.headers["x-upload-token"];
  return originalFetch(url, options);
};
try {
  await waitFor(async () => (await fetch(`${api}/api/health`)).ok);
  const { runAgent } = await import("../lib/agent.mjs");
  const { localBackend } = await import("../lib/backend.mjs");
  agent = runAgent(api, { ...localBackend,
    tmux: async args => { tmuxCalls++; return args[0] === "-V" ? "tmux test" : ""; },
    writeTempFile: async (name, stream) => {
      assert.equal(typeof stream, "object", "file bytes must use HTTP, not base64 control frames");
      downloadStarted = true;
      if (name === "slow.mov") await new Promise(resolve => setTimeout(resolve, 18_000));
      return localBackend.writeTempFile(name, stream);
    },
  }, {
    inventoryProvider: async () => ({ agents: [], sessions: [] }),
  });
  const machine = await waitFor(async () => {
    const response = await fetch(`${api}/api/machines`, { headers: { cookie } });
    return (await response.json()).find(item => item.hostname === "upload-test" || item.machine === "upload-test");
  });
  const upload = (body, name = "clip.mov") => fetch(`${api}/api/upload?paneId=%253&name=${name}`, {
    method: "POST", headers: { cookie, "x-machine-id": machine.id, "content-type": "video/quicktime" }, body,
  });
  assert.equal((await fetch(`${api}/api/uploads`, { method: "POST", body: "{}" })).status, 401);
  const localDirect = await fetch(`${api}/api/uploads`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x.txt", size: 1 }) });
  assert.equal(localDirect.status, 501);
  assert.equal((await localDirect.json()).code, "direct_upload_unavailable");
  assert.equal((await fetch(`${api}/files/invalid/file.txt`, { redirect: "manual" })).status, 404, "invalid public file links must not redirect to login");
  assert.equal((await fetch(`${api}/api/upload?paneId=%253`, { method: "POST", body: "x" })).status, 401);
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  assert.equal((await fetch(`${api}/agent/file-upload`)).status, 401);
  assert.equal((await fetch(`${api}/agent/file-upload`, { headers: { authorization: `Bearer ${token("agent")}`, "x-upload-token": "unknown" } })).status, 404);
  // Cross both former caps. Delay one download beyond the old 15-second RPC
  // timeout while checking that ordinary control RPCs still complete.
  for (const size of [32, 80]) {
    const bytes = Buffer.alloc(size * 1024 * 1024, 0xa5);
    bytes[bytes.length - 1] = 0x7f;
    downloadStarted = false;
    const pending = upload(bytes, size === 32 ? "slow.mov" : "clip.mov");
    await waitFor(() => downloadStarted);
    const callsBefore = tmuxCalls;
    const control = await fetch(`${api}/api/sessions`, { headers: { cookie, "x-machine-id": machine.id } });
    assert.equal(control.status, 200, await control.text());
    assert.ok(tmuxCalls > callsBefore, "control RPC responds while file download is pending");
    const replay = await fetch(`${api}/agent/file-upload`, { headers: { authorization: `Bearer ${token("agent")}`, "x-upload-token": transferToken } });
    assert.equal(replay.status, 404, "download capability cannot be reused");
    const response = await pending;
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(path.dirname(result.path), process.env.TMUX_MOBILE_UPLOAD_DIR);
    assert.equal(hash(await readFile(result.path)), hash(bytes));
    console.log(`${size} MiB HTTP → Controller → Connector → file: exact SHA-256`);
  }
} finally {
  globalThis.fetch = originalFetch;
  agent?.stop();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await rm(temp, { recursive: true, force: true });
}
