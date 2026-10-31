// Read-only compatibility with shared-daemon Codex TUIs and paginated history.
// Never start a daemon, resume a thread, send input, or select by cwd/recency.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { stat, realpath } from "node:fs/promises";
import WebSocket from "ws";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cache = new Map();
export function selectCodexThread(threads, { cwd, paneTitle }) {
  const title = String(paneTitle || "").replace(/^[\u2800-\u28ff]\s*/, "").trim();
  if (!cwd || !title || /[\u0000-\u001f]/.test(title)) return null;
  const matches = threads.filter(t => UUID.test(t.id || "") && t.cwd === cwd &&
    !t.parentThreadId && ["cli", "appServer", "vscode"].includes(t.source) &&
    typeof t.name === "string" && t.name.trim() &&
    (title === t.name || title.startsWith(`${t.name} | `)));
  // Name collisions, truncated titles, and an unloaded historical session are
  // not sufficient evidence to associate a terminal with a conversation.
  return matches.length === 1 && ["active", "idle"].includes(matches[0].status?.type)
    ? matches[0] : null;
}
export function codexItemDialogue(entry) {
  const item = entry?.item;
  const role = item?.type === "userMessage" ? "user" : item?.type === "agentMessage" ? "assistant" : "";
  if (!role) return null;
  const text = (role === "assistant" ? item.text : (item.content || []).filter(c => c.type === "text").map(c => c.text).join("\n"))?.trim();
  if (!text) return null;
  const ms = entry.completedAtMs ?? entry.startedAtMs;
  return { role, text, ...(Number.isFinite(ms) ? { t: new Date(ms).toISOString() } : {}) };
}
export async function readCodexDaemonHistory(rpc, thread) {
  const turns = [], seen = new Set();
  let cursor, totalBytes = 0, full = false;
  for (let page = 0; page < 12 && turns.length < 40 && !full; page++) {
    const result = await rpc("thread/items/list", { threadId: thread.id, sortDirection: "desc", limit: 100, ...(cursor ? { cursor } : {}) });
    for (const entry of result.data || []) {
      if (seen.has(entry.item?.id)) continue;
      seen.add(entry.item?.id);
      const turn = codexItemDialogue(entry);
      if (turn) {
        const bytes = Buffer.byteLength(turn.text);
        if (totalBytes + bytes > 8 * 1024 * 1024) { full = true; break; }
        totalBytes += bytes;
        turns.push(turn);
      }
      if (turns.length >= 40) break;
    }
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return { kind: "codex", sessionId: thread.id, transcriptPath: thread.path || "",
    agentSessionTitle: thread.name || "", agentSessionTitleSource: "codex-app-server",
    turns: turns.reverse(), turnsTotal: turns.length,
    liveState: thread.status?.type === "active" ? "working" : thread.status?.type === "idle" ? "idle" : "unverified" };
}

function connect(socketPath) {
  let id = 0, closed = false;
  const pending = new Map();
  const ws = new WebSocket("ws://localhost/", { createConnection: () => net.connect(socketPath), handshakeTimeout: 1500, maxPayload: 8 * 1024 * 1024 });
  const abort = () => {
    closed = true;
    for (const request of pending.values()) request.reject(new Error("Codex daemon unavailable"));
    pending.clear();
  };
  ws.on("error", abort); ws.on("close", abort);
  ws.on("message", bytes => {
    let message; try { message = JSON.parse(bytes); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("Codex history request failed"));
    else request.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return reject(new Error("Codex daemon unavailable"));
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve); ws.once("error", reject); ws.once("close", () => reject(new Error("Codex daemon closed")));
  });
  return { rpc, ready, notify(method) { ws.send(JSON.stringify({ method })); }, close() { abort(); ws.terminate(); } };
}

export async function readCodexAppServerTranscript({ sessionId = "", cwd = "", paneTitle = "" } = {}) {
  if (!UUID.test(sessionId) && !paneTitle.includes(" | ")) return null;
  const home = process.env.CODEX_HOME?.replace(/^~(?=\/|$)/, os.homedir()) || path.join(os.homedir(), ".codex");
  const key = JSON.stringify([home, sessionId, cwd, paneTitle.replace(/^[\u2800-\u28ff]\s*/, "")]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < 4000) return previous.result;
  const result = (async () => {
    const socketPath = await realpath(path.join(home, "app-server-control", "app-server-control.sock"));
    if (!(await stat(socketPath)).isSocket()) return null;
    const client = connect(socketPath);
    let timeout;
    try {
      return await Promise.race([
        (async () => {
          await client.ready;
          await client.rpc("initialize", { clientInfo: { name: "tmax_history_reader", version: "1" }, capabilities: { experimentalApi: true } });
          client.notify("initialized");
          let thread;
          if (UUID.test(sessionId)) {
            thread = (await client.rpc("thread/read", { threadId: sessionId, includeTurns: false })).thread;
            if (thread.id !== sessionId) return null;
          } else {
            const threads = []; let cursor;
            for (let page = 0; page < 10; page++) {
              const list = await client.rpc("thread/list", { cwd, limit: 100, ...(cursor ? { cursor } : {}) });
              threads.push(...(list.data || []));
              if (!list.nextCursor) break;
              if (page === 9 || list.nextCursor === cursor) return null;
              cursor = list.nextCursor;
            }
            thread = selectCodexThread(threads, { cwd, paneTitle });
          }
          if (!thread || thread.historyMode !== "paginated") return null;
          return await readCodexDaemonHistory(client.rpc, thread);
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Codex history timed out")), 4000); }),
      ]);
    } finally { clearTimeout(timeout); client.close(); }
  })().catch(() => null);
  cache.set(key, { at: Date.now(), result });
  while (cache.size > 16) cache.delete(cache.keys().next().value);
  return result;
}
