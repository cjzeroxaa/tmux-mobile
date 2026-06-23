// Hub mode transport. Accepts outbound agent WebSocket connections, tracks the
// online machines, and exposes a per-machine Backend implementation that turns
// backend calls into protocol frames sent to that machine's agent. The hub
// holds all the proven app logic (it imports server.mjs's handlers); this file
// is only the wire + registry + remote-backend impl.

import { Server } from "socket.io";
import {
  AGENT_OPS,
  AGENT_WS_PATH,
  CONNECTOR_COMPAT_VERSION,
  LEGACY_AGENT_OPS,
  MSG,
  OP,
  infoFrame,
  reqFrame,
} from "./protocol.mjs";

const RPC_TIMEOUT_MS = 15_000;
// Engine.IO heartbeat: the controller pings every PING_INTERVAL_MS and considers
// a connection dead if no pong returns within PING_TIMEOUT_MS. This replaces the
// hand-rolled ping/pong + transport-stale sweep that used to live here; Socket.IO
// runs the timers on BOTH ends and fires "disconnect" on a dead peer.
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = Number(process.env.AGENT_TRANSPORT_STALE_MS) || PING_INTERVAL_MS * 2;
// File uploads (writefile) and readfile ride as base64 inside frames, so match
// ws's old 100MB default rather than Socket.IO's 1MB so large frames don't drop.
const MAX_FRAME_BYTES = Number(process.env.AGENT_MAX_FRAME_BYTES) || 100 * 1024 * 1024;
const INVENTORY_STALE_MS = Number(process.env.COMMAND_CENTER_INVENTORY_STALE_MS) || 20_000;

export function createHub(
  httpServer,
  {
    logEvent = () => {},
    authenticateAgent = () => "",
    superAdminEmails = [],
    currentRevision = "",
    expectedRevision = currentRevision,
    updateRef = "main",
    updateScriptUrl = "",
    requiredConnectorVersion = CONNECTOR_COMPAT_VERSION,
    machineAliases = {},
    machineAccessAllowlist = {},
    livenessIntervalMs = PING_INTERVAL_MS,
    pingTimeoutMs = PING_TIMEOUT_MS,
    inventoryStaleMs = INVENTORY_STALE_MS,
  } = {},
) {
  // route id -> { owner, agentId, machineId, ws, info, inventory, pending, connectedAt, lastSeen }
  const machines = new Map();
  const superAdmins = new Set(
    (superAdminEmails || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean),
  );
  const aliases = normalizeMachineAliases(machineAliases);
  const machineAccessRules = normalizeMachineAccessAllowlist(machineAccessAllowlist);
  const io = new Server(httpServer, {
    path: AGENT_WS_PATH,
    serveClient: false,
    transports: ["websocket"],
    pingInterval: livenessIntervalMs,
    pingTimeout: pingTimeoutMs,
    maxHttpBufferSize: MAX_FRAME_BYTES,
  });
  let rpcSeq = 0;

  // Authenticate the agent during the Socket.IO handshake. Credentials arrive in
  // the handshake `auth` payload (or, for older clients, the upgrade headers); we
  // shim a req-like object so the controller's existing authenticateAgent (which
  // reads a Bearer token / x-agent-secret header) works unchanged.
  io.use((socket, next) => {
    const handshake = socket.handshake || {};
    const headers = { ...(handshake.headers || {}) };
    const auth = handshake.auth || {};
    if (auth.token) headers.authorization = `Bearer ${auth.token}`;
    if (auth.secret) headers["x-agent-secret"] = auth.secret;
    if (auth.user) headers["x-agent-user"] = auth.user;
    const owner = normalizeUser(authenticateAgent({ headers }));
    if (!owner) {
      const error = new Error("forbidden");
      error.data = { code: "auth" }; // the agent treats this as permanent
      next(error);
      return;
    }
    socket.data.owner = owner;
    next();
  });

  io.on("connection", (socket) => onAgentConnect(socket, socket.data.owner));

  function onAgentConnect(ws, owner) {
    let machineId = null;
    let routeId = null;
    const pending = new Map();

    try {
      ws.send(JSON.stringify(infoFrame({ revision: currentRevision || "" })));
    } catch {}

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
          ws.disconnect(true);
          return;
        }
        const canonicalMachineId = canonicalForMachineId(machineId);
        const agentId = normalizeAgentId(msg.agentId);
        const routeIdentity = agentId || canonicalMachineId;
        routeId = machineKey(owner.userId, routeIdentity);
        const existing = machines.get(routeId);
        // Force-disconnect the older connector. Socket.IO delivers this to the
        // agent as "io server disconnect", which suppresses its auto-reconnect —
        // exactly right for a replaced (stale) connector.
        if (existing && existing.ws !== ws) existing.ws.disconnect(true);
        machines.set(routeId, {
          id: routeId,
          owner,
          ownerId: owner.userId,
          agentId,
          machineId,
          canonicalMachineId,
          ws,
          info: msg,
          inventory: null,
          pending,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
        });
        logEvent("agent_online", {
          userId: owner.userId || undefined,
          hostedDomain: owner.hd || undefined,
          agentId: agentId || undefined,
          machineId,
          canonicalMachineId,
          os: msg.os,
          arch: msg.arch,
        });
        return;
      }
      if (msg.t === MSG.INVENTORY) {
        const machine = routeId ? machines.get(routeId) : null;
        if (!machine || machine.ws !== ws) return;
        machine.lastSeen = Date.now();
        updateInventory(machine, msg);
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

    ws.on("disconnect", () => {
      const machine = routeId ? machines.get(routeId) : null;
      if (machine?.ws === ws) dropMachine(machine, "socket_closed");
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Agent disconnected"));
      }
      pending.clear();
    });
  }

  function dropMachine(machine, reason, { terminate = false } = {}) {
    if (!machine || machines.get(machine.id)?.ws !== machine.ws) return false;
    machines.delete(machine.id);
    logEvent("agent_offline", {
      userId: machine.ownerId || undefined,
      hostedDomain: machine.owner?.hd || undefined,
      machineId: machine.machineId,
      reason,
    });
    if (terminate) {
      try {
        machine.ws.disconnect(true);
      } catch {}
    }
    return true;
  }

  // Viewer-side access is identity-scoped: super admins see all machines,
  // Google Workspace users share with the same hosted domain (`hd`), and
  // consumer accounts fall back to self-only access.
  function canAccessMachine(viewerInput, machine) {
    const viewer = normalizeUser(viewerInput);
    if (!viewer || !machine) return false;
    if (superAdmins.has(viewer.email) || superAdmins.has(viewer.userId)) return true;
    if (viewer.userId && viewer.userId === machine.owner.userId) return true;
    if (hasMachineAccessOverride(viewer, machine)) return true;
    return Boolean(viewer.hd && machine.owner.hd && viewer.hd === machine.owner.hd);
  }

  function hasMachineAccessOverride(viewer, machine) {
    if (machineAccessRules.length === 0) return false;
    const viewerKeys = new Set([viewer.email, viewer.userId].map(normalizeAccessValue).filter(Boolean));
    if (viewerKeys.size === 0) return false;
    const machineKeys = machineAccessKeySet(machine, aliasForMachineId);
    return machineAccessRules.some(
      (rule) => intersects(rule.users, viewerKeys) && intersects(rule.machines, machineKeys),
    );
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
    const canonicalId = canonicalForMachineId(id);
    const matches = visibleMachines(viewerInput).filter(
      (machine) =>
        machine.agentId === id ||
        machine.machineId === id ||
        machine.canonicalMachineId === id ||
        machine.canonicalMachineId === canonicalId ||
        aliasForMachineId(machine.machineId) === id,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function rpc(viewer, machineId, op, payload) {
    const machine = machineFor(viewer, machineId);
    if (!machine || !machine.ws.connected) {
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
    function currentMachineInfo() {
      return machineFor(viewer, machineId)?.info || {};
    }
    return {
      // Lets request handlers check whether the connected agent can do an op
      // before brokering it, so a version-skewed connector yields a clear
      // message rather than a raw "unknown op" rejection.
      supportsOp(op) {
        return agentSupportsOp(viewer, machineId, op);
      },
      muxKind() {
        const info = currentMachineInfo();
        return info.mux || inferMuxKind(info);
      },
      muxCommand(mux = "") {
        const kind = normalizeMuxKind(mux) || this.muxKind();
        const found = normalizeMuxes(currentMachineInfo()).find((item) => item.mux === kind);
        return found?.muxCommand || currentMachineInfo().muxCommand || kind;
      },
      muxKinds() {
        const muxes = normalizeMuxes(currentMachineInfo()).map((item) => item.mux);
        return muxes.length > 0 ? muxes : [this.muxKind()];
      },
      async tmux(args, options) {
        const mux = normalizeMuxKind(options?.mux);
        const res = await rpc(viewer, machineId, OP.TMUX, { args, options, mux });
        return res.stdout ?? "";
      },
      async readdir(dirPath) {
        const res = await rpc(viewer, machineId, OP.READDIR, { path: dirPath });
        return res.entries ?? [];
      },
      async branch(dirPath) {
        const res = await rpc(viewer, machineId, OP.BRANCH, { path: dirPath });
        return {
          branch: res.branch ?? "",
          worktree: Boolean(res.worktree),
          bare: Boolean(res.bare),
          commonDir: res.commonDir ?? "",
        };
      },
      async repo(dirPath) {
        const res = await rpc(viewer, machineId, OP.REPO, { path: dirPath });
        return { host: res.host ?? "", owner: res.owner ?? "", name: res.name ?? "" };
      },
      async worktreeAdd({ fromDir, branch } = {}) {
        const res = await rpc(viewer, machineId, OP.WORKTREE_ADD, { fromDir, branch });
        return { path: res.path ?? "", branch: res.branch ?? "" };
      },
      async rmuxWebShare({ target, ttlSeconds, tunnelProvider, frontendUrl } = {}) {
        const res = await rpc(viewer, machineId, OP.RMUX_WEB_SHARE, {
          target,
          ttlSeconds,
          tunnelProvider,
          frontendUrl,
        });
        return {
          ok: Boolean(res.ok ?? true),
          role: res.role ?? "operator",
          target: res.target ?? target ?? "",
          shareId: res.shareId ?? "",
          operatorUrl: res.operatorUrl ?? "",
          code: res.code ?? "",
          expiresAt: res.expiresAt ?? "",
          tunnelProvider: res.tunnelProvider ?? tunnelProvider ?? "",
          tunnelUrl: res.tunnelUrl ?? "",
        };
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

  function describeMachine(machine) {
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
    const inventory = describeInventory(machine, inventoryStaleMs);
    return {
      id: machine.id,
      agentId: machine.agentId || "",
      machineId: machine.canonicalMachineId || machine.machineId,
      rawMachineId: machine.machineId,
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
      mux: machine.info.mux || inferMuxKind(machine.info),
      muxCommand: machine.info.muxCommand || inferMuxKind(machine.info),
      muxVersion: machine.info.muxVersion || machine.info.tmux || "",
      muxes: normalizeMuxes(machine.info),
      agentRevision: machine.info.revision || "",
      connectorVersion: machine.info.connectorVersion || "",
      agentCwd: machine.info.cwd || "",
      homeDir: machine.info.homeDir || "",
      nodePath: machine.info.node || "",
      expectedRevision: expectedRevision || currentRevision || "",
      updateRef: updateRef || "main",
      updateScriptUrl: updateScriptUrl || "",
      expectedConnectorVersion: requiredConnectorVersion || "",
      online: true,
      lastSeen: machine.lastSeen,
      inventoryStatus: inventory.status,
      inventorySource: inventory.source,
      inventoryObservedAt: inventory.observedAt,
      inventoryAgeMs: inventory.ageMs,
      inventoryDurationMs: inventory.durationMs,
      inventoryError: inventory.error,
      agentCount: inventory.agents.length,
      // Stale = older protocol surface or a connector compatibility
      // mismatch. Raw server git revisions are diagnostic only; otherwise a
      // controller/frontend-only deploy would force every machine to update.
      stale: missingOps.length > 0 || connectorState.stale,
      missingOps,
      connectorStatus: connectorState.status,
      revisionStatus: connectorState.status,
    };
  }

  function listMachines(viewer = "") {
    return visibleMachines(viewer).map(describeMachine);
  }

  function listAllMachines() {
    return [...machines.values()].map(describeMachine);
  }

  function commandCenterInventory(viewer = "", machineId) {
    const machine = machineFor(viewer, machineId);
    if (!machine) return null;
    const inventory = describeInventory(machine, inventoryStaleMs);
    const described = describeMachine(machine);
    return {
      machine: {
        ...described,
        agentCount: inventory.agents.length,
      },
      agents: inventory.agents,
      hasInventory: Boolean(machine.inventory),
      supportsInventory: machineSupportsInventory(machine),
    };
  }

  function listCommandCenterInventories(viewer = "") {
    return visibleMachines(viewer).map((machine) => commandCenterInventory(viewer, machine.id));
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

  function canonicalForMachineId(machineId) {
    const value = String(machineId || "").trim();
    return aliasForMachineId(value) || value;
  }

  // Prototype convenience: with exactly one machine online, the browser need
  // not pick — the hub defaults to it, so the unmodified frontend just works.
  function soleMachineId(viewer = "") {
    const all = listMachines(viewer);
    return all.length === 1 ? all[0].id : "";
  }

  // Called on controller shutdown (SIGTERM) when the runtime rolls out a new
  // revision and tears down this instance. io.close() drops every agent
  // connection at the transport level (NOT a server-initiated "io server
  // disconnect"), so Socket.IO's auto-reconnect fires immediately and lands on
  // the new instance rather than each agent staying pinned to this dying one
  // until its socket eventually dies on its own.
  function shutdown() {
    machines.clear();
    try {
      io.close();
    } catch {}
  }

  return {
    backendFor,
    listMachines,
    listAllMachines,
    commandCenterInventory,
    listCommandCenterInventories,
    hasMachine,
    agentSupportsOp,
    soleMachineId,
    shutdown,
  };
}

function updateInventory(machine, msg) {
  const receivedAt = Date.now();
  const observedAt = normalizeTimestamp(msg.observedAt) || receivedAt;
  machine.lastInventoryAt = receivedAt;
  if (msg.ok) {
    machine.inventory = {
      ok: true,
      observedAt,
      receivedAt,
      durationMs: normalizeNonNegativeNumber(msg.durationMs),
      sequence: normalizeNonNegativeNumber(msg.sequence),
      error: "",
      agents: normalizeInventoryAgents(msg.agents),
    };
    return;
  }
  machine.inventory = {
    ok: false,
    observedAt,
    receivedAt,
    durationMs: normalizeNonNegativeNumber(msg.durationMs),
    sequence: normalizeNonNegativeNumber(msg.sequence),
    error: errorMessage(msg.error) || "Inventory scan failed",
    agents: [],
  };
}

function describeInventory(machine, staleMs = INVENTORY_STALE_MS) {
  const inventory = machine.inventory;
  const supports = machineSupportsInventory(machine);
  if (!inventory) {
    return {
      status: supports ? "pending" : "unsupported",
      source: supports ? "push" : "live-rpc",
      observedAt: null,
      ageMs: null,
      durationMs: null,
      error: "",
      agents: [],
    };
  }
  const ageMs = Math.max(0, Date.now() - (inventory.receivedAt || inventory.observedAt));
  const status = inventory.ok
    ? ageMs > staleMs
      ? "stale"
      : "fresh"
    : "failed";
  return {
    status,
    source: "push",
    observedAt: inventory.observedAt,
    ageMs,
    durationMs: inventory.durationMs,
    error: inventory.error || "",
    agents: status === "fresh" && Array.isArray(inventory.agents) ? inventory.agents : [],
  };
}

function machineSupportsInventory(machine) {
  return Boolean(machine?.info?.features?.commandCenterInventory);
}

function inventoryAgeMs(machine) {
  const observedAt =
    machine?.lastInventoryAt ||
    machine?.inventory?.receivedAt ||
    machine?.connectedAt ||
    machine?.lastSeen ||
    0;
  return Math.max(0, Date.now() - observedAt);
}

function normalizeInventoryAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((agent) => agent && typeof agent === "object" && !Array.isArray(agent))
    .map((agent) => ({ ...agent }));
}

function normalizeMuxKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === "rmux" || kind === "tmux" ? kind : "";
}

function normalizeMuxes(info = {}) {
  const out = [];
  for (const item of Array.isArray(info.muxes) ? info.muxes : []) {
    const mux = normalizeMuxKind(item?.mux || item?.kind);
    if (!mux || out.some((existing) => existing.mux === mux)) continue;
    out.push({
      mux,
      kind: mux,
      muxCommand: String(item.muxCommand || mux),
      version: String(item.version || item.muxVersion || ""),
    });
  }
  if (out.length === 0) {
    const mux = normalizeMuxKind(info.mux) || inferMuxKind(info);
    out.push({
      mux,
      kind: mux,
      muxCommand: String(info.muxCommand || mux),
      version: String(info.muxVersion || info.tmux || ""),
    });
  }
  return out;
}

function normalizeTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeNonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function errorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object") return String(error.message || "");
  return String(error);
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

function normalizeMachineAccessAllowlist(input) {
  const rules = [];
  for (const [rawMachine, rawUsers] of Object.entries(input || {})) {
    const machines = accessValueVariants(rawMachine);
    const users = normalizeAccessUsers(rawUsers);
    if (machines.size > 0 && users.size > 0) rules.push({ machines, users });
  }
  return rules;
}

function normalizeAccessUsers(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[,\s|]+/);
  return new Set(values.map(normalizeAccessValue).filter(Boolean));
}

function machineAccessKeySet(machine, aliasForMachineId) {
  const values = [
    machine.id,
    machine.agentId,
    machine.machineId,
    machine.canonicalMachineId,
    machine.info?.machine,
    aliasForMachineId(machine.machineId),
    aliasForMachineId(machine.canonicalMachineId),
  ];
  const out = new Set();
  for (const value of values) {
    for (const variant of accessValueVariants(value)) out.add(variant);
  }
  return out;
}

function accessValueVariants(value) {
  const exact = normalizeAccessValue(value);
  const loose = exact.replace(/[^a-z0-9]+/g, "");
  return new Set([exact, loose].filter(Boolean));
}

function normalizeAccessValue(value) {
  return String(value || "").trim().toLowerCase();
}

function intersects(a, b) {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

function normalizeAliasKey(value) {
  return String(value || "").trim().toLowerCase();
}

function base64url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function inferMuxKind(info = {}) {
  const explicit = String(info.mux || "").trim().toLowerCase();
  if (explicit === "rmux" || explicit === "tmux") return explicit;
  const version = String(info.muxVersion || info.tmux || "").trim().toLowerCase();
  return version.startsWith("rmux") ? "rmux" : "tmux";
}

function normalizeAgentId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? id
    : "";
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
