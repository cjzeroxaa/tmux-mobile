import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const WEB_CLIENT_ID = "web-client.test";
const WEB_CLIENT_SECRET = "web-secret";
const DEVICE_CLIENT_ID = "device-client.test";
const DEVICE_CLIENT_SECRET = "device-secret";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CONSUMER = "consumer@gmail.com";
const ADMIN = "sonicgg@gmail.com";
const children = [];
const sessionsToClean = new Set();

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startNode(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    child.output += chunk;
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk;
    if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${chunk}`);
  });
  children.push({ name, child });
  return child;
}

function assertAlive(name, child) {
  if (child.exitCode !== null) {
    throw new Error(`${name} exited early with ${child.exitCode}\n${child.output}`);
  }
}

async function waitFor(label, fn, { timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`${label} timed out: ${lastError?.message || "no result"}`);
}

async function formBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function startFakeGoogle(deviceEmails) {
  const authCodes = new Map();
  const deviceCodes = new Map();
  const idTokens = new Map();
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/auth") {
      const email = (url.searchParams.get("login_hint") || ALICE).toLowerCase();
      const code = `code-${++seq}`;
      authCodes.set(code, {
        aud: url.searchParams.get("client_id"),
        email,
      });
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { location: redirect.toString() });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/device/code") {
      const body = await formBody(req);
      const email = (deviceEmails.shift() || ALICE).toLowerCase();
      const deviceCode = `device-${++seq}`;
      deviceCodes.set(deviceCode, {
        aud: body.get("client_id"),
        email,
      });
      sendJson(res, 200, {
        device_code: deviceCode,
        user_code: `USER-${seq}`,
        verification_url: `${baseUrl(server)}/device`,
        verification_url_complete: `${baseUrl(server)}/device?code=USER-${seq}`,
        expires_in: 600,
        interval: 1,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const body = await formBody(req);
      let item;
      if (body.get("grant_type") === "authorization_code") {
        item = authCodes.get(body.get("code"));
        assert.equal(body.get("client_secret"), WEB_CLIENT_SECRET);
      } else if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        item = deviceCodes.get(body.get("device_code"));
        assert.equal(body.get("client_secret"), DEVICE_CLIENT_SECRET);
      }
      if (!item) {
        sendJson(res, 400, { error: "authorization_pending" });
        return;
      }
      const idToken = `id-${++seq}`;
      idTokens.set(idToken, {
        aud: item.aud,
        email: item.email,
        email_verified: "true",
        ...(hostedDomainFor(item.email) ? { hd: hostedDomainFor(item.email) } : {}),
        sub: `sub-${item.email}`,
      });
      sendJson(res, 200, {
        access_token: `access-${seq}`,
        expires_in: 3600,
        id_token: idToken,
        token_type: "Bearer",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/tokeninfo") {
      const claims = idTokens.get(url.searchParams.get("id_token"));
      if (!claims) {
        sendJson(res, 400, { error: "invalid_token" });
        return;
      }
      sendJson(res, 200, claims);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const port = await getFreePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function hostedDomainFor(email) {
  const normalized = String(email || "").toLowerCase();
  if (normalized.endsWith("@example.com")) return "example.com";
  return "";
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function loginBrowser(baseUrl, email) {
  const login = await fetch(
    `${baseUrl}/auth/google/login?returnTo=/api/machines&loginHint=${encodeURIComponent(email)}`,
    { redirect: "manual" },
  );
  assert.equal(login.status, 302);
  const fakeAuth = await fetch(login.headers.get("location"), { redirect: "manual" });
  assert.equal(fakeAuth.status, 302);
  const callback = await fetch(fakeAuth.headers.get("location"), { redirect: "manual" });
  assert.equal(callback.status, 302);
  const cookie = callback.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "OAuth callback did not set a session cookie");
  return cookie;
}

async function requestJson(baseUrl, pathName, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.machineId) headers["x-machine-id"] = options.machineId;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const text = await response.text();
  assert.equal(
    response.status,
    options.status || 200,
    `${pathName} returned ${response.status}: ${text}`,
  );
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function startAgent(baseUrl, email, machineName, configDir) {
  return startNode(`agent-${email}-${machineName}`, ["server.mjs", "--register", baseUrl], {
    AGENT_MACHINE: machineName,
    TMUX_MOBILE_AGENT_CONFIG: path.join(configDir, `${machineName}.json`),
  });
}

function tmux(args) {
  execFileSync("tmux", args, { stdio: "ignore" });
}

async function stopChildren() {
  for (const { child } of children.toReversed()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", resolve);
          setTimeout(resolve, 1500);
        }),
    ),
  );
}

async function waitForMachines(baseUrl, cookie, expectedIds) {
  return waitFor(`machines ${expectedIds.join(",")}`, async () => {
    const machines = await requestJson(baseUrl, "/api/machines", { cookie });
    const ids = machines.map((machine) => machine.machineId || machine.id).sort();
    assert.deepEqual(ids, [...expectedIds].sort());
    assert.ok(machines.every((machine) => machine.online));
    return machines;
  });
}

function routeForMachine(machines, machineId) {
  const machine = machines.find((item) => (item.machineId || item.id) === machineId);
  assert.ok(machine, `missing machine ${machineId}`);
  return machine.id;
}

async function exerciseTmux(baseUrl, cookie, email, machineId) {
  const sessionName = `tmux_mobile_e2e_${email.split("@")[0]}_${process.pid}_${Date.now()}`;
  sessionsToClean.add(sessionName);

  const session = await requestJson(baseUrl, "/api/sessions", {
    cookie,
    machineId,
    body: { name: sessionName },
  });
  assert.equal(session.name, sessionName);

  const sessions = await requestJson(baseUrl, "/api/sessions", { cookie, machineId });
  assert.ok(sessions.some((item) => item.name === sessionName));

  const windows = await requestJson(
    baseUrl,
    `/api/windows?sessionId=${encodeURIComponent(session.id)}`,
    { cookie, machineId },
  );
  assert.ok(windows.length > 0);

  // Window annotation: set a follow-up note, confirm it round-trips through
  // /api/windows (per-window), then clear it.
  const noteText = `follow up: deploy ${process.pid}`;
  const annotated = await requestJson(baseUrl, "/api/windows", {
    cookie,
    machineId,
    method: "PATCH",
    body: { windowId: windows[0].id, annotation: noteText },
  });
  assert.equal(annotated.annotation, noteText, "window annotation set");
  const refetched = await requestJson(
    baseUrl,
    `/api/windows?sessionId=${encodeURIComponent(session.id)}`,
    { cookie, machineId },
  );
  assert.ok(
    refetched.some((w) => w.id === windows[0].id && w.annotation === noteText),
    "annotation visible in window list",
  );
  const cleared = await requestJson(baseUrl, "/api/windows", {
    cookie,
    machineId,
    method: "PATCH",
    body: { windowId: windows[0].id, annotation: "" },
  });
  assert.equal(cleared.annotation, "", "window annotation cleared");

  // Window ops: create a new window, duplicate it, then close (kill) one and
  // confirm the count returns to baseline.
  const baseCount = (
    await requestJson(baseUrl, `/api/windows?sessionId=${encodeURIComponent(session.id)}`, { cookie, machineId })
  ).length;
  const newWin = await requestJson(baseUrl, "/api/windows", {
    cookie,
    machineId,
    body: { sessionId: session.id },
  });
  assert.ok(newWin.id, "new window created");
  // Duplicate-info endpoint returns suggested name/command/cwd.
  const dupInfo = await requestJson(
    baseUrl,
    `/api/window-duplicate-info?windowId=${encodeURIComponent(newWin.id)}`,
    { cookie, machineId },
  );
  assert.ok(dupInfo.sessionId === session.id && "command" in dupInfo, "duplicate info");
  // Duplicate with an adjusted name; the override is honored.
  const dupWin = await requestJson(baseUrl, "/api/windows", {
    cookie,
    machineId,
    body: { duplicateFrom: newWin.id, name: "dup-edited", command: "" },
  });
  assert.ok(dupWin.id && dupWin.id !== newWin.id, "duplicate window created");
  assert.equal(dupWin.name, "dup-edited", "duplicate honored adjusted name");
  const afterCreate = await requestJson(baseUrl, `/api/windows?sessionId=${encodeURIComponent(session.id)}`, { cookie, machineId });
  assert.equal(afterCreate.length, baseCount + 2, "two windows added");
  // Close both extras.
  await requestJson(baseUrl, "/api/windows", { cookie, machineId, method: "DELETE", body: { windowId: dupWin.id } });
  await requestJson(baseUrl, "/api/windows", { cookie, machineId, method: "DELETE", body: { windowId: newWin.id } });
  const afterClose = await requestJson(baseUrl, `/api/windows?sessionId=${encodeURIComponent(session.id)}`, { cookie, machineId });
  assert.equal(afterClose.length, baseCount, "windows closed back to baseline");

  const panes = await requestJson(
    baseUrl,
    `/api/panes?windowId=${encodeURIComponent(windows[0].id)}`,
    { cookie, machineId },
  );
  assert.ok(panes.length > 0);

  const token = `tmux-mobile-e2e-${email}-${process.pid}`;
  await requestJson(baseUrl, "/api/send", {
    cookie,
    machineId,
    body: {
      paneId: panes[0].id,
      text: `printf '${token}\\n'`,
      enter: true,
      submitNudge: false,
    },
  });

  await waitFor(`${email} sent command capture`, async () => {
    const capture = await requestJson(
      baseUrl,
      `/api/capture?paneId=${encodeURIComponent(panes[0].id)}&mode=tail&lines=80`,
      { cookie, machineId },
    );
    assert.match(capture.text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  const finalWindows = await requestJson(
    baseUrl,
    `/api/windows?sessionId=${encodeURIComponent(session.id)}`,
    { cookie, machineId },
  );
  assert.equal(finalWindows.length, 1, "one window remains before deleting the session");
  const deletedLast = await requestJson(baseUrl, "/api/windows", {
    cookie,
    machineId,
    method: "DELETE",
    body: { windowId: finalWindows[0].id },
  });
  assert.equal(deletedLast.killedSession, true, "deleting the last window kills the session");
  const sessionsAfterDelete = await requestJson(baseUrl, "/api/sessions", { cookie, machineId });
  assert.ok(!sessionsAfterDelete.some((item) => item.name === sessionName), "session removed after deleting last window");
  sessionsToClean.delete(sessionName);
}

let fakeGoogle;
let tmpDir;

try {
  fakeGoogle = await startFakeGoogle([ALICE, ALICE, BOB, CONSUMER]);
  tmpDir = await mkdtemp(path.join(tmpdir(), "tmux-mobile-e2e-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const controller = startNode("controller", ["server.mjs", "--controller"], {
    HOST: "127.0.0.1",
    PORT: String(port),
    GOOGLE_AUTH_URL: `${fakeGoogle.url}/auth`,
    GOOGLE_TOKEN_URL: `${fakeGoogle.url}/token`,
    GOOGLE_DEVICE_CODE_URL: `${fakeGoogle.url}/device/code`,
    GOOGLE_TOKENINFO_URL: `${fakeGoogle.url}/tokeninfo`,
    GOOGLE_OAUTH_CLIENT_ID: WEB_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: WEB_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: `${baseUrl}/auth/google/callback`,
    GOOGLE_DEVICE_CLIENT_ID: DEVICE_CLIENT_ID,
    GOOGLE_DEVICE_CLIENT_SECRET: DEVICE_CLIENT_SECRET,
    OPENAI_API_KEY: "test-openai-key",
    SESSION_SECRET: `session-secret-${process.pid}`,
    ALLOW_ALL_GOOGLE_USERS: "1",
    SUPER_ADMIN_EMAILS: ADMIN,
  });

  await waitFor("controller health", async () => {
    assertAlive("controller", controller);
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
  });

  const unauthenticatedApi = await fetch(`${baseUrl}/api/machines`);
  assert.equal(unauthenticatedApi.status, 401);
  const unauthenticatedPage = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(unauthenticatedPage.status, 302);
  assert.match(unauthenticatedPage.headers.get("location"), /^\/auth\/google\/login/);

  const aliceCookie = await loginBrowser(baseUrl, ALICE);
  const bobCookie = await loginBrowser(baseUrl, BOB);
  const consumerCookie = await loginBrowser(baseUrl, CONSUMER);
  const adminCookie = await loginBrowser(baseUrl, ADMIN);

  const aliceOne = `alice-one-${process.pid}`;
  const aliceTwo = `alice-two-${process.pid}`;
  const bobOne = `bob-one-${process.pid}`;
  const consumerOne = `consumer-one-${process.pid}`;

  const aliceAgentOne = startAgent(baseUrl, ALICE, aliceOne, tmpDir);
  let aliceMachines = await waitForMachines(baseUrl, aliceCookie, [aliceOne]);
  assert.equal(
    aliceMachines.find((machine) => machine.machineId === aliceOne)?.homeDir,
    homedir(),
    "agent advertises home directory for start-agent defaults",
  );
  await waitForMachines(baseUrl, bobCookie, [aliceOne]);
  assert.deepEqual(await requestJson(baseUrl, "/api/machines", { cookie: consumerCookie }), []);
  assertAlive("alice-agent-one", aliceAgentOne);

  const aliceAgentTwo = startAgent(baseUrl, ALICE, aliceTwo, tmpDir);
  aliceMachines = await waitForMachines(baseUrl, aliceCookie, [aliceOne, aliceTwo]);
  await waitForMachines(baseUrl, bobCookie, [aliceOne, aliceTwo]);
  assertAlive("alice-agent-two", aliceAgentTwo);

  const aliceOneRoute = routeForMachine(aliceMachines, aliceOne);
  await requestJson(baseUrl, "/api/sessions", {
    cookie: consumerCookie,
    machineId: aliceOneRoute,
    status: 503,
  });
  await requestJson(baseUrl, "/api/command-center", {
    cookie: consumerCookie,
    machineId: aliceOneRoute,
    status: 503,
  });
  await requestJson(baseUrl, "/api/sessions", { cookie: bobCookie, machineId: aliceOneRoute });

  const bobAgent = startAgent(baseUrl, BOB, bobOne, tmpDir);
  const bobMachines = await waitForMachines(baseUrl, bobCookie, [aliceOne, aliceTwo, bobOne]);
  await waitForMachines(baseUrl, aliceCookie, [aliceOne, aliceTwo, bobOne]);
  assertAlive("bob-agent", bobAgent);

  const bobOneRoute = routeForMachine(bobMachines, bobOne);
  await requestJson(baseUrl, "/api/sessions", { cookie: aliceCookie, machineId: bobOneRoute });
  const bobCommandCenter = await requestJson(baseUrl, "/api/command-center", {
    cookie: aliceCookie,
    machineId: bobOneRoute,
  });
  assert.equal(bobCommandCenter.machines.length, 1, "per-machine command-center machine count");
  assert.equal(bobCommandCenter.machines[0].id, bobOneRoute, "per-machine command-center route id");
  assert.equal(
    bobCommandCenter.machines[0].homeDir,
    homedir(),
    "command-center machine metadata includes home directory",
  );
  assert.ok(
    bobCommandCenter.agents.every((agent) => agent.machineId === bobOneRoute),
    "per-machine command-center only returns requested machine agents",
  );

  const consumerAgent = startAgent(baseUrl, CONSUMER, consumerOne, tmpDir);
  const consumerMachines = await waitForMachines(baseUrl, consumerCookie, [consumerOne]);
  assertAlive("consumer-agent", consumerAgent);
  const consumerOneRoute = routeForMachine(consumerMachines, consumerOne);
  await requestJson(baseUrl, "/api/sessions", {
    cookie: aliceCookie,
    machineId: consumerOneRoute,
    status: 503,
  });
  await waitForMachines(baseUrl, adminCookie, [aliceOne, aliceTwo, bobOne, consumerOne]);

  const runtime = await requestJson(baseUrl, "/api/runtime", { cookie: aliceCookie });
  assert.equal(runtime.mode, "hub");

  await exerciseTmux(baseUrl, aliceCookie, ALICE, aliceOneRoute);
  await exerciseTmux(baseUrl, bobCookie, BOB, bobOneRoute);
  await exerciseTmux(baseUrl, consumerCookie, CONSUMER, consumerOneRoute);

  console.log("controller oauth/device multi-user e2e passed");
} finally {
  for (const sessionName of sessionsToClean) {
    try {
      tmux(["kill-session", "-t", sessionName]);
    } catch {}
  }
  await stopChildren();
  if (fakeGoogle) await fakeGoogle.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
}
