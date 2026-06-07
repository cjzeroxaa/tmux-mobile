// Hub mode transport. Accepts outbound agent WebSocket connections, tracks the
// online machines, and exposes a per-machine Backend implementation that turns
// backend calls into protocol frames sent to that machine's agent. The hub
// holds all the proven app logic (it imports server.mjs's handlers); this file
// is only the wire + registry + remote-backend impl.

import { WebSocketServer } from "ws";
import {
  AGENT_OPS,
  AGENT_WS_PATH,
  LEGACY_AGENT_OPS,
  MSG,
  OP,
  reqFrame,
} from "./protocol.mjs";

const RPC_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 10_000;

export function createHub(
  httpServer,
  { logEvent = () => {}, authenticateAgent = () => "" } = {},
) {
  const machines = new Map(); // scoped key -> { ownerId, machineId, ws, info, pending, lastSeen }
  const wss = new WebSocketServer({ noServer: true });
  let rpcSeq = 0;

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url || "/", "http://localhost");
    if (pathname !== AGENT_WS_PATH) {
      socket.destroy();
      return;
    }
    const ownerId = authenticateAgent(req);
    if (ownerId === null || ownerId === undefined) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onAgentConnect(ws, String(ownerId)));
  });

  function onAgentConnect(ws, ownerId) {
    let machineId = null;
    let scopedMachineId = null;
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
        scopedMachineId = machineKey(ownerId, machineId);
        const existing = machines.get(scopedMachineId);
        if (existing && existing.ws !== ws) existing.ws.close(4000, "replaced");
        machines.set(scopedMachineId, {
          ownerId,
          machineId,
          ws,
          info: msg,
          pending,
          lastSeen: Date.now(),
        });
        logEvent("agent_online", {
          userId: ownerId || undefined,
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
      const machine = machines.get(scopedMachineId);
      if (machine) machine.lastSeen = Date.now();
    });

    ws.on("close", () => {
      if (scopedMachineId && machines.get(scopedMachineId)?.ws === ws) {
        machines.delete(scopedMachineId);
        logEvent("agent_offline", { userId: ownerId || undefined, machineId });
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

  function rpc(ownerId, machineId, op, payload) {
    const machine = machines.get(machineKey(ownerId, machineId));
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
  function backendFor(ownerId, machineId) {
    return {
      // Lets request handlers check whether the connected agent can do an op
      // before brokering it, so a version-skewed connector yields a clear
      // message rather than a raw "unknown op" rejection.
      supportsOp(op) {
        return agentSupportsOp(ownerId, machineId, op);
      },
      async tmux(args, options) {
        const res = await rpc(ownerId, machineId, OP.TMUX, { args, options });
        return res.stdout ?? "";
      },
      async readdir(dirPath) {
        const res = await rpc(ownerId, machineId, OP.READDIR, { path: dirPath });
        return res.entries ?? [];
      },
      async branch(dirPath) {
        const res = await rpc(ownerId, machineId, OP.BRANCH, { path: dirPath });
        return { branch: res.branch ?? "", worktree: Boolean(res.worktree) };
      },
      async repo(dirPath) {
        const res = await rpc(ownerId, machineId, OP.REPO, { path: dirPath });
        return { host: res.host ?? "", owner: res.owner ?? "", name: res.name ?? "" };
      },
      async paneCommand(tty) {
        const res = await rpc(ownerId, machineId, OP.PANECMD, { tty });
        return { command: res.command ?? "" };
      },
      async readfile(filePath, { baseDir, maxBytes } = {}) {
        const res = await rpc(ownerId, machineId, OP.READFILE, {
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
        const res = await rpc(ownerId, machineId, OP.WRITEFILE, { name, base64 });
        return { path: res.path ?? "", name: res.name ?? "" };
      },
      async processTree(rootPid) {
        const res = await rpc(ownerId, machineId, OP.PROCESS_TREE, { rootPid });
        return res.processes ?? [];
      },
      async agentLastResponse(arg) {
        const rootPid = typeof arg === "object" && arg !== null ? arg.rootPid : arg;
        const cwd = typeof arg === "object" && arg !== null ? arg.cwd || "" : "";
        const res = await rpc(ownerId, machineId, OP.AGENT_LAST_RESPONSE, {
          rootPid,
          cwd,
        });
        return res.result ?? null;
      },
      async agentTranscript(arg) {
        const rootPid = typeof arg === "object" && arg !== null ? arg.rootPid : arg;
        const cwd = typeof arg === "object" && arg !== null ? arg.cwd || "" : "";
        const res = await rpc(ownerId, machineId, OP.AGENT_TRANSCRIPT, {
          rootPid,
          cwd,
        });
        return res.result ?? null;
      },
    };
  }

  function listMachines(ownerId = "") {
    return [...machines.values()].filter((machine) => machine.ownerId === ownerId).map((machine) => {
      // Version-skew detection: compare the agent's advertised ops against the
      // controller's current AGENT_OPS. A connector missing any current op is
      // running older code (e.g. it predates an op like PANECMD), so newer
      // features silently fail. Surface it so the UI can prompt a restart.
      const advertised = Array.isArray(machine.info?.ops)
        ? machine.info.ops
        : LEGACY_AGENT_OPS;
      const missingOps = AGENT_OPS.filter((op) => !advertised.includes(op));
      return {
        id: machine.machineId,
        hostname: machine.info.machine,
        os: machine.info.os,
        arch: machine.info.arch,
        tmux: machine.info.tmux,
        online: true,
        lastSeen: machine.lastSeen,
        // Stale = connector advertises fewer ops than this controller knows.
        stale: missingOps.length > 0,
        missingOps,
      };
    });
  }

  function hasMachine(ownerId = "", machineId) {
    return machines.has(machineKey(ownerId, machineId));
  }

  // Whether a connected agent advertised support for `op`. An agent that
  // predates capability advertisement (no `ops` in its hello) is treated as
  // supporting only the original ops, so the controller can return a clear
  // "connector out of date" message instead of brokering an op it will reject.
  function agentSupportsOp(ownerId = "", machineId, op) {
    const machine = machines.get(machineKey(ownerId, machineId));
    if (!machine) return false;
    const ops = Array.isArray(machine.info?.ops)
      ? machine.info.ops
      : LEGACY_AGENT_OPS;
    return ops.includes(op);
  }

  // Prototype convenience: with exactly one machine online, the browser need
  // not pick — the hub defaults to it, so the unmodified frontend just works.
  function soleMachineId(ownerId = "") {
    const owned = listMachines(ownerId);
    return owned.length === 1 ? owned[0].id : "";
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
  return `${ownerId || ""}\0${machineId || ""}`;
}
