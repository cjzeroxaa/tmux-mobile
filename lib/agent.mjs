// Agent mode transport (`server.mjs --register <hubUrl>`). Dials the controller
// over Socket.IO and serves the controller's tmux/readdir requests using the
// local backend. Socket.IO owns connection management — reconnection with
// exponential backoff, heartbeat liveness (Engine.IO ping/pong on BOTH ends),
// and the connection/handshake timeout — so this file no longer hand-rolls any
// of that. It enforces the tmux subcommand allowlist so the controller can never
// make the agent run a dangerous tmux command.

import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { io } from "socket.io-client";
import {
  AGENT_WS_PATH,
  MSG,
  OP,
  helloFrame,
  inventoryFrame,
  isAllowedTmux,
  resErr,
  resOk,
} from "./protocol.mjs";
import { appRevision } from "./revision.mjs";

// Reconnection + heartbeat + handshake-timeout are all Socket.IO built-ins now
// (configured in the io() options below); these two values just tune them.
//
// Reconnect backoff ceiling. Kept low so a genuine drop recovers in seconds:
// Socket.IO grows the delay 1s, 2s, 4s, 8s and caps here rather than climbing.
const MAX_BACKOFF_MS = Number(process.env.AGENT_MAX_BACKOFF_MS) || 8_000;
// Connection (handshake) timeout. A dial can wedge BEFORE the connection is
// established — TCP connects but the upgrade never completes and no FIN/RST
// arrives — which an app-level ping (it only guards an open connection) can't
// catch. Socket.IO's `timeout` aborts such a dial and retries. This is the class
// of failure that stranded the whole fleet when the controller OOM-restarted.
const CONNECT_TIMEOUT_MS = Number(process.env.AGENT_CONNECT_TIMEOUT_MS) || 15_000;
const INVENTORY_POLL_MS = envMs("AGENT_INVENTORY_POLL_MS", 4_000);
const INVENTORY_TIMEOUT_MS = envMs("AGENT_INVENTORY_TIMEOUT_MS", 12_000);

export function agentAuthState(hubUrl) {
  if (process.env.AGENT_TOKEN) return { hasAuth: true, source: "AGENT_TOKEN" };
  if (loadStoredAgentToken(hubUrl)) return { hasAuth: true, source: "stored_config" };
  if (process.env.AGENT_SECRET) return { hasAuth: true, source: "legacy_secret" };
  return { hasAuth: false, source: "none" };
}

export function runAgent(
  hubUrl,
  backend,
  { logEvent = () => {}, inventoryProvider = null } = {},
) {
  const wsUrl = toWsUrl(hubUrl); // for logs only; Socket.IO dials hubUrl + path
  const machineName = process.env.AGENT_MACHINE || os.hostname();
  const agentId = ensureStoredAgentId(hubUrl);
  const agentRevision = appRevision(process.cwd());
  const agentCwd = process.cwd();
  const configToken = loadStoredAgentToken(hubUrl);
  const tokenSource = process.env.AGENT_TOKEN
    ? "AGENT_TOKEN"
    : configToken
      ? "stored_config"
      : "";
  const storedToken = process.env.AGENT_TOKEN || configToken;
  let stopped = false; // set on auth rejection, replacement, or stop()
  let stopInventoryPublisher = null;

  function backendMuxKinds() {
    if (typeof backend.muxKinds === "function") {
      const muxes = backend
        .muxKinds()
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => item === "tmux" || item === "rmux");
      if (muxes.length > 0) return [...new Set(muxes)];
    }
    const muxCommand =
      typeof backend.muxCommand === "function" ? backend.muxCommand() : "tmux";
    const mux =
      typeof backend.muxKind === "function"
        ? backend.muxKind()
        : path.basename(String(muxCommand || "tmux"));
    return [mux === "rmux" ? "rmux" : "tmux"];
  }

  async function describeMuxes() {
    const muxes = [];
    for (const mux of backendMuxKinds()) {
      const muxCommand =
        typeof backend.muxCommand === "function" ? backend.muxCommand(mux) : mux;
      try {
        muxes.push({
          mux,
          kind: mux,
          muxCommand,
          version: (await backend.tmux(["-V"], { mux, timeout: 3000 })).trim(),
        });
      } catch (error) {
        logEvent("agent_mux_unavailable", {
          controller: new URL(hubUrl).origin,
          machine: machineName,
          agentId,
          mux,
          muxCommand,
          message: error.message || String(error),
        });
      }
    }
    return muxes;
  }

  async function describeMux() {
    const muxes = await describeMuxes();
    const primary = muxes[0];
    if (primary) return { ...primary, muxes };
    const muxCommand =
      typeof backend.muxCommand === "function" ? backend.muxCommand() : "tmux";
    const mux =
      typeof backend.muxKind === "function"
        ? backend.muxKind()
        : path.basename(String(muxCommand || "tmux"));
    return { mux, kind: mux, muxCommand, version: "", muxes: [] };
  }

  // Credentials ride in the Socket.IO handshake `auth` payload; the controller's
  // io.use() middleware reads them. Prefer the device token; fall back to the
  // legacy shared secret / user for old setups.
  const auth = {};
  if (storedToken) {
    auth.token = storedToken;
  } else {
    if (process.env.AGENT_USER) auth.user = process.env.AGENT_USER;
    if (process.env.AGENT_SECRET) auth.secret = process.env.AGENT_SECRET;
  }

  const socket = io(hubUrl, {
    path: AGENT_WS_PATH,
    transports: ["websocket"], // Node<->Node; skip the long-polling fallback
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: MAX_BACKOFF_MS,
    timeout: CONNECT_TIMEOUT_MS,
    auth,
  });

  socket.on("connect", async () => {
    logEvent("agent_registered", {
      controller: new URL(hubUrl).origin,
      websocket: wsUrl,
      machine: machineName,
      agentId,
      auth: storedToken ? "device_token" : "legacy_secret",
      tokenSource: tokenSource || undefined,
      message: "Agent connected and is registering this machine with the controller.",
    });
    const muxInfo = await describeMux();
    socket.send(
      JSON.stringify(
        helloFrame({
          agentId,
          machine: machineName,
          os: process.platform,
          arch: process.arch,
          tmux: muxInfo.version,
          mux: muxInfo.mux,
          muxCommand: muxInfo.muxCommand,
          muxVersion: muxInfo.version,
          muxes: muxInfo.muxes,
          revision: agentRevision,
          cwd: agentCwd,
          homeDir: os.homedir(),
          node: process.execPath,
        }),
      ),
    );
    if (stopInventoryPublisher) stopInventoryPublisher();
    stopInventoryPublisher = startInventoryPublisher(socket, inventoryProvider, {
      hubUrl,
      machineName,
      agentId,
      logEvent,
    });
  });

  // The controller brokers requests as JSON "message" frames; the agent answers
  // each by id. (Kept as message frames rather than per-op events so the wire
  // contract in protocol.mjs is unchanged across the transport swap.)
  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === MSG.INFO) return; // controller revision info; not acted on
    if (msg.t !== MSG.REQ) return;
    try {
      if (msg.op === OP.TMUX) {
        if (!isAllowedTmux(msg.args)) {
          throw new Error(`tmux subcommand not allowed: ${msg.args?.[0]}`);
        }
        const stdout = await backend.tmux(msg.args, {
          ...(msg.options || {}),
          mux: msg.mux || msg.options?.mux,
        });
        socket.send(JSON.stringify(resOk(msg.id, { stdout })));
      } else if (msg.op === OP.READDIR) {
        const entries = await backend.readdir(msg.path);
        socket.send(JSON.stringify(resOk(msg.id, { entries })));
      } else if (msg.op === OP.BRANCH) {
        const info = await backend.branch(msg.path);
        socket.send(JSON.stringify(resOk(msg.id, info)));
      } else if (msg.op === OP.READFILE) {
        const result = await backend.readfile(msg.path, {
          baseDir: msg.baseDir,
          maxBytes: msg.maxBytes,
        });
        socket.send(JSON.stringify(resOk(msg.id, result)));
      } else if (msg.op === OP.REPO) {
        const info = await backend.repo(msg.path);
        socket.send(JSON.stringify(resOk(msg.id, info)));
      } else if (msg.op === OP.PANECMD) {
        const result = await backend.paneCommand(msg.tty);
        socket.send(JSON.stringify(resOk(msg.id, result)));
      } else if (msg.op === OP.WRITEFILE) {
        const result = await backend.writeTempFile(msg.name, msg.base64);
        socket.send(JSON.stringify(resOk(msg.id, result)));
      } else if (msg.op === OP.PROCESS_TREE) {
        const processes = await backend.processTree(msg.rootPid);
        socket.send(JSON.stringify(resOk(msg.id, { processes })));
      } else if (msg.op === OP.AGENT_LAST_RESPONSE) {
        // The transcript lives on the agent machine — read it here and
        // hand the result back as one round-trip.
        const result = await backend.agentLastResponse({
          rootPid: msg.rootPid,
          cwd: msg.cwd,
        });
        socket.send(JSON.stringify(resOk(msg.id, { result })));
      } else if (msg.op === OP.AGENT_TRANSCRIPT) {
        const result = await backend.agentTranscript({
          rootPid: msg.rootPid,
          cwd: msg.cwd,
        });
        socket.send(JSON.stringify(resOk(msg.id, { result })));
      } else if (msg.op === OP.WORKTREE_ADD) {
        const result = await backend.worktreeAdd({
          fromDir: msg.fromDir,
          branch: msg.branch,
        });
        socket.send(JSON.stringify(resOk(msg.id, result)));
      } else if (msg.op === OP.RMUX_WEB_SHARE) {
        const result = await backend.rmuxWebShare({
          target: msg.target,
          ttlSeconds: msg.ttlSeconds,
          tunnelProvider: msg.tunnelProvider,
        });
        socket.send(JSON.stringify(resOk(msg.id, result)));
      } else {
        throw new Error(`unknown op: ${msg.op}`);
      }
    } catch (error) {
      socket.send(JSON.stringify(resErr(msg.id, error)));
    }
  });

  // Auth rejection from the controller's middleware is PERMANENT — a
  // bad/missing/expired token or a connector too old for this controller's auth.
  // Retrying forever just loops with an opaque error, so stop and tell the user
  // what to do. Any other connect_error is transient: Socket.IO keeps retrying.
  socket.on("connect_error", (error) => {
    if (stopped) return;
    if (error?.data?.code === "auth") {
      stopped = true;
      logEvent("agent_auth_rejected", {
        controller: new URL(hubUrl).origin,
        machine: machineName,
        agentId,
        authSource: tokenSource || "none",
        message: storedToken
          ? `Controller rejected this machine's agent token. It may be expired, for a different account, or this connector is out of date. Re-authenticate: node server.mjs --register ${new URL(hubUrl).origin} --login (and 'git pull' if the connector is old).`
          : `Controller requires a Google login but no agent token is stored. Run: node server.mjs --register ${new URL(hubUrl).origin} --login`,
      });
      socket.io.reconnection(false);
      socket.disconnect();
      logEvent("agent_stopped", {
        controller: new URL(hubUrl).origin,
        machine: machineName,
        agentId,
        message: "Stopped: controller rejected authentication. Re-run with --login.",
      });
      return;
    }
    logEvent("agent_connection_error", {
      controller: new URL(hubUrl).origin,
      machine: machineName,
      agentId,
      message: error?.message || String(error),
    });
  });

  socket.on("disconnect", (reason) => {
    if (stopInventoryPublisher) {
      stopInventoryPublisher();
      stopInventoryPublisher = null;
    }
    if (stopped || reason === "io client disconnect") return; // our own stop()
    // The controller force-disconnected this socket because a newer connector
    // registered the same machine. Socket.IO will NOT auto-reconnect after an
    // "io server disconnect", which is exactly what we want for a replaced
    // (stale) connector — don't fight the replacement.
    if (reason === "io server disconnect") {
      stopped = true;
      logEvent("agent_stopped", {
        controller: new URL(hubUrl).origin,
        machine: machineName,
        agentId,
        message: "Stopped: another connector registered this machine.",
      });
      return;
    }
    // Any other reason (transport close, ping timeout, transport error):
    // Socket.IO reconnects automatically with backoff.
    logEvent("agent_reconnect_scheduled", {
      controller: new URL(hubUrl).origin,
      machine: machineName,
      agentId,
      reason,
      message: "Agent disconnected; Socket.IO is retrying the controller connection.",
    });
  });

  return {
    stop() {
      stopped = true;
      if (stopInventoryPublisher) {
        stopInventoryPublisher();
        stopInventoryPublisher = null;
      }
      try {
        socket.io.reconnection(false);
        socket.disconnect();
      } catch {}
    },
  };
}

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function startInventoryPublisher(
  ws,
  inventoryProvider,
  { hubUrl, machineName, agentId, logEvent = () => {} } = {},
) {
  if (typeof inventoryProvider !== "function" || INVENTORY_POLL_MS <= 0) return () => {};
  let stopped = false;
  let timer = null;
  let sequence = 0;
  let inFlight = null;

  async function tick() {
    if (stopped || inFlight || !ws.connected) return;
    const startedAt = Date.now();
    const scan = Promise.resolve().then(() => inventoryProvider());
    inFlight = scan;
    let timedOut = false;
    try {
      const result = await withTimeout(scan, INVENTORY_TIMEOUT_MS, "Command Center inventory scan");
      if (stopped || !ws.connected) return;
      const agents = Array.isArray(result?.agents) ? result.agents : [];
      sendInventory(ws, {
        ok: true,
        sequence: ++sequence,
        observedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        agents,
      });
    } catch (error) {
      timedOut = Boolean(error?.timeout);
      if (!stopped && ws.connected) {
        sendInventory(ws, {
          ok: false,
          sequence: ++sequence,
          observedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          error: { message: error?.message || String(error) },
        });
      }
      if (!timedOut) {
        logEvent("agent_inventory_scan_failed", {
          controller: new URL(hubUrl).origin,
          machine: machineName,
          agentId,
          message: error?.message || String(error),
        });
      }
    } finally {
      if (timedOut) {
        scan
          .finally(() => {
            if (inFlight === scan) inFlight = null;
          })
          .catch(() => {});
      } else if (inFlight === scan) {
        inFlight = null;
      }
    }
  }

  timer = setInterval(() => {
    void tick();
  }, INVENTORY_POLL_MS);
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function sendInventory(ws, info) {
  try {
    ws.send(JSON.stringify(inventoryFrame(info)));
  } catch {}
}

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out`);
        error.timeout = true;
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function loginAgent(hubUrl, { log = console.log } = {}) {
  const start = await postJson(new URL("/auth/device/start", hubUrl), {});
  log("tmux-mobile agent needs Google device login before it can register this machine.");
  log(`Controller: ${new URL(hubUrl).origin}`);
  log(`Open in a browser: ${start.verificationUrlComplete || start.verificationUrl}`);
  if (!start.verificationUrlComplete) log(`Enter code: ${start.userCode}`);
  log("Waiting for Google authorization...");

  let intervalMs = Math.max(Number(start.interval || 5), 1) * 1000;
  const expiresAt = Date.now() + Math.max(Number(start.expiresIn || 600), 60) * 1000;
  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const response = await fetch(new URL("/auth/device/poll", hubUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: start.id }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) {
      intervalMs = Math.max(Number(body.interval || start.interval || 5), 1) * 1000;
      continue;
    }
    if (!response.ok) {
      throw new Error(body.error || `Device login failed with HTTP ${response.status}`);
    }
    if (!body.token) throw new Error("Device login did not return an agent token");
    const savedPath = await saveStoredAgentToken(hubUrl, body.token, body.user || {});
    log(`Google login complete: ${body.user?.email || "Google user"}.`);
    log(`Agent token saved: ${savedPath}`);
    log("Starting agent registration with the controller...");
    return body;
  }
  throw new Error("Device login expired");
}

function toWsUrl(hubUrl) {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = AGENT_WS_PATH;
  url.search = "";
  return url.toString();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function controllerKey(hubUrl) {
  const url = new URL(hubUrl);
  return url.origin;
}

function agentConfigPath() {
  return (
    process.env.TMUX_MOBILE_AGENT_CONFIG ||
    path.join(os.homedir(), ".config", "tmux-mobile", "agent.json")
  );
}

function loadStoredAgentToken(hubUrl) {
  try {
    const config = JSON.parse(
      readFileSync(agentConfigPath(), "utf8") || "{}",
    );
    return config.controllers?.[controllerKey(hubUrl)]?.token || "";
  } catch {
    return "";
  }
}

function ensureStoredAgentId(hubUrl) {
  const envId = normalizeAgentId(process.env.TMUX_MOBILE_AGENT_ID || process.env.AGENT_ID);
  if (envId) return envId;

  const filePath = agentConfigPath();
  let config = {};
  try {
    config = JSON.parse(readFileSync(filePath, "utf8") || "{}");
  } catch {}
  config.controllers ||= {};
  const key = controllerKey(hubUrl);
  config.controllers[key] ||= {};
  const existing = normalizeAgentId(config.controllers[key].agentId);
  if (existing) return existing;

  const agentId = randomUUID();
  config.controllers[key].agentId = agentId;
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return agentId;
}

async function readAgentConfig() {
  try {
    return JSON.parse(await readFile(agentConfigPath(), "utf8"));
  } catch {
    return {};
  }
}

async function saveStoredAgentToken(hubUrl, token, user) {
  const filePath = agentConfigPath();
  const config = await readAgentConfig();
  config.controllers ||= {};
  const key = controllerKey(hubUrl);
  config.controllers[key] = {
    ...(config.controllers[key] || {}),
    token,
    user,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return filePath;
}

function normalizeAgentId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? id
    : "";
}
