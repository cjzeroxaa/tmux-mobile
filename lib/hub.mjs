// Hub mode transport. Accepts outbound agent WebSocket connections, tracks the
// online machines, and exposes a per-machine Backend implementation that turns
// backend calls into protocol frames sent to that machine's agent. The hub
// holds all the proven app logic (it imports server.mjs's handlers); this file
// is only the wire + registry + remote-backend impl.

import { WebSocketServer } from "ws";
import {
  AGENT_OPS,
  AGENT_WS_PATH,
  CONNECTOR_COMPAT_VERSION,
  LEGACY_AGENT_OPS,
  MSG,
  OP,
  reqFrame,
} from "./protocol.mjs";

const RPC_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 10_000;

export function createHub(
  httpServer,
  {
    logEvent = () => {},
    authenticateAgent = () => "",
    superAdminEmails = [],
    currentRevision = "",
    requiredConnectorVersion = CONNECTOR_COMPAT_VERSION,
    machineAliases = {},
  } = {},
) {
  const machines = new Map(); // route id -> { owner, ownerId, machineId, ws, info, pending, lastSeen }
  const superAdmins = new Set(
    (superAdminEmails || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean),
  );
  const aliases = normalizeMachineAliases(machineAliases);
  const wss = new WebSocketServer({ noServer: true });
  let rpcSeq = 0;

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url || "/", "http://localhost");
    if (pathname !== AGENT_WS_PATH) {
      socket.destroy();
      return;
    }
    const owner = normalizeUser(authenticateAgent(req));
    if (!owner) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onAgentConnect(ws, owner));
  });

  function onAgentConnect(ws, owner) {
    let machineId = null;
    let routeId = null;
    const pending = new Map();

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === MSG.HELLO) {
        machineId = String(msg.machine || "").trim();
        if (!machineId) {
          ws.close(4002, "missing machine id");
          return;
        }
        routeId = machineKey(owner.userId, machineId);
        const existing = machines.get(routeId);
        if (existing && existing.ws !== ws) existing.ws.close(4000, "replaced");
        machines.set(routeId, {
          id: routeId,
          owner,
          ownerId: owner.userId,
          machineId,
          ws,
          info: msg,
          pending,
          lastSeen: Date.now(),
        });
        logEvent("agent_online", {
          userId: owner.userId || undefined,
          hostedDomain: owner.hd || undefined,
          machineId,
          os: msg.os,
          arch: msg.arch,
        });
        return;
      }
      if (msg.t === MSG.RES) {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.ok) {
          waiter.resolve(msg);
        } else {
          const error = new Error(msg.error?.message || "agent error");
          error.code = msg.error?.code;
          waiter.reject(error);
        }
      }
    });

    ws.on("pong", () => {
      const machine = machines.get(routeId);
      if (machine) machine.lastSeen = Date.now();
    });

    ws.on("close", () => {
      if (routeId && machines.get(routeId)?.ws === ws) {
        machines.delete(routeId);
        logEvent("agent_offline", {
          userId: owner.userId || undefined,
          hostedDomain: owner.hd || undefined,
          machineId,
        });
      }
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Agent disconnected"));
      }
      pending.clear();
    });
  }

  const pingTimer = setInterval(() => {
    for (const machine of machines.values()) {
      try {
        machine.ws.ping();
      } catch {}
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  // Viewer-side access is identity-scoped: super admins see all machines,
  // Google Workspace users share with the same hosted domain (`hd`), and
  // consumer accounts fall back to self-only access.
  function canAccessMachine(viewerInput, machine) {
    const viewer = normalizeUser(viewerInput);
    if (!viewer || !machine) return false;
    if (superAdmins.has(viewer.email) || superAdmins.has(viewer.userId)) return true;
    if (viewer.userId && viewer.userId === machine.owner.userId) return true;
    return Boolean(viewer.hd && machine.owner.hd && viewer.hd === machine.owner.hd);
  }

  function visibleMachines(viewerInput) {
    return [...machines.values()].filter((machine) => canAccessMachine(viewerInput, machine));
  }

  function machineFor(viewerInput, machineId) {
    const id = String(machineId || "");
    const direct = machines.get(id);
    if (direct && canAccessMachine(viewerInput, direct)) return direct;

    // Backward compatibility for old URLs/localStorage that still carry the
    // raw hostname-derived machine id. Use it only when the viewer has exactly
    // one accessible machine with that raw id; otherwise require the route id.
    const matches = visibleMachines(viewerInput).filter(
      (machine) => machine.machineId === id || aliasForMachineId(machine.machineId) === id,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function rpc(viewer, machineId, op, payload) {
    const machine = machineFor(viewer, machineId);
    if (!machine || machine.ws.readyState !== machine.ws.OPEN) {
      const error = new Error(`Machine ${machineId} is offline`);
      error.status = 503;
      throw error;
    }
    const id = `r${(rpcSeq = (rpcSeq + 1) >>> 0)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        machine.pending.delete(id);
        reject(new Error(`Agent request timed out: ${op}`));
      }, RPC_TIMEOUT_MS);
      machine.pending.set(id, { resolve, reject, timer });
      machine.ws.send(JSON.stringify(reqFrame(id, op, payload)));
    });
  }

  // A Backend (see lib/backend.mjs) bound to one machine's agent.
  function backendFor(viewer, machineId) {
    return {
      // Lets request handlers check whether the connected agent can do an op
      // before brokering it, so a version-skewed connector yields a clear
      // message rather than a raw "unknown op" rejection.
      supportsOp(op) {
        return agentSupportsOp(viewer, machineId, op);
      },
      async tmux(args, options) {
        const res = await rpc(viewer, machineId, OP.TMUX, { args, options });
        return res.stdout ?? "";
      },
      async readdir(dirPath) {
        const res = await rpc(viewer, machineId, OP.READDIR, { path: dirPath });
        return res.entries ?? [];
      },
      async branch(dirPath) {
        const res = await rpc(viewer, machineId, OP.BRANCH, { path: dirPath });
        return { branch: res.branch ?? "", worktree: Boolean(res.worktree) };
      },
      async repo(dirPath) {
        const res = await rpc(viewer, machineId, OP.REPO, { path: dirPath });
        return { host: res.host ?? "", owner: res.owner ?? "", name: res.name ?? "" };
      },
      async paneCommand(tty) {
        const res = await rpc(viewer, machineId, OP.PANECMD, { tty });
        return { command: res.command ?? "" };
      },
      async readfile(filePath, { baseDir, maxBytes } = {}) {
        const res = await rpc(viewer, machineId, OP.READFILE, {
          path: filePath,
          baseDir,
          maxBytes,
        });
        return {
          base64: res.base64 ?? "",
          size: Number(res.size ?? 0),
          truncated: Boolean(res.truncated),
        };
      },
      async writeTempFile(name, base64) {
        const res = await rpc(viewer, machineId, OP.WRITEFILE, { name, base64 });
        return { path: res.path ?? "", name: res.name ?? "" };
      },
      async processTree(rootPid) {
        const res = await rpc(viewer, machineId, OP.PROCESS_TREE, { rootPid });
        return res.processes ?? [];
      },
      async agentLastResponse(arg) {
        const rootPid = typeof arg === "object" && arg !== null ? arg.rootPid : arg;
        const cwd = typeof arg === "object" && arg !== null ? arg.cwd || "" : "";
        const res = await rpc(viewer, machineId, OP.AGENT_LAST_RESPONSE, {
          rootPid,
          cwd,
        });
        return res.result ?? null;
      },
      async agentTranscript(arg) {
        const rootPid = typeof arg === "object" && arg !== null ? arg.rootPid : arg;
        const cwd = typeof arg === "object" && arg !== null ? arg.cwd || "" : "";
        const res = await rpc(viewer, machineId, OP.AGENT_TRANSCRIPT, {
          rootPid,
          cwd,
        });
        return res.result ?? null;
      },
    };
  }

  function listMachines(viewer = "") {
    return visibleMachines(viewer)
      .map((machine) => {
        // Version-skew detection: compare the agent's advertised ops against the
        // controller's current AGENT_OPS. A connector missing any current op is
        // running older code (e.g. it predates an op like PANECMD), so newer
        // features silently fail. Surface it so the UI can prompt a restart.
        const advertised = Array.isArray(machine.info?.ops)
          ? machine.info.ops
          : LEGACY_AGENT_OPS;
        const missingOps = AGENT_OPS.filter((op) => !advertised.includes(op));
        const connectorState = agentConnectorState(
          machine.info?.connectorVersion,
          requiredConnectorVersion,
        );
        return {
          id: machine.id,
          machineId: machine.machineId,
          hostname: aliasForMachineId(machine.machineId) || machine.info.machine,
          rawHostname: machine.info.machine,
          machineAlias: aliasForMachineId(machine.machineId),
          // Who registered it (their Google email).
          ownerId: machine.ownerId,
          ownerEmail: machine.owner.email,
          ownerHd: machine.owner.hd,
          os: machine.info.os,
          arch: machine.info.arch,
          tmux: machine.info.tmux,
          agentRevision: machine.info.revision || "",
          connectorVersion: machine.info.connectorVersion || "",
          agentCwd: machine.info.cwd || "",
          nodePath: machine.info.node || "",
          expectedRevision: currentRevision || "",
          expectedConnectorVersion: requiredConnectorVersion || "",
          online: true,
          lastSeen: machine.lastSeen,
          // Stale = older protocol surface or a connector compatibility
          // mismatch. Raw server git revisions are diagnostic only; otherwise a
          // controller/frontend-only deploy would force every machine to update.
          stale: missingOps.length > 0 || connectorState.stale,
          missingOps,
          connectorStatus: connectorState.status,
          revisionStatus: connectorState.status,
        };
      });
  }

  function hasMachine(viewer = "", machineId) {
    return machineFor(viewer, machineId) !== null;
  }

  // Whether a connected agent advertised support for `op`. An agent that
  // predates capability advertisement (no `ops` in its hello) is treated as
  // supporting only the original ops, so the controller can return a clear
  // "connector out of date" message instead of brokering an op it will reject.
  function agentSupportsOp(viewer = "", machineId, op) {
    const machine = machineFor(viewer, machineId);
    if (!machine) return false;
    const ops = Array.isArray(machine.info?.ops)
      ? machine.info.ops
      : LEGACY_AGENT_OPS;
    return ops.includes(op);
  }

  function aliasForMachineId(machineId) {
    return aliases.get(normalizeAliasKey(machineId)) || "";
  }

  // Prototype convenience: with exactly one machine online, the browser need
  // not pick — the hub defaults to it, so the unmodified frontend just works.
  function soleMachineId(viewer = "") {
    const all = listMachines(viewer);
    return all.length === 1 ? all[0].id : "";
  }

  // Cleanly disconnect every agent. Called on controller shutdown (SIGTERM)
  // so that when Cloud Run rolls out a new revision and tears down this
  // instance, agents get an immediate close (code 1012 "service restart")
  // instead of a silently-orphaned socket — their reconnect fires at once and
  // lands on the new revision, rather than staying pinned to this dying one.
  function shutdown() {
    clearInterval(pingTimer);
    for (const machine of machines.values()) {
      try {
        machine.ws.close(1012, "controller restarting");
      } catch {}
    }
    machines.clear();
  }

  return {
    backendFor,
    listMachines,
    hasMachine,
    agentSupportsOp,
    soleMachineId,
    shutdown,
  };
}

function machineKey(ownerId, machineId) {
  return `m:${base64url(ownerId || "")}:${base64url(machineId || "")}`;
}

function normalizeMachineAliases(input) {
  const aliases = new Map();
  for (const [rawKey, rawValue] of Object.entries(input || {})) {
    const key = normalizeAliasKey(rawKey);
    const value = String(rawValue || "").trim();
    if (key && value) aliases.set(key, value);
  }
  return aliases;
}

function normalizeAliasKey(value) {
  return String(value || "").trim().toLowerCase();
}

function base64url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function normalizeUser(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    const userId = input.trim().toLowerCase();
    if (!userId) return null;
    return { userId, email: userId, hd: "" };
  }
  const email = String(input.email || input.userId || "").trim().toLowerCase();
  const userId = String(input.userId || email).trim().toLowerCase();
  if (!userId || !email) return null;
  return {
    userId,
    email,
    hd: String(input.hd || input.hostedDomain || "").trim().toLowerCase(),
    sub: String(input.sub || ""),
  };
}

function agentConnectorState(agentVersion, expectedVersion) {
  const expected = normalizeConnectorVersion(expectedVersion);
  if (!expected) return { stale: false, status: "unverified" };
  const agent = normalizeConnectorVersion(agentVersion);
  // Version "1" was introduced after several already-compatible connectors had
  // the full op surface but did not yet report connectorVersion. Accept those
  // agents as compatible; missing ops are still handled separately as stale.
  if (!agent && expected === "1") return { stale: false, status: "compatible" };
  if (!agent) return { stale: true, status: "missing" };
  if (agent === expected) return { stale: false, status: "current" };
  return { stale: true, status: "outdated" };
}

function normalizeConnectorVersion(value) {
  const version = String(value || "").trim();
  if (!version || version === "dev") return "";
  return version;
}
