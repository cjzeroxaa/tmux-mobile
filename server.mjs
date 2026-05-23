import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "From the tmux pane tail below, find the latest agent or shell response and turn it into 3-6 short bullets capturing the core takeaways — what was reported, decided, found, broken, or proposed — keeping specific file paths, commands, identifiers, and numbers when they carry the substance. Drop terminal chrome, prompts, tool-call logs, progress spinners, and decorative separators. Each bullet is one short sentence: specific, not one word, not a paragraph. Use Chinese if the input is primarily Chinese, otherwise English. Return only the bullets, one per line starting with '- '. If nothing useful is visible, return one bullet describing the most recent meaningful line.";
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
    "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_flags}\t#{pane_current_command}",
  panes:
    "#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_title}",
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

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        timeout: options.timeout ?? 10000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message || "").trim();
          const tmuxError = new Error(message || `${file} command failed`);
          tmuxError.code = error.code;
          tmuxError.stderr = stderr;
          reject(tmuxError);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function runTmux(args, options = {}) {
  return runFile("tmux", args, options);
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
  const lines = Number(value || 120);
  if (!Number.isFinite(lines) || lines < 1) return 120;
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
  });
  res.writeHead(200, {
    "content-type": "application/manifest+json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
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

function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 6) return false;
  return /^[-=_*~+─-╿]+$/.test(trimmed);
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

function windowFromRow([id, index, name, active, panes, flags, activeCommand]) {
  return {
    id,
    index: Number(index),
    name,
    active: active === "1",
    panes: Number(panes || 0),
    flags,
    activeCommand,
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
    ([id, index, active, command, cwd, width, height, title]) => ({
      id,
      index: Number(index),
      active: active === "1",
      command,
      cwd,
      width: Number(width || 0),
      height: Number(height || 0),
      title,
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
  const entries = await readdir(cwd, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(cwd, entry.name),
      hidden: entry.name.startsWith("."),
    }))
    .sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    })
    .slice(0, 80);

  return {
    cwd,
    parent: path.dirname(cwd),
    entries: directories,
  };
}

async function capturePane(paneId, mode, lineCount) {
  requireId(paneId, "pane");
  const args = ["capture-pane", "-p", "-t", paneId];

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
      "You summarize tmux window state for a mobile dashboard. For each window, write one short present-tense sentence under 90 characters. Mention errors, running tests, idle prompts, build progress, or obvious current task. Do not invent details. If output is empty or only a prompt, say it is idle.",
    input: JSON.stringify({ lines, windows: samples }),
    schema,
    maxOutputTokens: Math.max(300, windows.length * 45),
  });

  const validWindowIds = new Set(windows.map((win) => win.id));
  const summaries = (value.summaries || [])
    .filter((item) => validWindowIds.has(item.windowId))
    .map((item) => ({
      windowId: item.windowId,
      summary: String(item.summary || "").replace(/\s+/g, " ").trim().slice(0, 140),
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
    "#{window_id}\t#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_title}",
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
    },
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
  const text = pane ? await capturePane(pane.id, "tail", lines) : "";
  const cleanedOutput = cleanTerminalText(text);
  const extractedOutput = await extractLatestAgentResponse({
    windowInfo,
    pane,
    lines,
    output: cleanedOutput,
  });
  const readableOutput = extractedOutput || tailTextExcerpt(cleanedOutput, 10000);
  const sample = {
    ...windowInfo,
    paneIndex: pane?.index ?? null,
    paneId: pane?.id || "",
    command: pane?.command || "",
    cwd: pane?.cwd || "",
    capturedLines: lines,
    extractionModel: AGENT_RESPONSE_EXTRACT_MODEL,
    output: textExcerpt(readableOutput, 10000),
  };
  const chunkOutputs = splitRealtimeBriefingOutput(readableOutput);
  const inputChunks =
    chunkOutputs.length > 0
      ? chunkOutputs
      : [
          sample.output || "No readable agent response is visible.",
        ];

  return {
    lines,
    input: sample.output,
    inputChunks,
    rawChars: cleanedOutput.length,
    extractedChars: readableOutput.length,
    extractionModel: AGENT_RESPONSE_EXTRACT_MODEL,
    paneId: pane?.id || "",
    windowId: windowInfo.windowId || "",
  };
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

  if (req.method === "POST" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    const sessionId = requireId(body.sessionId, "session");
    sendJson(res, 200, await createWindow(sessionId));
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
    const text = await capturePane(paneId, mode, lines);
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
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      sendJson(res, 413, { error: "Transcribed text is too large" });
      return;
    }

    const sendResult = await sendTextToPane(paneId, text, { enter: false });
    if (sendEnter) {
      await runTmux(["send-keys", "-t", paneId, "Enter"]);
      if (submitNudge) {
        sendSubmitNudge(paneId);
      }
    }

    sendJson(res, 200, {
      ok: true,
      text,
      model: TRANSCRIBE_MODEL,
      sendMode: sendResult.mode,
      submitNudgeDelayMs:
        submitNudge && sendEnter && text.length > 0 ? SUBMIT_NUDGE_DELAY_MS : 0,
    });
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
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
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

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    if (url.pathname.startsWith("/api/")) {
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

server.listen(PORT, HOST, () => {
  console.log(`tmux chat web listening at http://${HOST}:${PORT}`);
});
