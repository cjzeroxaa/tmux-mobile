// Hub mode transport. Accepts outbound agent WebSocket connections, tracks the
// online machines, and exposes a per-machine Backend implementation that turns
// backend calls into protocol frames sent to that machine's agent. The hub
// holds all the proven app logic (it imports server.mjs's handlers); this file
// is only the wire + registry + remote-backend impl.

import { WebSocketServer } from "ws";
import { AGENT_WS_PATH, MSG, OP, reqFrame } from "./protocol.mjs";

const RPC_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 10_000;

export function createHub(httpServer, { logEvent = () => {} } = {}) {
  const machines = new Map(); // machineId -> { ws, info, pending, lastSeen }
  const wss = new WebSocketServer({ noServer: true });
  let rpcSeq = 0;

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url || "/", "http://localhost");
    if (pathname !== AGENT_WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onAgentConnect(ws));
  });

  function onAgentConnect(ws) {
    let machineId = null;
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
        const existing = machines.get(machineId);
        if (existing && existing.ws !== ws) existing.ws.close(4000, "replaced");
        machines.set(machineId, { ws, info: msg, pending, lastSeen: Date.now() });
        logEvent("agent_online", { machineId, os: msg.os, arch: msg.arch });
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
      const machine = machines.get(machineId);
      if (machine) machine.lastSeen = Date.now();
    });

    ws.on("close", () => {
      if (machineId && machines.get(machineId)?.ws === ws) {
        machines.delete(machineId);
        logEvent("agent_offline", { machineId });
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

  function rpc(machineId, op, payload) {
    const machine = machines.get(machineId);
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
  function backendFor(machineId) {
    return {
      async tmux(args, options) {
        const res = await rpc(machineId, OP.TMUX, { args, options });
        return res.stdout ?? "";
      },
      async readdir(dirPath) {
        const res = await rpc(machineId, OP.READDIR, { path: dirPath });
        return res.entries ?? [];
      },
      async branch(dirPath) {
        const res = await rpc(machineId, OP.BRANCH, { path: dirPath });
        return { branch: res.branch ?? "", worktree: Boolean(res.worktree) };
      },
      async processTree(rootPid) {
        const res = await rpc(machineId, OP.PROCESS_TREE, { rootPid });
        return res.processes ?? [];
      },
    };
  }

  function listMachines() {
    return [...machines.entries()].map(([id, machine]) => ({
      id,
      hostname: machine.info.machine,
      os: machine.info.os,
      arch: machine.info.arch,
      tmux: machine.info.tmux,
      online: true,
      lastSeen: machine.lastSeen,
    }));
  }

  function hasMachine(machineId) {
    return machines.has(machineId);
  }

  // Prototype convenience: with exactly one machine online, the browser need
  // not pick — the hub defaults to it, so the unmodified frontend just works.
  function soleMachineId() {
    return machines.size === 1 ? [...machines.keys()][0] : "";
  }

  return { backendFor, listMachines, hasMachine, soleMachineId };
}
