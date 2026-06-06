// Agent mode transport (`server.mjs --register <hubUrl>`). Dials the hub over an
// outbound WebSocket (no inbound port needed), announces this machine, then
// serves the hub's tmux/readdir requests using the local backend. Reconnects
// with exponential backoff. Enforces the tmux subcommand allowlist so the hub
// can never run anything outside the known-safe set.

import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import {
  AGENT_WS_PATH,
  MSG,
  OP,
  helloFrame,
  isAllowedTmux,
  resErr,
  resOk,
} from "./protocol.mjs";

// Reconnect backoff ceiling. Kept low so a genuine drop recovers in seconds:
// backoff grows 1s, 2s, 4s, 8s and stays there rather than climbing to 30s.
const MAX_BACKOFF_MS = Number(process.env.AGENT_MAX_BACKOFF_MS) || 8_000;
// First-retry delay after a DELIBERATE controller restart (WS close code 1012).
// Near-instant (vs the 1s normal backoff) because Cloud Run already has the new
// revision ready — this shrinks the browser-visible "no machine" gap on deploy.
const FAST_RECONNECT_MS = Number(process.env.AGENT_FAST_RECONNECT_MS) || 250;
// Liveness: the agent pings the controller and expects a pong back. When the
// controller (Cloud Run) restarts, the old container is torn down and the TCP
// connection can be silently orphaned — no FIN/RST reaches us, so `ws.on("close")`
// never fires and the reconnect path never runs. Pinging and terminating a
// connection that misses pongs forces a `close`, which drives the backoff
// reconnect below. A graceful deploy is handled separately: the controller
// closes agent sockets on SIGTERM, so the agent re-dials immediately rather
// than waiting out this timeout.
//
// Timing: a 5s ping with a 12s timeout tolerates ~2 missed pongs before
// declaring the peer dead, detecting a real drop in ≤12s without false-tripping
// on a single lost packet.
const PING_INTERVAL_MS = Number(process.env.AGENT_PING_INTERVAL_MS) || 5_000;
const PONG_TIMEOUT_MS = Number(process.env.AGENT_PONG_TIMEOUT_MS) || 12_000;
// Revision migration: on a Cloud Run deploy the agent's live WebSocket keeps the
// OLD instance alive, so the controller never gets SIGTERM and never closes us —
// the agent would stay pinned to stale code indefinitely. So the agent itself
// polls the controller's /api/runtime revision; when it changes from the one we
// connected to, we re-dial (terminate → existing reconnect) onto the new
// revision. Set AGENT_REVISION_POLL_MS=0 to disable.
const REVISION_POLL_MS =
  process.env.AGENT_REVISION_POLL_MS === undefined
    ? 5_000 // poll the controller's revision every 5s so a no-SIGTERM deploy
            // (old instance lingers) is detected in ~5s instead of ~15s; the
            // extra /api/health traffic is one tiny GET per agent per interval.
    : Number(process.env.AGENT_REVISION_POLL_MS);

export function agentAuthState(hubUrl) {
  if (process.env.AGENT_TOKEN) return { hasAuth: true, source: "AGENT_TOKEN" };
  if (loadStoredAgentToken(hubUrl)) return { hasAuth: true, source: "stored_config" };
  if (process.env.AGENT_SECRET) return { hasAuth: true, source: "legacy_secret" };
  return { hasAuth: false, source: "none" };
}

export function runAgent(hubUrl, backend, { logEvent = () => {} } = {}) {
  const wsUrl = toWsUrl(hubUrl);
  const machineName = process.env.AGENT_MACHINE || os.hostname();
  const configToken = loadStoredAgentToken(hubUrl);
  const tokenSource = process.env.AGENT_TOKEN
    ? "AGENT_TOKEN"
    : configToken
      ? "stored_config"
      : "";
  const storedToken = process.env.AGENT_TOKEN || configToken;
  let backoff = 1_000;
  let stopped = false;
  let authRejected = false; // permanent auth failure (401/403) — don't reconnect
  let activeWs = null; // current socket, so stop() can close it
  let reconnectTimer = null; // pending reconnect, so stop() can cancel it

  async function describeTmux() {
    try {
      return (await backend.tmux(["-V"])).trim();
    } catch {
      return "";
    }
  }

  // Fetch the controller's current revision over HTTP. Uses /api/health, which
  // is public (no browser auth) and already reports the revision — unlike
  // /api/runtime, which is behind browser auth and 401s for the agent. Returns
  // "" on any error (network blip, missing field) so a transient failure never
  // forces a re-dial.
  async function fetchRevision() {
    try {
      const response = await fetch(new URL("/api/health", hubUrl), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return "";
      const body = await response.json().catch(() => ({}));
      return typeof body.revision === "string" ? body.revision : "";
    } catch {
      return "";
    }
  }

  function connect() {
    // The pending-reconnect timer (if connect() was invoked as its callback) has
    // now fired; clear the handle so the next drop can schedule a fresh reconnect
    // (reconnect() is guarded against scheduling while this is set).
    reconnectTimer = null;
    // ROBUSTNESS: guarantee a SINGLE live socket. connect() normally runs after a
    // `close`, but a race (a terminate() from the liveness/revision timers landing
    // alongside a scheduled reconnect, or a late `open` after we'd already moved
    // on) can leave the previous socket still OPEN. Two live sockets register the
    // same machine twice; the controller keeps one slot per machine, so the two
    // connections evict each other in a connect→disconnect loop and the machine
    // shows as "not connected". Tearing down any prior socket here makes connect()
    // idempotent regardless of how it was reached. We detach listeners first so the
    // old socket's `close` can't trigger another reconnect (which would re-create
    // the very overlap we're preventing).
    if (activeWs) {
      try {
        activeWs.removeAllListeners();
        activeWs.terminate();
      } catch {}
      activeWs = null;
    }

    const headers = {};
    if (storedToken) {
      headers.authorization = `Bearer ${storedToken}`;
    } else {
      if (process.env.AGENT_USER) headers["x-agent-user"] = process.env.AGENT_USER;
      if (process.env.AGENT_SECRET) headers["x-agent-secret"] = process.env.AGENT_SECRET;
    }
    const ws = new WebSocket(wsUrl, { headers });
    activeWs = ws;

    // Auth rejection (401/403) on the upgrade is PERMANENT — a bad/missing/expired
    // token or a connector too old for this controller's auth. Retrying forever
    // (the default close→reconnect) just loops with an opaque "403". Stop and tell
    // the user what to do instead.
    ws.on("unexpected-response", (_req, res) => {
      const status = res?.statusCode;
      if (status === 401 || status === 403) {
        authRejected = true;
        logEvent("agent_auth_rejected", {
          controller: new URL(hubUrl).origin,
          machine: machineName,
          status,
          authSource: tokenSource || "none",
          message: storedToken
            ? `Controller rejected this machine's agent token (HTTP ${status}). It may be expired, for a different account, or this connector is out of date. Re-authenticate: node server.mjs --register ${new URL(hubUrl).origin} --login (and 'git pull' if the connector is old).`
            : `Controller requires a Google login but no agent token is stored (HTTP ${status}). Run: node server.mjs --register ${new URL(hubUrl).origin} --login`,
        });
        // A 403 upgrade rejection doesn't emit a "close" (the socket never
        // opened), so signal the halt here — connect() returns without scheduling
        // a reconnect, and with no remaining handles the process exits.
        logEvent("agent_stopped", {
          controller: new URL(hubUrl).origin,
          machine: machineName,
          message: "Stopped: controller rejected authentication. Re-run with --login.",
        });
      }
      res?.resume?.(); // drain so the socket closes cleanly
    });

    let lastPong = Date.now();
    let livenessTimer = null;
    let revisionTimer = null;
    let connectionRevision = null; // controller revision at connect time
    ws.on("pong", () => {
      lastPong = Date.now();
    });

    ws.on("open", async () => {
      backoff = 1_000;
      lastPong = Date.now();
      livenessTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
          logEvent("agent_connection_dead", {
            controller: new URL(hubUrl).origin,
            machine: machineName,
            message:
              "Controller stopped responding to pings (likely a Cloud Run restart); terminating the dead socket to force a reconnect.",
          });
          ws.terminate();
          return;
        }
        try {
          ws.ping();
        } catch {}
      }, PING_INTERVAL_MS);
      livenessTimer.unref?.();

      // Capture the controller revision we connected to, then poll for changes
      // so a deploy migrates us onto the new revision without depending on the
      // old instance being torn down. The baseline fetch is fire-and-forget so a
      // slow/hung /api/health never blocks hello registration; until it lands,
      // connectionRevision stays null and the poll simply takes no action.
      if (REVISION_POLL_MS > 0) {
        fetchRevision().then((rev) => {
          if (rev) connectionRevision = rev;
        });
        revisionTimer = setInterval(async () => {
          if (ws.readyState !== ws.OPEN) return;
          const current = await fetchRevision();
          if (!connectionRevision && current) {
            connectionRevision = current; // late baseline if the first fetch failed
            return;
          }
          if (current && connectionRevision && current !== connectionRevision) {
            logEvent("agent_revision_changed", {
              controller: new URL(hubUrl).origin,
              machine: machineName,
              from: connectionRevision,
              to: current,
              message:
                "Controller deployed a new revision; reconnecting to move off the old instance.",
            });
            ws.terminate(); // close → existing reconnect lands on the new revision
          }
        }, REVISION_POLL_MS);
        revisionTimer.unref?.();
      }
      logEvent("agent_registered", {
        controller: new URL(hubUrl).origin,
        websocket: wsUrl,
        machine: machineName,
        auth: storedToken ? "device_token" : "legacy_secret",
        tokenSource: tokenSource || undefined,
        message: "Agent WebSocket connected and is registering this machine with the controller.",
      });
      ws.send(
        JSON.stringify(
          helloFrame({
            machine: machineName,
            os: process.platform,
            arch: process.arch,
            tmux: await describeTmux(),
          }),
        ),
      );
    });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t !== MSG.REQ) return;
      try {
        if (msg.op === OP.TMUX) {
          if (!isAllowedTmux(msg.args)) {
            throw new Error(`tmux subcommand not allowed: ${msg.args?.[0]}`);
          }
          const stdout = await backend.tmux(msg.args, msg.options);
          ws.send(JSON.stringify(resOk(msg.id, { stdout })));
        } else if (msg.op === OP.READDIR) {
          const entries = await backend.readdir(msg.path);
          ws.send(JSON.stringify(resOk(msg.id, { entries })));
        } else if (msg.op === OP.BRANCH) {
          // backend.branch now returns { branch, worktree }; pass the whole
          // object back rather than just the branch string.
          const info = await backend.branch(msg.path);
          ws.send(JSON.stringify(resOk(msg.id, info)));
        } else if (msg.op === OP.READFILE) {
          const result = await backend.readfile(msg.path, {
            baseDir: msg.baseDir,
            maxBytes: msg.maxBytes,
          });
          ws.send(JSON.stringify(resOk(msg.id, result)));
        } else if (msg.op === OP.REPO) {
          const info = await backend.repo(msg.path);
          ws.send(JSON.stringify(resOk(msg.id, info)));
        } else if (msg.op === OP.PANECMD) {
          const info = await backend.paneCommand(msg.tty);
          ws.send(JSON.stringify(resOk(msg.id, info)));
        } else if (msg.op === OP.WRITEFILE) {
          const result = await backend.writeTempFile(msg.name, msg.base64);
          ws.send(JSON.stringify(resOk(msg.id, result)));
        } else if (msg.op === OP.PROCESS_TREE) {
          const processes = await backend.processTree(msg.rootPid);
          ws.send(JSON.stringify(resOk(msg.id, { processes })));
        } else {
          throw new Error(`unknown op: ${msg.op}`);
        }
      } catch (error) {
        ws.send(JSON.stringify(resErr(msg.id, error)));
      }
    });

    ws.on("close", (code) => {
      if (livenessTimer) {
        clearInterval(livenessTimer);
        livenessTimer = null;
      }
      if (revisionTimer) {
        clearInterval(revisionTimer);
        revisionTimer = null;
      }
      // A permanent auth rejection (401/403) won't fix itself by retrying — stop
      // looping so the operator sees the actionable message above and re-logs in.
      if (authRejected) {
        logEvent("agent_stopped", {
          controller: new URL(hubUrl).origin,
          machine: machineName,
          message: "Stopped: controller rejected authentication. Re-run with --login.",
        });
        return;
      }
      // A deliberate controller restart closes with 1012 ("service restart").
      // Cloud Run keeps the OLD revision serving until the NEW one is ready, so
      // re-dialing almost immediately lands on the ready new revision — re-dial
      // fast (skip the 1s backoff) to shrink the browser-visible gap.
      const intentionalRestart = code === 1012;
      if (!stopped) reconnect({ fast: intentionalRestart });
    });
    ws.on("error", (error) => {
      // The auth-rejection path already logged an actionable message; don't also
      // emit the raw "Unexpected server response: 403".
      if (authRejected) return;
      logEvent("agent_connection_error", {
        controller: new URL(hubUrl).origin,
        machine: machineName,
        message: error.message,
      });
    });
  }

  function reconnect({ fast = false } = {}) {
    // IDEMPOTENT: never schedule a second reconnect while one is already pending.
    // Two trigger paths can race to reconnect the same drop — the socket `close`
    // handler and a terminate() from the liveness/revision timers — and without
    // this guard each would setTimeout(connect), losing the first timer reference
    // and dialing TWICE, producing two overlapping sockets (the machine-thrash
    // bug). One drop ⇒ one scheduled reconnect.
    if (reconnectTimer) return;
    // On a known-intentional controller restart, re-dial almost immediately
    // (FAST_RECONNECT_MS) instead of the 1s backoff — Cloud Run already has the
    // new revision ready, so the gap is just the re-dial. A genuine drop keeps
    // the normal 1s→2s→4s→8s ladder. The backoff state is left untouched on the
    // fast path so a flapping connection still escalates correctly.
    const delay = fast ? FAST_RECONNECT_MS : backoff;
    logEvent("agent_reconnect_scheduled", {
      controller: new URL(hubUrl).origin,
      machine: machineName,
      delayMs: delay,
      fast,
      message: "Agent WebSocket disconnected; retrying controller connection.",
    });
    // NOT unref'd on purpose: the reconnect timer must keep the process alive
    // through the backoff delay. If it's the only remaining handle (the socket
    // and all other timers were just torn down on close), unref'ing it would let
    // the agent exit mid-reconnect instead of dialing again. stop() clears this
    // timer explicitly for a clean shutdown.
    reconnectTimer = setTimeout(connect, delay);
    if (!fast) backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  connect();
  return {
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Close the live socket so the controller drops us and any server we're
      // attached to can finish closing. terminate() is immediate; the close
      // handler sees stopped===true and won't reconnect.
      try {
        activeWs?.terminate();
      } catch {}
      activeWs = null;
    },
  };
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
  config.controllers[controllerKey(hubUrl)] = {
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
