// Agent mode transport (`server.mjs --register <hubUrl>`). Dials the hub over an
// outbound WebSocket (no inbound port needed), announces this machine, then
// serves the hub's tmux/readdir requests using the local backend. Reconnects
// with exponential backoff. Enforces the tmux subcommand allowlist so the hub
// can never run anything outside the known-safe set.

import os from "node:os";
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

const MAX_BACKOFF_MS = 30_000;

export function runAgent(hubUrl, backend, { logEvent = () => {} } = {}) {
  const wsUrl = toWsUrl(hubUrl);
  let backoff = 1_000;
  let stopped = false;

  async function describeTmux() {
    try {
      return (await backend.tmux(["-V"])).trim();
    } catch {
      return "";
    }
  }

  function connect() {
    const headers = {};
    if (process.env.AGENT_SECRET) headers["x-agent-secret"] = process.env.AGENT_SECRET;
    const ws = new WebSocket(wsUrl, { headers });

    ws.on("open", async () => {
      backoff = 1_000;
      logEvent("hub_connected", { hub: wsUrl });
      ws.send(
        JSON.stringify(
          helloFrame({
            machine: os.hostname(),
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
        } else {
          throw new Error(`unknown op: ${msg.op}`);
        }
      } catch (error) {
        ws.send(JSON.stringify(resErr(msg.id, error)));
      }
    });

    ws.on("close", () => {
      if (!stopped) reconnect();
    });
    ws.on("error", (error) => {
      logEvent("hub_error", { message: error.message });
    });
  }

  function reconnect() {
    logEvent("hub_reconnect", { delayMs: backoff });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  connect();
  return {
    stop() {
      stopped = true;
    },
  };
}

function toWsUrl(hubUrl) {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = AGENT_WS_PATH;
  url.search = "";
  return url.toString();
}
