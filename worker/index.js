// Cloudflare Worker + Durable Object hub. The DO holds each agent's WebSocket
// (hibernation API) and brokers browser API calls to the right machine. The
// wire protocol is shared with the Node hub/agent via ../lib/protocol.mjs, so
// the agent (`node server.mjs --register`) is unchanged — it just dials this
// Worker's URL instead of a local hub.
//
// This first cut ports the core tmux control endpoints. OpenAI endpoints
// (transcribe/read/realtime/summaries) and auth are TODO.

import { AGENT_WS_PATH, MSG, OP, reqFrame } from "../lib/protocol.mjs";

const RPC_TIMEOUT_MS = 15_000;
const APP_TITLE = "tmux Mobile";

const formats = {
  sessions:
    "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}",
  windows:
    "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_flags}\t#{pane_current_command}",
  panes:
    "#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_title}",
  paneInfo:
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_active}",
};

const allowedKeys = new Set([
  "Enter", "q", "C-c", "C-d", "C-z", "Tab", "Escape", "BSpace", "Up", "Down", "Left", "Right",
]);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Agents authenticate with a shared secret (they can't do Basic auth login).
    if (url.pathname === AGENT_WS_PATH) {
      if (!env.AGENT_SECRET || req.headers.get("x-agent-secret") !== env.AGENT_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
    }

    // Single-user gate: HTTP Basic auth on everything else (browser handles it
    // natively, so the frontend needs no changes).
    if (!checkAuth(req, env)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="tmux-mobile", charset="UTF-8"' },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
    }
    if (url.pathname === "/manifest.webmanifest") {
      return new Response(
        JSON.stringify({
          name: APP_TITLE, short_name: APP_TITLE, start_url: "/", scope: "/",
          display: "standalone", background_color: "#f5f1e8", theme_color: "#202124",
        }),
        { headers: { "content-type": "application/manifest+json; charset=utf-8" } },
      );
    }
    return env.ASSETS.fetch(req);
  },
};

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = new Map();
    this.activitySamples = new Map();
    this.summaryCache = new Map();
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === AGENT_WS_PATH) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    try {
      const { status = 200, body } = await this.handleApi(req, url);
      return json(status, body);
    } catch (error) {
      return json(error.status || 500, { error: error.message || "Internal server error" });
    }
  }

  // ---- agent connection registry (survives hibernation via attachment) ----
  agentSockets() {
    return this.state.getWebSockets();
  }
  socketFor(machineId) {
    return this.agentSockets().find(
      (ws) => ws.deserializeAttachment()?.machine === machineId,
    );
  }
  listMachines() {
    return this.agentSockets()
      .map((ws) => ws.deserializeAttachment() || {})
      .filter((a) => a.machine)
      .map((a) => ({
        id: a.machine, hostname: a.machine, os: a.os, arch: a.arch, tmux: a.tmux, online: true,
      }));
  }
  soleMachineId() {
    const ids = this.agentSockets()
      .map((ws) => ws.deserializeAttachment()?.machine)
      .filter(Boolean);
    return ids.length === 1 ? ids[0] : "";
  }

  // ---- hibernation handlers ----
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (msg.t === MSG.HELLO) {
      ws.serializeAttachment({ machine: msg.machine, os: msg.os, arch: msg.arch, tmux: msg.tmux });
      return;
    }
    if (msg.t === MSG.RES) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) {
        waiter.resolve(msg);
      } else {
        const error = new Error(msg.error?.message || "agent error");
        error.code = msg.error?.code;
        waiter.reject(error);
      }
    }
  }
  async webSocketClose() {}
  async webSocketError() {}

  // ---- broker ----
  rpc(machineId, op, payload) {
    const ws = this.socketFor(machineId);
    if (!ws) {
      const error = new Error(`Machine ${machineId} is offline`);
      error.status = 503;
      throw error;
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent request timed out: ${op}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(reqFrame(id, op, payload)));
    });
  }
  async tmux(machineId, args, options) {
    const res = await this.rpc(machineId, OP.TMUX, { args, options });
    return res.stdout ?? "";
  }
  async readdir(machineId, dirPath) {
    const res = await this.rpc(machineId, OP.READDIR, { path: dirPath });
    return res.entries ?? [];
  }

  // ---- API ----
  async handleApi(req, url) {
    const method = req.method;
    const p = url.pathname;

    if (method === "GET" && p === "/api/runtime") return { body: { mode: "hub" } };
    if (method === "GET" && p === "/api/machines") return { body: this.listMachines() };
    if (p === "/api/health") return { body: { ok: true } };
    if (method === "POST" && p === "/api/client-log") return { body: { ok: true } };

    const machineId =
      req.headers.get("x-machine-id") || url.searchParams.get("machineId") || this.soleMachineId();
    if (!machineId) return { status: 400, body: { error: "machineId is required (multiple machines online)" } };
    if (!this.socketFor(machineId)) return { status: 503, body: { error: `Machine ${machineId} is offline` } };

    const t = (args, options) => this.tmux(machineId, args, options);

    if (method === "GET" && p === "/api/sessions") {
      try {
        return { body: rows(await t(["list-sessions", "-F", formats.sessions])).map(sessionFromRow) };
      } catch (error) {
        if (/no server running|failed to connect to server/i.test(error.message)) return { body: [] };
        throw error;
      }
    }
    if (method === "POST" && p === "/api/sessions") {
      const body = await req.json();
      const name = requireSessionName(body.name);
      const out = await t(["new-session", "-d", "-s", name, "-P", "-F", formats.sessions]);
      return { body: sessionFromRow(rows(out)[0]) };
    }
    if (method === "PATCH" && p === "/api/sessions") {
      const body = await req.json();
      const sessionId = requireId(body.sessionId, "session");
      const name = requireSessionName(body.name);
      await t(["rename-session", "-t", sessionId, name]);
      const out = await t(["display-message", "-p", "-t", sessionId, formats.sessions]);
      return { body: sessionFromRow(rows(out)[0]) };
    }
    if (method === "GET" && p === "/api/windows") {
      const sessionId = requireId(url.searchParams.get("sessionId"), "session");
      return { body: rows(await t(["list-windows", "-t", sessionId, "-F", formats.windows])).map(windowFromRow) };
    }
    if (method === "POST" && p === "/api/windows") {
      const body = await req.json();
      const sessionId = requireId(body.sessionId, "session");
      const out = await t(["new-window", "-P", "-F", formats.windows, "-t", sessionId]);
      return { body: windowFromRow(rows(out)[0]) };
    }
    if (method === "DELETE" && p === "/api/windows") {
      const body = await req.json();
      const windowId = requireId(body.windowId, "window");
      const sessionId = (await t(["display-message", "-p", "-t", windowId, "#{session_id}"])).trim();
      const windows = rows(await t(["list-windows", "-t", sessionId, "-F", formats.windows]));
      if (windows.length <= 1) return { status: 400, body: { error: "Cannot kill the last window in a session" } };
      await t(["kill-window", "-t", windowId]);
      return { body: { ok: true, killed: { windowId, sessionId } } };
    }
    if (method === "GET" && p === "/api/window-activity") {
      const sessionId = requireId(url.searchParams.get("sessionId"), "session");
      return { body: await this.windowActivity(machineId, sessionId) };
    }
    if (method === "GET" && p === "/api/panes") {
      const windowId = requireId(url.searchParams.get("windowId"), "window");
      return { body: rows(await t(["list-panes", "-t", windowId, "-F", formats.panes])).map(paneFromRow) };
    }
    if (method === "GET" && p === "/api/directories") {
      const paneId = requireId(url.searchParams.get("paneId"), "pane");
      const cwd = (await t(["display-message", "-p", "-t", paneId, "#{pane_current_path}"])).trim();
      const entries = await this.readdir(machineId, cwd);
      const dirs = entries
        .filter((e) => e.isDirectory && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: `${cwd.replace(/\/$/, "")}/${e.name}` }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        .slice(0, 80);
      return { body: { cwd, parent: cwd.replace(/\/[^/]+\/?$/, "") || "/", entries: dirs } };
    }
    if (method === "GET" && p === "/api/capture") {
      const paneId = requireId(url.searchParams.get("paneId"), "pane");
      const mode = url.searchParams.get("mode") || "tail";
      const lines = parseLines(url.searchParams.get("lines"));
      const args = ["capture-pane", "-p", "-t", paneId];
      if (mode === "full") args.push("-S", "-", "-E", "-");
      else if (mode !== "screen") args.push("-S", `-${lines}`, "-E", "-");
      const text = cleanTerminalText(
        await t(args, { maxBuffer: mode === "full" ? 16 * 1024 * 1024 : 8 * 1024 * 1024 }),
      );
      return { body: { paneId, mode, lines, text } };
    }
    if (method === "GET" && p === "/api/inspect") {
      const paneId = requireId(url.searchParams.get("paneId"), "pane");
      const lines = parseLines(url.searchParams.get("lines"));
      const info = (await t(["display-message", "-p", "-t", paneId, formats.paneInfo])).trimEnd().split("\t");
      const capture = cleanTerminalText(await t(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`, "-E", "-"]));
      const [session, windowIndex, windowName, paneIndex, command, cwd, pid, active] = info;
      return {
        body: {
          paneId, session, windowIndex: Number(windowIndex), windowName,
          paneIndex: Number(paneIndex), command, cwd, pid: Number(pid),
          active: active === "1", summary: summarizeOutput(capture),
        },
      };
    }
    if (method === "POST" && p === "/api/send") {
      const body = await req.json();
      const paneId = requireId(body.paneId, "pane");
      const text = String(body.text ?? "");
      const sendEnter = body.enter !== false;
      if (text.length > 0) {
        const buffer = `tmux-mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const clean = text.replace(/\r\n?/g, "\n").replace(/\x1b\[(?:200|201)~/g, "");
        await t(["set-buffer", "-b", buffer, clean]);
        await t(["paste-buffer", "-dpr", "-b", buffer, "-t", paneId]);
      }
      if (sendEnter) await t(["send-keys", "-t", paneId, "Enter"]);
      return { body: { ok: true, sendMode: text.length > 0 ? "paste-buffer" : "none", submitNudgeDelayMs: 0 } };
    }
    if (method === "POST" && p === "/api/key") {
      const body = await req.json();
      const paneId = requireId(body.paneId, "pane");
      const key = String(body.key || "");
      if (!allowedKeys.has(key)) return { status: 400, body: { error: "Unsupported key" } };
      await t(["send-keys", "-t", paneId, key]);
      return { body: { ok: true } };
    }

    if (method === "GET" && p === "/api/window-summaries") {
      const sessionId = requireId(url.searchParams.get("sessionId"), "session");
      const force = url.searchParams.get("refresh") === "1";
      return { body: await this.summarizeWindows(machineId, sessionId, url.searchParams.get("lines"), force) };
    }
    if (method === "POST" && p === "/api/transcribe") {
      const audio = await req.arrayBuffer();
      if (audio.byteLength === 0) return { status: 400, body: { error: "No audio received" } };
      const text = await transcribeAudio(this.env.OPENAI_API_KEY, audio, req.headers.get("content-type") || "audio/webm");
      if (!text) return { status: 422, body: { error: "No speech recognized" } };
      return { body: { text, model: TRANSCRIBE_MODEL } };
    }
    if (method === "POST" && p === "/api/voice-send") {
      const paneId = requireId(url.searchParams.get("paneId"), "pane");
      const sendEnter = url.searchParams.get("enter") !== "0";
      const audio = await req.arrayBuffer();
      if (audio.byteLength === 0) return { status: 400, body: { error: "No audio received" } };
      const text = await transcribeAudio(this.env.OPENAI_API_KEY, audio, req.headers.get("content-type") || "audio/webm");
      if (!text) return { status: 422, body: { error: "No speech recognized" } };
      const buffer = `tmux-mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const clean = text.replace(/\r\n?/g, "\n").replace(/\x1b\[(?:200|201)~/g, "");
      await t(["set-buffer", "-b", buffer, clean]);
      await t(["paste-buffer", "-dpr", "-b", buffer, "-t", paneId]);
      if (sendEnter) await t(["send-keys", "-t", paneId, "Enter"]);
      return { body: { ok: true, text, model: TRANSCRIBE_MODEL, sendMode: "paste-buffer", submitNudgeDelayMs: 0 } };
    }
    if (method === "POST" && p === "/api/window-audio-summary") {
      const body = await req.json();
      const paneId = body.paneId ? requireId(body.paneId, "pane") : "";
      const windowId = body.windowId ? requireId(body.windowId, "window") : "";
      if (!paneId && !windowId) return { status: 400, body: { error: "paneId or windowId is required" } };
      const lines = Math.min(parseLines(body.lines || WINDOW_BRIEFING_LINES), 100);
      const briefing = paneId
        ? await this.buildPaneBriefingInput(machineId, paneId, lines)
        : await this.buildWindowBriefingInput(machineId, windowId, lines);
      const summary = await this.summarizeBriefingForSpeech(briefing);
      const audioBase64 = await createSpeechAudio(this.env.OPENAI_API_KEY, summary);
      return {
        body: {
          summary, audioBase64, mimeType: "audio/mpeg",
          paneId: briefing.paneId || paneId, windowId: briefing.windowId || windowId, lines,
          summaryModel: WINDOW_BRIEFING_MODEL, speechModel: SPEECH_MODEL, voice: SPEECH_VOICE,
        },
      };
    }
    if (method === "POST" && p === "/api/window-realtime-session") {
      const body = await req.json();
      const paneId = body.paneId ? requireId(body.paneId, "pane") : "";
      const windowId = body.windowId ? requireId(body.windowId, "window") : "";
      if (!paneId && !windowId) return { status: 400, body: { error: "Pane or window id is required" } };
      const lines = Math.min(parseLines(body.lines || WINDOW_BRIEFING_LINES), REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES);
      const briefing = paneId
        ? await this.buildPaneBriefingInput(machineId, paneId, lines)
        : await this.buildWindowBriefingInput(machineId, windowId, lines);
      const clientSecret = await createRealtimeClientSecret(this.env.OPENAI_API_KEY, this.env.OPENAI_SAFETY_IDENTIFIER);
      return {
        body: {
          clientSecret: clientSecret.value, clientSecretExpiresAt: clientSecret.expiresAt,
          input: briefing.input, inputChunks: briefing.inputChunks, chunkCount: briefing.inputChunks.length,
          lines: briefing.lines, windowId: briefing.windowId || windowId, paneId: briefing.paneId || paneId,
          model: REALTIME_MODEL, voice: REALTIME_VOICE, extractionModel: briefing.extractionModel,
          extractedChars: briefing.extractedChars, maxOutputTokens: REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
        },
      };
    }
    return { status: 404, body: { error: "Not found" } };
  }

  async windowActivity(machineId, sessionId) {
    const t = (args) => this.tmux(machineId, args);
    const windows = rows(await t(["list-windows", "-t", sessionId, "-F", formats.windows])).map(windowFromRow);
    const result = {};
    for (const win of windows) {
      let active = false;
      try {
        const panes = rows(await t(["list-panes", "-t", win.id, "-F", formats.panes])).map(paneFromRow);
        const pane = panes.find((p) => p.active) || panes[0];
        if (pane) {
          const sample = (await t(["capture-pane", "-p", "-t", pane.id])).slice(-100);
          const prev = this.activitySamples.get(pane.id);
          if (prev !== undefined && prev !== sample) active = true;
          this.activitySamples.set(pane.id, sample);
        }
      } catch {}
      result[win.id] = active;
    }
    return result;
  }

  // ---- capture + OpenAI orchestration (ported from server.mjs) ----
  capture(machineId, paneId, mode, lineCount) {
    const args = ["capture-pane", "-p", "-t", paneId];
    if (mode === "full") args.push("-S", "-", "-E", "-");
    else if (mode !== "screen") args.push("-S", `-${lineCount}`, "-E", "-");
    return this.tmux(machineId, args, { maxBuffer: mode === "full" ? 16 * 1024 * 1024 : 8 * 1024 * 1024 });
  }

  async getWindowInfo(machineId, windowId) {
    const out = await this.tmux(machineId, [
      "display-message", "-p", "-t", windowId,
      "#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}",
    ]);
    const [sessionId = "", sessionName = "", windowIndex = "", windowName = ""] = out.trimEnd().split("\t");
    return { windowId, sessionId, sessionName, windowIndex: Number(windowIndex), windowName };
  }

  async getPaneContext(machineId, paneId) {
    const out = await this.tmux(machineId, [
      "display-message", "-p", "-t", paneId,
      "#{window_id}\t#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_title}",
    ]);
    const f = out.trimEnd().split("\t");
    return {
      windowInfo: { windowId: f[0] || "", sessionId: f[1] || "", sessionName: f[2] || "", windowIndex: Number(f[3]), windowName: f[4] || "" },
      pane: { id: f[5] || paneId, index: Number(f[6]), active: f[7] === "1", command: f[8] || "", cwd: f[9] || "", width: Number(f[10] || 0), height: Number(f[11] || 0), title: f[12] || "" },
    };
  }

  async extractLatestAgentResponse(windowInfo, pane, lines, output) {
    if (!output.trim()) return "";
    const extracted = await createTextModelResponse(this.env.OPENAI_API_KEY, {
      instructions: AGENT_RESPONSE_EXTRACT_INSTRUCTIONS,
      input: JSON.stringify({
        source: "tmux pane tail from a coding-agent workflow",
        lines,
        window: { ...windowInfo, paneIndex: pane?.index ?? null, command: pane?.command || "", cwd: pane?.cwd || "" },
        output: tailTextExcerpt(output, 14000),
      }),
      maxOutputTokens: AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS,
      model: AGENT_RESPONSE_EXTRACT_MODEL,
    });
    return stripMarkdownFence(extracted);
  }

  async buildBriefingInputForPane(machineId, windowInfo, pane, lineCount) {
    const lines = Math.min(parseLines(lineCount || WINDOW_BRIEFING_LINES), REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES);
    const text = pane ? await this.capture(machineId, pane.id, "tail", lines) : "";
    const cleaned = cleanTerminalText(text);
    const extracted = await this.extractLatestAgentResponse(windowInfo, pane, lines, cleaned);
    const readable = extracted || tailTextExcerpt(cleaned, 10000);
    const output = textExcerpt(readable, 10000);
    const chunkOutputs = splitRealtimeBriefingOutput(readable);
    const inputChunks = chunkOutputs.length > 0 ? chunkOutputs : [output || "No readable agent response is visible."];
    return {
      lines, input: output, inputChunks, rawChars: cleaned.length, extractedChars: readable.length,
      extractionModel: AGENT_RESPONSE_EXTRACT_MODEL, paneId: pane?.id || "", windowId: windowInfo.windowId || "",
    };
  }

  async buildWindowBriefingInput(machineId, windowId, lineCount) {
    const [windowInfo, paneRows] = await Promise.all([
      this.getWindowInfo(machineId, windowId),
      this.tmux(machineId, ["list-panes", "-t", windowId, "-F", formats.panes]),
    ]);
    const panes = rows(paneRows).map(paneFromRow);
    const pane = panes.find((p) => p.active) || panes[0];
    return this.buildBriefingInputForPane(machineId, windowInfo, pane, lineCount);
  }

  async buildPaneBriefingInput(machineId, paneId, lineCount) {
    const { windowInfo, pane } = await this.getPaneContext(machineId, paneId);
    return this.buildBriefingInputForPane(machineId, windowInfo, pane, lineCount);
  }

  async summarizeBriefingForSpeech(briefing) {
    const summary = await createTextModelResponse(this.env.OPENAI_API_KEY, {
      instructions: WINDOW_BRIEFING_INSTRUCTIONS, input: briefing.input, maxOutputTokens: 520, model: WINDOW_BRIEFING_MODEL,
    });
    return limitWords(summary, 320);
  }

  async summarizeWindows(machineId, sessionId, lineCount, force) {
    const lines = Math.min(parseLines(lineCount || SUMMARY_LINES_DEFAULT), 50);
    const cacheKey = `${sessionId}:${lines}`;
    const cached = this.summaryCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.createdAt < 60_000) return cached.value;
    const windows = rows(await this.tmux(machineId, ["list-windows", "-t", sessionId, "-F", formats.windows])).map(windowFromRow);
    const samples = await Promise.all(windows.map(async (win) => {
      const panes = rows(await this.tmux(machineId, ["list-panes", "-t", win.id, "-F", formats.panes])).map(paneFromRow);
      const pane = panes.find((p) => p.active) || panes[0];
      const text = pane ? await this.capture(machineId, pane.id, "tail", lines) : "";
      return { windowId: win.id, windowIndex: win.index, windowName: win.name, command: pane?.command || win.activeCommand || "", cwd: pane?.cwd || "", output: textExcerpt(text.trimEnd(), 2200) };
    }));
    const schema = {
      type: "object", additionalProperties: false,
      properties: { summaries: { type: "array", items: { type: "object", additionalProperties: false, properties: { windowId: { type: "string" }, summary: { type: "string" } }, required: ["windowId", "summary"] } } },
      required: ["summaries"],
    };
    const value = await createJsonModelResponse(this.env.OPENAI_API_KEY, {
      instructions: "You summarize tmux window state for a mobile dashboard. For each window, write one short present-tense sentence under 90 characters. Mention errors, running tests, idle prompts, build progress, or obvious current task. Do not invent details. If output is empty or only a prompt, say it is idle.",
      input: JSON.stringify({ lines, windows: samples }),
      schema, maxOutputTokens: Math.max(300, windows.length * 45),
    });
    const validIds = new Set(windows.map((w) => w.id));
    const summaries = (value.summaries || [])
      .filter((i) => validIds.has(i.windowId))
      .map((i) => ({ windowId: i.windowId, summary: String(i.summary || "").replace(/\s+/g, " ").trim().slice(0, 140) }))
      .filter((i) => i.summary);
    const result = { model: SUMMARY_MODEL, lines, summaries };
    this.summaryCache.set(cacheKey, { createdAt: Date.now(), value: result });
    return result;
  }
}

// Single-user HTTP Basic auth: any username, password must match AUTH_PASS.
function checkAuth(req, env) {
  if (!env.AUTH_PASS) return false;
  const header = req.headers.get("Authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  const pass = idx === -1 ? decoded : decoded.slice(idx + 1);
  return pass === env.AUTH_PASS;
}

// ---- helpers ported from server.mjs ----
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function rows(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
}
function requireId(value, type) {
  const patterns = { session: /^\$\d+$/, window: /^@\d+$/, pane: /^%\d+$/ };
  if (!patterns[type].test(value || "")) {
    const error = new Error(`Invalid ${type} id`);
    error.status = 400;
    throw error;
  }
  return value;
}
function requireSessionName(value) {
  const name = String(value || "").trim();
  if (!name) {
    const error = new Error("Session name is required");
    error.status = 400;
    throw error;
  }
  if (name.length > 80 || /[:\t\r\n]/.test(name)) {
    const error = new Error("Session name cannot include colon, tabs, or newlines");
    error.status = 400;
    throw error;
  }
  return name;
}
function parseLines(value) {
  const lines = Number(value || 500);
  if (!Number.isFinite(lines) || lines < 1) return 500;
  return Math.min(Math.floor(lines), 5000);
}
function sessionFromRow([id, name, windows, attached, created]) {
  return { id, name, windows: Number(windows || 0), attached: attached === "1", created };
}
function windowFromRow([id, index, name, active, panes, flags, activeCommand]) {
  return { id, index: Number(index), name, active: active === "1", panes: Number(panes || 0), flags, activeCommand };
}
function paneFromRow([id, index, active, command, cwd, width, height, title]) {
  return {
    id, index: Number(index), active: active === "1", command, cwd,
    width: Number(width || 0), height: Number(height || 0), title,
  };
}
function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 6) return false;
  return /^[-=_*~+─-╿]+$/.test(trimmed);
}
function cleanTerminalText(text) {
  const lines = String(text || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
  const kept = [];
  let lastWasBlank = false;
  for (const line of lines) {
    if (isSeparatorLine(line)) continue;
    const blank = line.length === 0;
    if (blank && lastWasBlank) continue;
    kept.push(line);
    lastWasBlank = blank;
  }
  return kept.join("\n").trimEnd();
}
function summarizeOutput(text) {
  const allLines = text.split(/\r?\n/);
  const nonEmpty = allLines.map((line) => line.trim()).filter(Boolean);
  const errorPattern = /\b(error|failed|failure|exception|traceback|panic|fatal|denied|not found|timeout|segfault)\b/i;
  const errorLines = nonEmpty.filter((line) => errorPattern.test(line)).slice(-8);
  return {
    lineCount: allLines.length, nonEmptyCount: nonEmpty.length,
    lastLine: nonEmpty.at(-1) || "", recent: nonEmpty.slice(-8), errors: errorLines,
  };
}

// ---- OpenAI constants + helpers (ported from server.mjs) ----
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const SUMMARY_MODEL = "gpt-5.4-mini";
const WINDOW_BRIEFING_MODEL = "gpt-5.4-mini";
const AGENT_RESPONSE_EXTRACT_MODEL = "gpt-5.4-mini";
const AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS = 4096;
const REALTIME_MODEL = "gpt-realtime";
const REALTIME_VOICE = "cedar";
const SPEECH_MODEL = "gpt-4o-mini-tts-2025-12-15";
const SPEECH_VOICE = "cedar";
const SUMMARY_LINES_DEFAULT = 20;
const WINDOW_BRIEFING_LINES = 60;
const REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES = 500;
const REALTIME_WINDOW_BRIEFING_CHUNK_LINES = 12;
const REALTIME_WINDOW_BRIEFING_CHUNK_CHARS = 1200;
const REALTIME_CLIENT_SECRET_TTL_SECONDS = 600;
const REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS = "inf";

const WINDOW_BRIEFING_INSTRUCTIONS =
  "You are turning the last visible terminal output into something useful to listen to. The input is the last lines captured from the active pane of a tmux window where a coding agent, shell, editor, or test/build process may be running. Your job is to summarize and restate the actual content in those lines, not to describe the fact that an agent is speaking, explaining, coding, or summarizing. If the output contains an explanation, explain the substance of that explanation. If it contains a plan, report the plan. If it contains code-review findings, report the findings. If it contains command output, report the meaningful results, errors, files, commands, and blockers. Avoid meta phrases such as \"the agent is explaining\", \"the output discusses\", \"it mentions\", or \"the terminal shows\" unless there is no substantive content to report. Ignore ANSI escape sequences, control characters, redraw artifacts, repeated progress-only lines, prompts with no meaningful state, and other terminal noise. Be faithful to the visible output and do not invent missing context. Write a natural spoken summary of 3-7 sentences, no Markdown, no bullets, no code fences. Use Chinese if the terminal output or user task is primarily Chinese; otherwise use English.";
const AGENT_RESPONSE_EXTRACT_INSTRUCTIONS =
  "The text below is the bottom of a tmux pane. Multiple older agent responses may be visible above the newest one — IGNORE them completely. Only consider the response that appears closest to the bottom of the input, after the most recent user prompt or command. Turn just that latest response into 3-6 short bullets capturing the core takeaways — what was reported, decided, found, broken, or proposed — keeping specific file paths, commands, identifiers, and numbers when they carry the substance. Drop terminal chrome, prompts, tool-call logs, progress spinners, and decorative separators. Each bullet is one short sentence: specific, not one word, not a paragraph. Use Chinese if the input is primarily Chinese, otherwise English. Return only the bullets, one per line starting with '- '. If the latest response is empty or only contains noise, return one bullet describing the most recent meaningful line near the bottom.";
const REALTIME_WINDOW_BRIEFING_INSTRUCTIONS =
  "Read the provided bullets aloud as a brisk, natural spoken summary at a quick but clear pace — faster than a default newsreader. Skip the leading '- '. Connect the bullets into flowing sentences rather than reading them staccato. Do not preface, do not add framing, do not translate. Use the input's language. If the input is one chunk of a longer summary, continue naturally without announcing chunk numbers.";

function requireApiKey(apiKey) {
  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }
}
function textExcerpt(text, max = 5000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}
function tailTextExcerpt(text, max = 5000) {
  if (text.length <= max) return text;
  return `[truncated ${text.length - max} earlier chars]\n\n${text.slice(-max)}`;
}
function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}
function limitWords(text, maxWords) {
  const words = oneLine(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}.`;
}
function stripMarkdownFence(text) {
  const trimmed = String(text || "").trim();
  const match = /^```(?:[a-z0-9_-]+)?\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}
function splitRealtimeBriefingOutput(text) {
  const lines = String(text || "").split("\n");
  const chunks = [];
  let current = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n").trim());
    current = [];
    currentChars = 0;
  };
  for (const line of lines) {
    const nextChars = currentChars + line.length + (current.length > 0 ? 1 : 0);
    const overLineLimit = current.length >= REALTIME_WINDOW_BRIEFING_CHUNK_LINES;
    const overCharLimit = current.length > 0 && nextChars > REALTIME_WINDOW_BRIEFING_CHUNK_CHARS;
    if (overLineLimit || overCharLimit) flush();
    current.push(line);
    currentChars += line.length + (current.length > 1 ? 1 : 0);
  }
  flush();
  return chunks.filter(Boolean);
}
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function audioFilename(contentType) {
  if (/mp4/i.test(contentType)) return "voice.mp4";
  if (/mpeg|mp3/i.test(contentType)) return "voice.mp3";
  if (/wav/i.test(contentType)) return "voice.wav";
  return "voice.webm";
}
function responseOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}
async function createJsonModelResponse(apiKey, { instructions, input, schema, maxOutputTokens }) {
  requireApiKey(apiKey);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: SUMMARY_MODEL, instructions, input, max_output_tokens: maxOutputTokens,
      text: { format: { type: "json_schema", name: "tmux_window_summaries", strict: true, schema } },
    }),
  });
  if (!response.ok) {
    const error = new Error(textExcerpt((await response.text()) || response.statusText, 1200));
    error.status = 502;
    throw error;
  }
  const outputText = responseOutputText(await response.json());
  if (!outputText) {
    const error = new Error("Model returned no summary text");
    error.status = 502;
    throw error;
  }
  return JSON.parse(outputText);
}
async function createTextModelResponse(apiKey, { instructions, input, maxOutputTokens, model = SUMMARY_MODEL }) {
  requireApiKey(apiKey);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, instructions, input, max_output_tokens: maxOutputTokens }),
  });
  if (!response.ok) {
    const error = new Error(textExcerpt((await response.text()) || response.statusText, 1200));
    error.status = 502;
    throw error;
  }
  const outputText = responseOutputText(await response.json());
  if (!outputText) {
    const error = new Error("Model returned no summary text");
    error.status = 502;
    throw error;
  }
  return outputText;
}
async function createSpeechAudio(apiKey, text) {
  requireApiKey(apiKey);
  const body = { model: SPEECH_MODEL, voice: SPEECH_VOICE, input: text, response_format: "mp3" };
  if (SPEECH_MODEL.startsWith("gpt-4o")) {
    body.instructions = "Voice Affect: Clear and composed. Tone: concise and useful. Pacing: steady. Delivery: read as an AI-generated status briefing.";
  }
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(textExcerpt((await response.text()) || response.statusText, 1200));
    error.status = 502;
    throw error;
  }
  return arrayBufferToBase64(await response.arrayBuffer());
}
async function createRealtimeClientSecret(apiKey, safetyIdentifier) {
  requireApiKey(apiKey);
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  if (safetyIdentifier) headers["OpenAI-Safety-Identifier"] = safetyIdentifier;
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: REALTIME_CLIENT_SECRET_TTL_SECONDS },
      session: {
        type: "realtime", model: REALTIME_MODEL, instructions: REALTIME_WINDOW_BRIEFING_INSTRUCTIONS,
        max_output_tokens: REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS, output_modalities: ["audio"],
        audio: { input: { turn_detection: null }, output: { voice: REALTIME_VOICE } },
      },
    }),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(textExcerpt(text || response.statusText, 1200));
    error.status = 502;
    throw error;
  }
  const secret = data.client_secret || data;
  if (!secret?.value) {
    const error = new Error("Realtime client secret response did not include a token");
    error.status = 502;
    throw error;
  }
  return { value: secret.value, expiresAt: secret.expires_at || data.expires_at || null, sessionId: data.session?.id || "" };
}
async function transcribeAudio(apiKey, audioBuffer, contentType) {
  requireApiKey(apiKey);
  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("prompt", "Transcribe a short voice command intended for a tmux pane. Preserve shell commands, flags, paths, package names, and code identifiers.");
  form.append("file", new Blob([audioBuffer], { type: contentType || "audio/webm" }), audioFilename(contentType || ""));
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const error = new Error(textExcerpt((await response.text()) || response.statusText, 1200));
    error.status = 502;
    throw error;
  }
  return String((await response.json()).text || "").trim();
}
