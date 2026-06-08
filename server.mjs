import { readFileSync } from "node:fs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentBackend, localBackend, withBackend } from "./lib/backend.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadLocalEnv(path.join(__dirname, ".env"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3737);
const APP_TITLE = process.env.TMUX_MOBILE_APP_TITLE || os.hostname() || "tmux Mobile";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_CAPTURE_LINES = 5000;
const TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5.4-mini";
const WINDOW_BRIEFING_MODEL =
  process.env.OPENAI_WINDOW_BRIEFING_MODEL || "gpt-5.4-mini";
const AGENT_RESPONSE_EXTRACT_MODEL =
  process.env.OPENAI_AGENT_RESPONSE_EXTRACT_MODEL || "gpt-5.4-mini";
const AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS = parsePositiveInteger(
  process.env.OPENAI_AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS,
  4096,
);
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const REALTIME_VOICE =
  process.env.OPENAI_REALTIME_VOICE || process.env.OPENAI_SPEECH_VOICE || "cedar";
const SPEECH_MODEL =
  process.env.OPENAI_SPEECH_MODEL || "gpt-4o-mini-tts-2025-12-15";
const SPEECH_VOICE = process.env.OPENAI_SPEECH_VOICE || "cedar";
const configuredSubmitNudgeDelayMs = Number(
  process.env.TMUX_SUBMIT_NUDGE_DELAY_MS,
);
const SUBMIT_NUDGE_DELAY_MS =
  Number.isFinite(configuredSubmitNudgeDelayMs) &&
  configuredSubmitNudgeDelayMs >= 0
    ? configuredSubmitNudgeDelayMs
    : 700;
const SUMMARY_CACHE_MS = 60_000;
const SUMMARY_LINES_DEFAULT = 20;
const WINDOW_BRIEFING_LINES = 60;
const REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES = 500;
const REALTIME_WINDOW_BRIEFING_CHUNK_LINES = parsePositiveInteger(
  process.env.OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_LINES,
  12,
);
const REALTIME_WINDOW_BRIEFING_CHUNK_CHARS = parsePositiveInteger(
  process.env.OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_CHARS,
  1200,
);
const REALTIME_CLIENT_SECRET_TTL_SECONDS = Math.min(
  Math.max(
    parsePositiveInteger(
      process.env.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
      600,
    ),
    10,
  ),
  7200,
);
const WINDOW_BRIEFING_INSTRUCTIONS =
  "You are turning the last visible terminal output into something useful to listen to. The input is the last lines captured from the active pane of a tmux window where a coding agent, shell, editor, or test/build process may be running. Your job is to summarize and restate the actual content in those lines, not to describe the fact that an agent is speaking, explaining, coding, or summarizing. If the output contains an explanation, explain the substance of that explanation. If it contains a plan, report the plan. If it contains code-review findings, report the findings. If it contains command output, report the meaningful results, errors, files, commands, and blockers. Avoid meta phrases such as \"the agent is explaining\", \"the output discusses\", \"it mentions\", or \"the terminal shows\" unless there is no substantive content to report. Ignore ANSI escape sequences, control characters, redraw artifacts, repeated progress-only lines, prompts with no meaningful state, and other terminal noise. Be faithful to the visible output and do not invent missing context. Write a natural spoken summary of 3-7 sentences, no Markdown, no bullets, no code fences. Use Chinese if the terminal output or user task is primarily Chinese; otherwise use English.";
const AGENT_RESPONSE_EXTRACT_INSTRUCTIONS =
  "The text below is the bottom of a tmux pane. Multiple older agent responses may be visible above the newest one — IGNORE them completely. Only consider the response that appears closest to the bottom of the input, after the most recent user prompt or command. Turn just that latest response into 3-6 short bullets capturing the core takeaways — what was reported, decided, found, broken, or proposed — keeping specific file paths, commands, identifiers, and numbers when they carry the substance. Drop terminal chrome, prompts, tool-call logs, progress spinners, and decorative separators. Each bullet is one short sentence: specific, not one word, not a paragraph. Use Chinese if the input is primarily Chinese, otherwise English. Return only the bullets, one per line starting with '- '. If the latest response is empty or only contains noise, return one bullet describing the most recent meaningful line near the bottom.";
const REALTIME_WINDOW_BRIEFING_INSTRUCTIONS =
  "Read the provided bullets aloud as a brisk, natural spoken summary at a quick but clear pace — faster than a default newsreader. Skip the leading '- '. Connect the bullets into flowing sentences rather than reading them staccato. Do not preface, do not add framing, do not translate. Use the input's language. If the input is one chunk of a longer summary, continue naturally without announcing chunk numbers.";
const REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS =
  parseRealtimeOutputTokenLimit(
    process.env.OPENAI_REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
  );

const summaryCache = new Map();

function parseRealtimeOutputTokenLimit(value) {
  const normalized = String(value || "inf").trim().toLowerCase();
  if (!normalized || normalized === "inf") return "inf";

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return "inf";
  return Math.min(Math.floor(parsed), 4096);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function loadLocalEnv(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const formats = {
  sessions:
    "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}",
  windows:
    "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_flags}\t#{pane_current_command}\t#{pane_current_path}",
  // pane_pid is tacked on at the end so the existing list-panes destructure
  // stays compatible (extra fields are just ignored). Needed by Command
  // Center which walks every pane and calls agentTranscript on it.
  panes:
    "#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_title}\t#{pane_pid}",
  paneInfo:
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_active}",
};

const allowedKeys = new Set([
  "Enter",
  "q",
  "C-c",
  "C-d",
  "C-z",
  "Tab",
  "Escape",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
]);

function runTmux(args, options = {}) {
  return currentBackend().tmux(args, options);
}

function isNoServerError(error) {
  return /no server running|failed to connect to server/i.test(error.message);
}

function rows(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function requireId(value, type) {
  const patterns = {
    session: /^\$\d+$/,
    window: /^@\d+$/,
    pane: /^%\d+$/,
  };
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
  return Math.min(Math.floor(lines), MAX_CAPTURE_LINES);
}

function textExcerpt(text, max = 5000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function tailTextExcerpt(text, max = 5000) {
  if (text.length <= max) return text;
  return `[truncated ${text.length - max} earlier chars]\n\n${text.slice(-max)}`;
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderIndexHtml(template) {
  return template.replaceAll("__APP_TITLE__", escapeHtmlAttribute(APP_TITLE));
}

function sendWebManifest(res) {
  const body = JSON.stringify({
    name: APP_TITLE,
    short_name: APP_TITLE,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f1e8",
    theme_color: "#202124",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  });
  res.writeHead(200, {
    "content-type": "application/manifest+json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function cleanTerminalText(text) {
  const lines = String(text || "")
    .replace(/\x1B\][^\x07]*?(?:\x07|\x1B\\)/g, "")
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

function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 6) return false;
  return /^[-=_*~+─-╿]+$/.test(trimmed);
}

// Like cleanTerminalText but keeps SGR (color/style) escape sequences so the
// browser can render them; still strips OSC, cursor/other CSI, and control
// chars, and de-noises blank/separator lines (tested on the SGR-stripped text).
function cleanTerminalTextKeepAnsi(text) {
  const lines = String(text || "")
    .replace(/\x1B\][^\x07]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-ln-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));

  const kept = [];
  let lastWasBlank = false;
  for (const line of lines) {
    const plain = line.replace(/\x1B\[[0-9;:]*m/g, "");
    if (isSeparatorLine(plain)) continue;
    const blank = plain.length === 0;
    if (blank && lastWasBlank) continue;
    kept.push(line);
    lastWasBlank = blank;
  }
  return kept.join("\n").trimEnd();
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
    const overCharLimit =
      current.length > 0 && nextChars > REALTIME_WINDOW_BRIEFING_CHUNK_CHARS;
    if (overLineLimit || overCharLimit) {
      flush();
    }
    current.push(line);
    currentChars += line.length + (current.length > 1 ? 1 : 0);
  }
  flush();

  return chunks.filter(Boolean);
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function limitWords(text, maxWords) {
  const words = oneLine(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}.`;
}

function summarizeOutput(text) {
  const allLines = text.split(/\r?\n/);
  const nonEmpty = allLines.map((line) => line.trim()).filter(Boolean);
  const errorPattern =
    /\b(error|failed|failure|exception|traceback|panic|fatal|denied|not found|timeout|segfault)\b/i;
  const errorLines = nonEmpty.filter((line) => errorPattern.test(line)).slice(-8);

  return {
    lineCount: allLines.length,
    nonEmptyCount: nonEmpty.length,
    lastLine: nonEmpty.at(-1) || "",
    recent: nonEmpty.slice(-8),
    errors: errorLines,
  };
}

async function pasteTextToPane(paneId, text) {
  const bufferName = `tmux-chat-web-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const cleanText = text.replace(/\r\n?/g, "\n").replace(/\x1b\[(?:200|201)~/g, "");
  await runTmux(["set-buffer", "-b", bufferName, cleanText]);
  await runTmux(["paste-buffer", "-dpr", "-b", bufferName, "-t", paneId]);
}

async function sendTextToPane(paneId, text, { enter = false } = {}) {
  await pasteTextToPane(paneId, text);
  if (enter) {
    await runTmux(["send-keys", "-t", paneId, "Enter"]);
    return { mode: "paste-buffer", sentEnter: true };
  }
  return { mode: "paste-buffer", sentEnter: false };
}

function sendSubmitNudge(paneId) {
  setTimeout(() => {
    runTmux(["send-keys", "-t", paneId, "Enter"]).catch((error) => {
      console.error(`submit nudge failed: ${error.message}`);
    });
  }, SUBMIT_NUDGE_DELAY_MS);
}

function sessionFromRow([id, name, windows, attached, created]) {
  return {
    id,
    name,
    windows: Number(windows || 0),
    attached: attached === "1",
    created,
  };
}

function windowFromRow([id, index, name, active, panes, flags, activeCommand, cwd]) {
  return {
    id,
    index: Number(index),
    name,
    active: active === "1",
    panes: Number(panes || 0),
    flags,
    activeCommand,
    cwd: cwd || "",
  };
}

function clearSessionSummaryCache(sessionId) {
  for (const key of summaryCache.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      summaryCache.delete(key);
    }
  }
}

async function createSession(name) {
  const sessionName = requireSessionName(name);
  const stdout = await runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-P",
    "-F",
    formats.sessions,
  ]);
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error("tmux did not return the new session");
    error.status = 500;
    throw error;
  }
  return sessionFromRow(row);
}

async function renameSession(sessionId, name) {
  requireId(sessionId, "session");
  const sessionName = requireSessionName(name);
  await runTmux(["rename-session", "-t", sessionId, sessionName]);
  clearSessionSummaryCache(sessionId);
  const stdout = await runTmux(["display-message", "-p", "-t", sessionId, formats.sessions]);
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error("tmux did not return the renamed session");
    error.status = 500;
    throw error;
  }
  return sessionFromRow(row);
}

async function listWindows(sessionId) {
  requireId(sessionId, "session");
  const stdout = await runTmux([
    "list-windows",
    "-t",
    sessionId,
    "-F",
    formats.windows,
  ]);
  return rows(stdout).map(windowFromRow);
}

async function createWindow(sessionId) {
  requireId(sessionId, "session");
  const stdout = await runTmux([
    "new-window",
    "-P",
    "-F",
    formats.windows,
    "-t",
    sessionId,
  ]);
  clearSessionSummaryCache(sessionId);
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error("tmux did not return the new window");
    error.status = 500;
    throw error;
  }
  return windowFromRow(row);
}

async function renameWindow(windowId, name) {
  requireId(windowId, "window");
  const windowName = requireSessionName(name);
  await runTmux(["rename-window", "-t", windowId, windowName]);
  return { ok: true };
}

async function killWindow(windowId) {
  requireId(windowId, "window");
  const windowInfo = await getWindowInfo(windowId);
  const windows = await listWindows(windowInfo.sessionId);
  if (windows.length <= 1) {
    const error = new Error("Cannot kill the last window in a session");
    error.status = 400;
    throw error;
  }

  await runTmux(["kill-window", "-t", windowId]);
  clearSessionSummaryCache(windowInfo.sessionId);
  return { ok: true, killed: windowInfo };
}

async function listPanes(windowId) {
  requireId(windowId, "window");
  const stdout = await runTmux([
    "list-panes",
    "-t",
    windowId,
    "-F",
    formats.panes,
  ]);
  return rows(stdout).map(
    ([id, index, active, command, cwd, width, height, title, pid]) => ({
      id,
      index: Number(index),
      active: active === "1",
      command,
      cwd,
      width: Number(width || 0),
      height: Number(height || 0),
      title,
      pid: Number(pid || 0) || null,
    }),
  );
}

async function getPaneCwd(paneId) {
  requireId(paneId, "pane");
  return (
    await runTmux(["display-message", "-p", "-t", paneId, "#{pane_current_path}"])
  ).trim();
}

async function listPaneDirectories(paneId) {
  const cwd = await getPaneCwd(paneId);
  const entries = await currentBackend().readdir(cwd);
  const directories = entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(cwd, entry.name),
    }))
    .sort((a, b) => {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    })
    .slice(0, 80);

  return {
    cwd,
    parent: path.dirname(cwd),
    entries: directories,
  };
}

const paneActivitySamples = new Map();
const PANE_ACTIVITY_SAMPLE_CHARS = 100;

async function getSessionWindowActivity(sessionId) {
  const windows = await listWindows(sessionId);
  const result = {};
  for (const win of windows) {
    let active = false;
    try {
      const panes = await listPanes(win.id);
      const pane = panes.find((p) => p.active) || panes[0];
      if (pane) {
        const text = await capturePane(pane.id, "screen");
        const sample = text.slice(-PANE_ACTIVITY_SAMPLE_CHARS);
        const prev = paneActivitySamples.get(pane.id);
        if (prev !== undefined && prev !== sample) active = true;
        paneActivitySamples.set(pane.id, sample);
      }
    } catch {
      // pane likely vanished; treat as inactive
    }
    result[win.id] = active;
  }
  return result;
}

async function getSessionWindowBranches(sessionId) {
  const windows = await listWindows(sessionId);
  const result = {};
  await Promise.all(
    windows.map(async (win) => {
      if (!win.cwd) return;
      try {
        result[win.id] = await currentBackend().branch(win.cwd);
      } catch {
        result[win.id] = "";
      }
    }),
  );
  return result;
}

async function capturePane(paneId, mode, lineCount, { ansi = false } = {}) {
  requireId(paneId, "pane");
  const args = ["capture-pane", "-p", "-t", paneId];
  if (ansi) args.push("-e"); // keep SGR color/style escape sequences

  if (mode === "full") {
    args.push("-S", "-", "-E", "-");
  } else if (mode === "screen") {
    // No range flags: capture only the current visible pane.
  } else {
    args.push("-S", `-${lineCount}`, "-E", "-");
  }

  return runTmux(args, {
    maxBuffer: mode === "full" ? 16 * 1024 * 1024 : 8 * 1024 * 1024,
  });
}

function responseOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function createJsonModelResponse({ instructions, input, schema, maxOutputTokens }) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      text: {
        format: {
          type: "json_schema",
          name: "tmux_window_summaries",
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(textExcerpt(text || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  const outputText = responseOutputText(data);
  if (!outputText) {
    const error = new Error("Model returned no summary text");
    error.status = 502;
    throw error;
  }

  return JSON.parse(outputText);
}

async function createTextModelResponse({
  instructions,
  input,
  maxOutputTokens,
  model = SUMMARY_MODEL,
}) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(textExcerpt(text || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  const outputText = responseOutputText(data);
  if (!outputText) {
    const error = new Error("Model returned no summary text");
    error.status = 502;
    throw error;
  }
  return outputText;
}

async function summarizeWindows(sessionId, lineCount, { force = false } = {}) {
  requireId(sessionId, "session");
  const lines = Math.min(parseLines(lineCount || SUMMARY_LINES_DEFAULT), 50);
  const cacheKey = `${sessionId}:${lines}`;
  const cached = summaryCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.createdAt < SUMMARY_CACHE_MS) {
    return cached.value;
  }

  const windows = await listWindows(sessionId);
  const samples = await Promise.all(
    windows.map(async (win) => {
      const panes = await listPanes(win.id);
      const pane = panes.find((item) => item.active) || panes[0];
      const text = pane ? await capturePane(pane.id, "tail", lines) : "";
      return {
        windowId: win.id,
        windowIndex: win.index,
        windowName: win.name,
        command: pane?.command || win.activeCommand || "",
        cwd: pane?.cwd || "",
        output: textExcerpt(text.trimEnd(), 2200),
      };
    }),
  );

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      summaries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            windowId: { type: "string" },
            summary: { type: "string" },
          },
          required: ["windowId", "summary"],
        },
      },
    },
    required: ["summaries"],
  };

  const value = await createJsonModelResponse({
    instructions:
      "You summarize tmux window state for a mobile dashboard. For each window, write 2 short present-tense sentences, under 200 characters total. Mention errors, running tests, idle prompts, build progress, current files or commands, and the obvious current task. Do not invent details. If output is empty or only a prompt, say it is idle.",
    input: JSON.stringify({ lines, windows: samples }),
    schema,
    maxOutputTokens: Math.max(500, windows.length * 80),
  });

  const validWindowIds = new Set(windows.map((win) => win.id));
  const summaries = (value.summaries || [])
    .filter((item) => validWindowIds.has(item.windowId))
    .map((item) => ({
      windowId: item.windowId,
      summary: String(item.summary || "").replace(/\s+/g, " ").trim().slice(0, 260),
    }))
    .filter((item) => item.summary);

  const result = { model: SUMMARY_MODEL, lines, summaries };
  summaryCache.set(cacheKey, { createdAt: Date.now(), value: result });
  return result;
}

async function getWindowInfo(windowId) {
  requireId(windowId, "window");
  const stdout = await runTmux([
    "display-message",
    "-p",
    "-t",
    windowId,
    "#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}",
  ]);
  const [sessionId = "", sessionName = "", windowIndex = "", windowName = ""] =
    stdout.trimEnd().split("\t");
  return {
    windowId,
    sessionId,
    sessionName,
    windowIndex: Number(windowIndex),
    windowName,
  };
}

async function getPaneContext(paneId) {
  requireId(paneId, "pane");
  const stdout = await runTmux([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{window_id}\t#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_title}\t#{pane_pid}",
  ]);
  const [
    windowId = "",
    sessionId = "",
    sessionName = "",
    windowIndex = "",
    windowName = "",
    resolvedPaneId = "",
    paneIndex = "",
    paneActive = "",
    command = "",
    cwd = "",
    width = "",
    height = "",
    title = "",
    pid = "",
  ] = stdout.trimEnd().split("\t");

  return {
    windowInfo: {
      windowId,
      sessionId,
      sessionName,
      windowIndex: Number(windowIndex),
      windowName,
    },
    pane: {
      id: resolvedPaneId || paneId,
      index: Number(paneIndex),
      active: paneActive === "1",
      command,
      cwd,
      width: Number(width || 0),
      height: Number(height || 0),
      title,
      pid: Number(pid || 0),
    },
  };
}

function commandHasExecutable(command, executable) {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[\\s/])${escaped}([\\s]|$)`, "i");
  return pattern.test(String(command || ""));
}

function detectForkableAgent(pane, processes) {
  const commands = [
    pane?.command || "",
    pane?.title || "",
    ...processes.map((processInfo) => processInfo.command || ""),
  ];
  if (commands.some((command) => commandHasExecutable(command, "codex"))) {
    return {
      agent: "codex",
      command: "codex fork --last",
      windowName: "codex-fork",
    };
  }
  if (commands.some((command) => commandHasExecutable(command, "claude"))) {
    return {
      agent: "claude",
      command: "claude --continue --fork-session",
      windowName: "claude-fork",
    };
  }
  return null;
}

async function forkAgentWindow(paneId) {
  requireId(paneId, "pane");
  const { windowInfo, pane } = await getPaneContext(paneId);
  const processes =
    pane.pid && currentBackend().processTree
      ? await currentBackend().processTree(pane.pid)
      : [];
  const forkSpec = detectForkableAgent(pane, processes);
  if (!forkSpec) {
    return { ok: true, forked: false, reason: "not-agent" };
  }

  const stdout = await runTmux([
    "new-window",
    "-a",
    "-t",
    windowInfo.windowId,
    "-c",
    pane.cwd || process.env.HOME || "/",
    "-n",
    forkSpec.windowName,
    "-P",
    "-F",
    formats.windows,
    forkSpec.command,
  ]);
  clearSessionSummaryCache(windowInfo.sessionId);
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error("tmux did not return the fork window");
    error.status = 500;
    throw error;
  }
  return {
    ok: true,
    forked: true,
    agent: forkSpec.agent,
    source: windowInfo,
    window: windowFromRow(row),
  };
}

async function extractLatestAgentResponse({ windowInfo, pane, lines, output }) {
  if (!output.trim()) return "";

  const extracted = await createTextModelResponse({
    instructions: AGENT_RESPONSE_EXTRACT_INSTRUCTIONS,
    input: JSON.stringify({
      source: "tmux pane tail from a coding-agent workflow",
      lines,
      window: {
        ...windowInfo,
        paneIndex: pane?.index ?? null,
        command: pane?.command || "",
        cwd: pane?.cwd || "",
      },
      output: tailTextExcerpt(output, 14000),
    }),
    maxOutputTokens: AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS,
    model: AGENT_RESPONSE_EXTRACT_MODEL,
  });

  return stripMarkdownFence(extracted);
}

async function buildBriefingInputForPane({ windowInfo, pane, lineCount }) {
  const lines = Math.min(
    parseLines(lineCount || WINDOW_BRIEFING_LINES),
    REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES,
  );

  // Read is only meaningful when we have a structured agent transcript to
  // lift the exact last assistant message from. For any other pane (plain
  // shell, vim, build output, …) the previous capture-pane + LLM-extract
  // path was too unreliable for the productivity payoff, so the button
  // is intentionally a no-op on the UI side and the endpoint refuses
  // server-side as a defense-in-depth.
  const agentInfo = await safeAgentLastResponse(pane);
  if (!agentInfo?.kind) {
    const error = new Error(
      "Read is only available on Codex or Claude windows — this pane isn't running a known agent.",
    );
    error.status = 400;
    error.code = "no_agent";
    throw error;
  }
  if (!agentInfo.text) {
    const error = new Error(
      `${agentInfo.kind} is running but hasn't written an assistant message yet.`,
    );
    error.status = 400;
    error.code = "no_agent_message";
    throw error;
  }

  const readableOutput = agentInfo.text;
  const chunkOutputs = splitRealtimeBriefingOutput(readableOutput);
  const inputChunks = chunkOutputs.length > 0
    ? chunkOutputs
    : [textExcerpt(readableOutput, 10000)];
  return {
    lines: 0,
    input: textExcerpt(readableOutput, 10000),
    inputChunks,
    rawChars: readableOutput.length,
    extractedChars: readableOutput.length,
    extractionModel: `transcript:${agentInfo.kind}`,
    paneId: pane?.id || "",
    windowId: windowInfo.windowId || "",
    agentSession: {
      kind: agentInfo.kind,
      sessionId: agentInfo.sessionId,
      transcriptPath: agentInfo.transcriptPath,
    },
  };
}

// Wrapper that never throws — agent transcript lookup is a best-effort
// optimization, so any failure (lsof missing, file rotated, perms, cloud
// agent doesn't implement the op yet) must drop us back into the
// capture-pane path rather than break Read entirely.
async function safeAgentLastResponse(pane) {
  if (!pane?.pid) return null;
  const backend = currentBackend();
  if (typeof backend.agentLastResponse !== "function") return null;
  try {
    // Pass cwd so Claude Code's filesystem fallback can find the right
    // transcript — its CLI doesn't keep the JSONL file open so lsof alone
    // returns nothing.
    return await backend.agentLastResponse({
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
  } catch {
    return null;
  }
}

async function safeAgentTranscript(pane) {
  if (!pane?.pid) return null;
  const backend = currentBackend();
  if (typeof backend.agentTranscript !== "function") return null;
  try {
    return await backend.agentTranscript({
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
  } catch {
    return null;
  }
}

/**
 * Walk every session + window on the host, pick the active pane in each
 * window, and ask agentTranscript whether it's running a Codex or Claude
 * Code session. Drop the panes that aren't agents and return one row per
 * agent with enough structured state to drive the Command Center view:
 *
 *   - which tmux window/session it lives in
 *   - which agent (codex/claude) and which transcript session UUID
 *   - the last user prompt and last assistant response, verbatim from the
 *     JSONL (not an LLM summary — we already have the exact text)
 *   - a status derived from who spoke last: if the last turn is from the
 *     user, the agent owes a reply -> "running"; otherwise -> "idle"
 *   - a turn count so the UI can show conversation depth at a glance
 *
 * Per-pane work runs in parallel so even ten windows return in roughly the
 * time of the slowest pane.
 */
async function listAgentSessions() {
  let sessions = [];
  try {
    const stdout = await runTmux(["list-sessions", "-F", formats.sessions]);
    sessions = rows(stdout).map(sessionFromRow);
  } catch (error) {
    if (isNoServerError(error)) return { agents: [] };
    throw error;
  }

  // Flatten every window into one queue with its session context.
  const queue = [];
  for (const session of sessions) {
    let windows;
    try {
      windows = await listWindows(session.id);
    } catch {
      continue;
    }
    for (const win of windows) queue.push({ session, win });
  }

  const rows_ = await Promise.all(
    queue.map(async ({ session, win }) => {
      let panes;
      try {
        panes = await listPanes(win.id);
      } catch {
        return null;
      }
      const pane = panes.find((p) => p.active) || panes[0];
      if (!pane?.pid) return null;

      const info = await safeAgentTranscript(pane);
      if (!info?.kind) return null;

      const turns = Array.isArray(info.turns) ? info.turns : [];
      const lastTurn = turns[turns.length - 1] || null;
      const lastAssistantTurn = [...turns].reverse().find((t) => t.role === "assistant") || null;
      const lastUserTurn = [...turns].reverse().find((t) => t.role === "user") || null;

      return {
        sessionId: session.id,
        sessionName: session.name,
        windowId: win.id,
        windowIndex: win.index,
        windowName: win.name,
        paneId: pane.id,
        cwd: pane.cwd || "",
        activeCommand: win.activeCommand || pane.command || "",
        kind: info.kind,
        agentSessionId: info.sessionId || "",
        transcriptPath: info.transcriptPath || "",
        lastUserText: lastUserTurn?.text || "",
        lastAssistantText: lastAssistantTurn?.text || "",
        lastRole: lastTurn?.role || "",
        turnCount: turns.length,
        // If the most recent turn is from the user, the agent owes us a
        // response — that's "running". Otherwise it has spoken and is now
        // waiting for the next prompt — "idle".
        status: lastTurn?.role === "user" ? "running" : "idle",
      };
    }),
  );

  return { agents: rows_.filter(Boolean) };
}

async function buildWindowBriefingInput(windowId, lineCount) {
  requireId(windowId, "window");
  const [windowInfo, panes] = await Promise.all([
    getWindowInfo(windowId),
    listPanes(windowId),
  ]);
  const pane = panes.find((item) => item.active) || panes[0];
  return buildBriefingInputForPane({ windowInfo, pane, lineCount });
}

async function buildPaneBriefingInput(paneId, lineCount) {
  const { windowInfo, pane } = await getPaneContext(paneId);
  return buildBriefingInputForPane({ windowInfo, pane, lineCount });
}

async function summarizeBriefingForSpeech(briefing) {
  const summary = await createTextModelResponse({
    instructions: WINDOW_BRIEFING_INSTRUCTIONS,
    input: briefing.input,
    maxOutputTokens: 520,
    model: WINDOW_BRIEFING_MODEL,
  });

  return limitWords(summary, 320);
}

async function summarizeWindowForSpeech(windowId, lineCount) {
  const briefing = await buildWindowBriefingInput(windowId, lineCount);
  return {
    summary: await summarizeBriefingForSpeech(briefing),
    paneId: briefing.paneId,
    windowId: briefing.windowId || windowId,
  };
}

async function summarizePaneForSpeech(paneId, lineCount) {
  const briefing = await buildPaneBriefingInput(paneId, lineCount);
  return {
    summary: await summarizeBriefingForSpeech(briefing),
    paneId: briefing.paneId || paneId,
    windowId: briefing.windowId,
  };
}

async function createSpeechAudio(text) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const body = {
    model: SPEECH_MODEL,
    voice: SPEECH_VOICE,
    input: text,
    response_format: "mp3",
  };

  if (SPEECH_MODEL.startsWith("gpt-4o")) {
    body.instructions =
      "Voice Affect: Clear and composed. Tone: concise and useful. Pacing: steady. Delivery: read as an AI-generated status briefing.";
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(textExcerpt(errorText || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

async function createRealtimeClientSecret() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const headers = {
    authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "content-type": "application/json",
  };
  if (process.env.OPENAI_SAFETY_IDENTIFIER) {
    headers["OpenAI-Safety-Identifier"] = process.env.OPENAI_SAFETY_IDENTIFIER;
  }

  const response = await fetch(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expires_after: {
          anchor: "created_at",
          seconds: REALTIME_CLIENT_SECRET_TTL_SECONDS,
        },
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: REALTIME_WINDOW_BRIEFING_INSTRUCTIONS,
          max_output_tokens: REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
          output_modalities: ["audio"],
          audio: {
            input: {
              turn_detection: null,
            },
            output: {
              voice: REALTIME_VOICE,
            },
          },
        },
      }),
    },
  );

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

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

  return {
    value: secret.value,
    expiresAt: secret.expires_at || data.expires_at || null,
    sessionId: data.session?.id || "",
  };
}

async function readJsonBody(req) {
  const body = await readRequestBuffer(req, MAX_BODY_BYTES);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

async function readRequestBuffer(req, maxBytes) {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function audioFilename(contentType) {
  if (/mp4/i.test(contentType)) return "voice.mp4";
  if (/mpeg|mp3/i.test(contentType)) return "voice.mp3";
  if (/wav/i.test(contentType)) return "voice.wav";
  if (/webm/i.test(contentType)) return "voice.webm";
  return "voice.webm";
}

// Voice-send idempotency. Successful responses are cached for
// VOICE_SEND_IDEMPOTENCY_TTL_MS so retries on a flaky link don't paste the
// same message into tmux N times. In-flight dedup also folds concurrent
// retries with the same key onto one shared promise — without it, two
// parallel retries that both miss the cache would both run send-keys.
const VOICE_SEND_IDEMPOTENCY_TTL_MS = 120_000;
const voiceSendCache = new Map();
const voiceSendInFlight = new Map();

function pruneExpiredVoiceSendCache(now) {
  for (const [key, entry] of voiceSendCache) {
    if (entry.expiresAt <= now) voiceSendCache.delete(key);
  }
}

async function withVoiceSendIdempotency(key, processFn) {
  if (!key) return processFn();
  const now = Date.now();
  const cached = voiceSendCache.get(key);
  if (cached && cached.expiresAt > now) return cached.response;
  if (cached) voiceSendCache.delete(key);
  const inFlight = voiceSendInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      const response = await processFn();
      voiceSendCache.set(key, {
        response,
        expiresAt: Date.now() + VOICE_SEND_IDEMPOTENCY_TTL_MS,
      });
      pruneExpiredVoiceSendCache(Date.now());
      return response;
    } finally {
      voiceSendInFlight.delete(key);
    }
  })();
  voiceSendInFlight.set(key, promise);
  return promise;
}

async function transcribeAudio(buffer, contentType) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append(
    "prompt",
    "Transcribe a short voice command intended for a tmux pane. Preserve shell commands, flags, paths, package names, and code identifiers.",
  );
  form.append(
    "file",
    new Blob([buffer], { type: contentType || "audio/webm" }),
    audioFilename(contentType || ""),
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(textExcerpt(text || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  return String(data.text || "").trim();
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function logServerEvent(event, details = {}) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details,
    }),
  );
}

function logRequestError(req, url, status, error) {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "request_failed",
      method: req.method,
      path: url?.pathname || req.url || "",
      status,
      message: error.message || "Internal server error",
      stack: error.stack || "",
    }),
  );
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    try {
      const stdout = await runTmux(["list-sessions", "-F", formats.sessions]);
      sendJson(
        res,
        200,
        rows(stdout).map(sessionFromRow),
      );
    } catch (error) {
      if (isNoServerError(error)) {
        sendJson(res, 200, []);
        return;
      }
      throw error;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await createSession(body.name));
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    const sessionId = requireId(body.sessionId, "session");
    sendJson(res, 200, await renameSession(sessionId, body.name));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/windows") {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    sendJson(res, 200, await listWindows(sessionId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/window-activity") {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    sendJson(res, 200, await getSessionWindowActivity(sessionId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/window-branches") {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    sendJson(res, 200, await getSessionWindowBranches(sessionId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    const sessionId = requireId(body.sessionId, "session");
    sendJson(res, 200, await createWindow(sessionId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fork-agent-window") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    sendJson(res, 200, await forkAgentWindow(paneId));
    return;
  }

  // Inspection endpoint: returns {kind, sessionId, transcriptPath, text} for
  // panes running Codex / Claude Code, or {result: null} otherwise. Used by
  // the client to enable/disable the Read buttons (Read only fires on
  // panes with a structured transcript to lift the last response from).
  if (req.method === "GET" && url.pathname === "/api/agent-session") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const { pane } = await getPaneContext(paneId);
    const result = await safeAgentLastResponse(pane);
    sendJson(res, 200, { result });
    return;
  }

  // Structured transcript: every user/assistant turn from the agent's own
  // JSONL, filtered to clean dialogue (tool calls/results, system
  // reminders, environment context dropped). Capped at the last
  // MAX_TRANSCRIPT_TURNS on the backend so the response stays bounded.
  if (req.method === "GET" && url.pathname === "/api/agent-transcript") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const { pane } = await getPaneContext(paneId);
    const result = await safeAgentTranscript(pane);
    sendJson(res, 200, { result });
    return;
  }

  // Command Center feed: one row per agent pane across every tmux session.
  // See listAgentSessions() for the shape.
  if (req.method === "GET" && url.pathname === "/api/command-center") {
    sendJson(res, 200, await listAgentSessions());
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    sendJson(res, 200, await renameWindow(windowId, body.name));
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    sendJson(res, 200, await killWindow(windowId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/panes") {
    const windowId = requireId(url.searchParams.get("windowId"), "window");
    sendJson(res, 200, await listPanes(windowId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/directories") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    sendJson(res, 200, await listPaneDirectories(paneId));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/window-summaries") {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    const lines = url.searchParams.get("lines") || SUMMARY_LINES_DEFAULT;
    const force = url.searchParams.get("refresh") === "1";
    sendJson(res, 200, await summarizeWindows(sessionId, lines, { force }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/capture") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const mode = url.searchParams.get("mode") || "tail";
    const lines = parseLines(url.searchParams.get("lines"));
    const text = cleanTerminalTextKeepAnsi(await capturePane(paneId, mode, lines, { ansi: true }));
    sendJson(res, 200, { paneId, mode, lines, text });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inspect") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const lines = parseLines(url.searchParams.get("lines"));
    const [infoStdout, captureText] = await Promise.all([
      runTmux(["display-message", "-p", "-t", paneId, formats.paneInfo]),
      capturePane(paneId, "tail", lines),
    ]);
    const [session, windowIndex, windowName, paneIndex, command, cwd, pid, active] =
      infoStdout.trimEnd().split("\t");
    sendJson(res, 200, {
      paneId,
      session,
      windowIndex: Number(windowIndex),
      windowName,
      paneIndex: Number(paneIndex),
      command,
      cwd,
      pid: Number(pid),
      active: active === "1",
      summary: summarizeOutput(captureText),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/send") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const text = String(body.text ?? "");
    const sendEnter = body.enter !== false;
    const submitNudge = body.submitNudge === true;

    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      sendJson(res, 413, { error: "Text is too large" });
      return;
    }

    const sendResult =
      text.length > 0
        ? await sendTextToPane(paneId, text, { enter: false })
        : { mode: "none", sentEnter: false };
    if (sendEnter) {
      await runTmux(["send-keys", "-t", paneId, "Enter"]);
      if (submitNudge && text.length > 0) {
        sendSubmitNudge(paneId);
      }
    }
    sendJson(res, 200, {
      ok: true,
      sendMode: sendResult.mode,
      submitNudgeDelayMs:
        submitNudge && sendEnter && text.length > 0 ? SUBMIT_NUDGE_DELAY_MS : 0,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transcribe") {
    const contentType = req.headers["content-type"] || "audio/webm";
    const audio = await readRequestBuffer(req, MAX_AUDIO_BYTES);
    if (audio.length === 0) {
      sendJson(res, 400, { error: "No audio received" });
      return;
    }

    const text = await transcribeAudio(audio, contentType);
    if (!text) {
      sendJson(res, 422, { error: "No speech recognized" });
      return;
    }

    sendJson(res, 200, { text, model: TRANSCRIBE_MODEL });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/voice-send") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const sendEnter = url.searchParams.get("enter") !== "0";
    const submitNudge = url.searchParams.get("submitNudge") !== "0";
    const idempotencyKey = String(req.headers["x-idempotency-key"] || "");
    const contentType = req.headers["content-type"] || "audio/webm";
    const audio = await readRequestBuffer(req, MAX_AUDIO_BYTES);

    // Idempotency: voice-send transcribes AND pastes into a tmux pane, so a
    // retried request after a flaky response would otherwise duplicate the
    // user's message into the pane every retry. Client supplies a stable
    // UUID per recording (state.voice.pendingIdempotencyKey); same key
    // collapses to the same response. In-flight dedup also handles two
    // retries fired before the first finishes.
    const response = await withVoiceSendIdempotency(idempotencyKey, async () => {
      if (audio.length === 0) {
        const error = new Error("No audio received");
        error.status = 400;
        throw error;
      }
      const text = await transcribeAudio(audio, contentType);
      if (!text) {
        const error = new Error("No speech recognized");
        error.status = 422;
        throw error;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        const error = new Error("Transcribed text is too large");
        error.status = 413;
        throw error;
      }
      const sendResult = await sendTextToPane(paneId, text, { enter: false });
      if (sendEnter) {
        await runTmux(["send-keys", "-t", paneId, "Enter"]);
        if (submitNudge) sendSubmitNudge(paneId);
      }
      return {
        ok: true,
        text,
        model: TRANSCRIBE_MODEL,
        sendMode: sendResult.mode,
        submitNudgeDelayMs:
          submitNudge && sendEnter && text.length > 0 ? SUBMIT_NUDGE_DELAY_MS : 0,
      };
    });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/window-audio-summary") {
    const body = await readJsonBody(req);
    const paneId = body.paneId ? requireId(body.paneId, "pane") : "";
    const windowId = body.windowId ? requireId(body.windowId, "window") : "";
    if (!paneId && !windowId) {
      sendJson(res, 400, { error: "paneId or windowId is required" });
      return;
    }
    const lines = Math.min(parseLines(body.lines || WINDOW_BRIEFING_LINES), 100);
    const startedAt = Date.now();
    logServerEvent("window_audio_summary_started", {
      paneId,
      windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel: SPEECH_MODEL,
      voice: SPEECH_VOICE,
    });
    const briefing = paneId
      ? await summarizePaneForSpeech(paneId, lines)
      : await summarizeWindowForSpeech(windowId, lines);
    logServerEvent("window_audio_summary_summarized", {
      paneId: briefing.paneId || paneId,
      windowId: briefing.windowId || windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      summaryChars: briefing.summary.length,
      elapsedMs: Date.now() - startedAt,
    });
    const audioBase64 = await createSpeechAudio(briefing.summary);
    logServerEvent("window_audio_summary_completed", {
      paneId: briefing.paneId || paneId,
      windowId: briefing.windowId || windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel: SPEECH_MODEL,
      audioBase64Chars: audioBase64.length,
      elapsedMs: Date.now() - startedAt,
    });
    sendJson(res, 200, {
      summary: briefing.summary,
      audioBase64,
      mimeType: "audio/mpeg",
      paneId: briefing.paneId || paneId,
      windowId: briefing.windowId || windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel: SPEECH_MODEL,
      voice: SPEECH_VOICE,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/window-realtime-session") {
    const body = await readJsonBody(req);
    const paneId = body.paneId ? requireId(body.paneId, "pane") : "";
    const windowId = body.windowId ? requireId(body.windowId, "window") : "";
    if (!paneId && !windowId) {
      const error = new Error("Pane or window id is required");
      error.status = 400;
      throw error;
    }
    const lines = Math.min(
      parseLines(body.lines || WINDOW_BRIEFING_LINES),
      REALTIME_WINDOW_BRIEFING_MAX_CAPTURE_LINES,
    );
    const startedAt = Date.now();
    logServerEvent("window_realtime_session_started", {
      windowId,
      paneId,
      lines,
      realtimeModel: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      clientSecretTtlSeconds: REALTIME_CLIENT_SECRET_TTL_SECONDS,
    });
    const briefing = paneId
      ? await buildPaneBriefingInput(paneId, lines)
      : await buildWindowBriefingInput(windowId, lines);
    const clientSecret = await createRealtimeClientSecret();
    logServerEvent("window_realtime_session_ready", {
      windowId: briefing.windowId || windowId,
      paneId: briefing.paneId || paneId,
      lines: briefing.lines,
      realtimeModel: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      inputChars: briefing.input.length,
      rawChars: briefing.rawChars,
      extractedChars: briefing.extractedChars,
      extractionModel: briefing.extractionModel,
      chunkCount: briefing.inputChunks.length,
      chunkLines: REALTIME_WINDOW_BRIEFING_CHUNK_LINES,
      chunkChars: REALTIME_WINDOW_BRIEFING_CHUNK_CHARS,
      clientSecretExpiresAt: clientSecret.expiresAt,
      realtimeSessionId: clientSecret.sessionId,
      elapsedMs: Date.now() - startedAt,
    });
    sendJson(res, 200, {
      clientSecret: clientSecret.value,
      clientSecretExpiresAt: clientSecret.expiresAt,
      input: briefing.input,
      inputChunks: briefing.inputChunks,
      chunkCount: briefing.inputChunks.length,
      lines: briefing.lines,
      windowId: briefing.windowId || windowId,
      paneId: briefing.paneId || paneId,
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      extractionModel: briefing.extractionModel,
      extractedChars: briefing.extractedChars,
      maxOutputTokens: REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-log") {
    const body = await readJsonBody(req);
    logServerEvent("client_log", {
      clientEvent: String(body.event || "unknown").slice(0, 120),
      details: body.details || {},
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/key") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const key = String(body.key || "");
    if (!allowedKeys.has(key)) {
      sendJson(res, 400, { error: "Unsupported key" });
      return;
    }
    await runTmux(["send-keys", "-t", paneId, key]);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

async function serveStatic(req, res, url) {
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  // Command Center is a separate top-level page so the main app stays
  // untouched. Both /command-center and /command-center/ resolve to the
  // standalone HTML.
  if (pathname === "/command-center" || pathname === "/command-center/") {
    pathname = "/command-center.html";
  }
  if (pathname === "/manifest.webmanifest") {
    sendWebManifest(res);
    return;
  }

  const relative = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, relative.replace(/^\/+/, ""));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const isIndexHtml = path.basename(filePath) === "index.html";
    const body = isIndexHtml
      ? renderIndexHtml(await readFile(filePath, "utf8"))
      : await readFile(filePath);
    res.writeHead(200, {
      "content-type":
        contentTypes.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// Mode: `--register <hubUrl>` runs as an agent for the cloud; `--hub` serves the
// app and brokers to registered agents; default is today's local server.
function parseMode(args) {
  const registerIndex = args.indexOf("--register");
  if (registerIndex !== -1) {
    return { kind: "register", hubUrl: args[registerIndex + 1] || process.env.HUB_URL };
  }
  if (args.includes("--hub")) return { kind: "hub" };
  return { kind: "local" };
}

const MODE = parseMode(process.argv.slice(2));

if (MODE.kind === "register") {
  if (!MODE.hubUrl) {
    console.error("usage: node server.mjs --register <hubUrl>");
    process.exit(2);
  }
  const { runAgent } = await import("./lib/agent.mjs");
  logServerEvent("agent_starting", { hub: MODE.hubUrl, machine: os.hostname() });
  runAgent(MODE.hubUrl, localBackend, { logEvent: logServerEvent });
} else {
  let hub = null;

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);

      if (req.method === "GET" && url.pathname === "/api/runtime") {
        sendJson(res, 200, { mode: MODE.kind });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (hub) {
          if (req.method === "GET" && url.pathname === "/api/machines") {
            sendJson(res, 200, hub.listMachines());
            return;
          }
          if (url.pathname === "/api/health") {
            sendJson(res, 200, { ok: true });
            return;
          }
          const machineId =
            req.headers["x-machine-id"] ||
            url.searchParams.get("machineId") ||
            hub.soleMachineId();
          if (!machineId) {
            sendJson(res, 400, {
              error: "machineId is required (multiple machines online)",
            });
            return;
          }
          if (!hub.hasMachine(machineId)) {
            sendJson(res, 503, { error: `Machine ${machineId} is offline` });
            return;
          }
          await withBackend(hub.backendFor(machineId), () =>
            handleApi(req, res, url),
          );
          return;
        }
        await handleApi(req, res, url);
        return;
      }

      await serveStatic(req, res, url);
    } catch (error) {
      const status = error.status || 500;
      logRequestError(req, url, status, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, {
        error: error.message || "Internal server error",
      });
    }
  });

  if (MODE.kind === "hub") {
    const { createHub } = await import("./lib/hub.mjs");
    hub = createHub(server, { logEvent: logServerEvent });
  }

  server.listen(PORT, HOST, () => {
    console.log(`tmux ${MODE.kind} listening at http://${HOST}:${PORT}`);
  });
}
