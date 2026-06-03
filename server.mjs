import { readFileSync } from "node:fs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { currentBackend, localBackend, withBackend } from "./lib/backend.mjs";
import { OP } from "./lib/protocol.mjs";
import {
  VOICE_OPTIONS,
  describeVoiceConfig,
  getVoiceConfig,
  updateVoiceConfig,
  withVoiceUser,
} from "./lib/voice-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadLocalEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3737);
const APP_TITLE = process.env.TMUX_MOBILE_APP_TITLE || os.hostname() || "tmux Mobile";
const APP_REVISION =
  process.env.K_REVISION || process.env.TMUX_MOBILE_REVISION || "dev";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_CAPTURE_LINES = 5000;
// Voice models (transcription / realtime / TTS) are now runtime-configurable
// via lib/voice-config.mjs and the web app's Settings panel; read them at call
// time with getVoiceConfig() rather than freezing them at module load.
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5.4-mini";
// Max bytes the smart content viewer will read from a pane-referenced file.
const FILE_VIEWER_MAX_BYTES = 5 * 1024 * 1024;
// Larger cap for media/html opened in an external tab (video especially).
const FILE_EXTERNAL_MAX_BYTES = 50 * 1024 * 1024;
// Extensions the viewer recognizes, mapped to a kind + content type.
const IMAGE_EXTS = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
]);
const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
// Types opened in an external browser tab (not rendered in the in-app modal):
// video and standalone HTML. The browser handles playback/rendering natively.
const EXTERNAL_EXTS = new Map([
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
]);
function fileExt(filePath) {
  return path.extname(String(filePath)).toLowerCase();
}
function fileKind(filePath) {
  const ext = fileExt(filePath);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (EXTERNAL_EXTS.has(ext)) return "external";
  return "other";
}
function fileContentType(filePath) {
  const ext = fileExt(filePath);
  return (
    IMAGE_EXTS.get(ext) ||
    EXTERNAL_EXTS.get(ext) ||
    "text/markdown; charset=utf-8"
  );
}
// Git repo a user clones to run the connector (agent). Shown in the
// "no machine connected" UI; override for forks/mirrors.
const CONNECTOR_CLONE_URL =
  process.env.TMUX_MOBILE_CLONE_URL ||
  "https://github.com/cjzeroxaa/tmux-mobile.git";
const WINDOW_BRIEFING_MODEL =
  process.env.OPENAI_WINDOW_BRIEFING_MODEL || "gpt-5.4-mini";
const AGENT_RESPONSE_EXTRACT_MODEL =
  process.env.OPENAI_AGENT_RESPONSE_EXTRACT_MODEL || "gpt-5.4-mini";
const AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS = parsePositiveInteger(
  process.env.OPENAI_AGENT_RESPONSE_EXTRACT_MAX_OUTPUT_TOKENS,
  4096,
);
const configuredSubmitNudgeDelayMs = Number(
  process.env.TMUX_SUBMIT_NUDGE_DELAY_MS,
);
const SUBMIT_NUDGE_DELAY_MS =
  Number.isFinite(configuredSubmitNudgeDelayMs) &&
  configuredSubmitNudgeDelayMs >= 0
    ? configuredSubmitNudgeDelayMs
    : 700;
// Gap between finishing a bracketed paste and sending the submit Enter. tmux
// pastes text wrapped in bracketed-paste markers (ESC[200~ … ESC[201~); if the
// Enter is sent immediately it arrives in the SAME terminal read as the paste
// tail, and input-line apps (Claude/Codex CLIs, readline) often consume it as
// part of paste finalization instead of as "submit" — so the line sits unsent.
// A short delay makes the Enter land as its own keypress, reliably submitting.
const PASTE_ENTER_DELAY_MS = parsePositiveInteger(
  process.env.TMUX_PASTE_ENTER_DELAY_MS,
  120,
);
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
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
  // The annotation (free-text follow-up note) is the LAST field and may contain
  // tabs, so windowFromRow takes everything from its index onward.
  windows:
    "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_flags}\t#{pane_current_command}\t#{pane_current_path}\t#{@tm_annotation}",
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
    // Wait for the bracketed paste to be fully consumed before the Enter, so the
    // app sees Enter as a distinct submit keypress (see PASTE_ENTER_DELAY_MS).
    await delay(PASTE_ENTER_DELAY_MS);
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

function windowFromRow(fields) {
  const [id, index, name, active, panes, flags, activeCommand, cwd] = fields;
  // The annotation is the last format field and is free text (may contain tabs),
  // so take everything from index 8 onward and rejoin rather than positionally.
  const annotation = fields.slice(8).join("\t");
  return {
    id,
    index: Number(index),
    name,
    active: active === "1",
    panes: Number(panes || 0),
    flags,
    activeCommand,
    cwd: cwd || "",
    annotation: annotation || "",
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
  return readSessionRow(sessionId, "renamed");
}

async function readSessionRow(sessionId, what) {
  const stdout = await runTmux(["display-message", "-p", "-t", sessionId, formats.sessions]);
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error(`tmux did not return the ${what} session`);
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

// Shells we don't re-run as a "command" when duplicating — a window sitting at a
// shell prompt should duplicate to a fresh shell, not literally run `bash`.
const DUP_SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

// Duplicate a window: open a new window in the same session, same working
// directory, re-running the command the source window used. cwd comes from the
// active pane; the command prefers pane_start_command (the literal launch
// command, e.g. "sleep 300"), falling back to the running program name
// (pane_current_command) when it's an interactive app rather than a bare shell.
// Suggested values for duplicating a window: the source window's session, name,
// cwd, and the command to re-run. The UI fetches these to pre-fill an editable
// confirmation before the duplicate is actually created. Command prefers
// pane_start_command (the literal launch command, e.g. "sleep 300"), falling
// back to the running program name when it's an interactive app (not a bare
// shell).
async function getDuplicateDefaults(windowId) {
  requireId(windowId, "window");
  const info = await getWindowInfo(windowId);
  const stdout = await runTmux([
    "display-message",
    "-p",
    "-t",
    windowId,
    "#{pane_current_path}\t#{pane_current_command}\t#{pane_start_command}",
  ]);
  const [cwd = "", currentCommand = "", rawStartCommand = ""] = stdout
    .trimEnd()
    .split("\t");

  // tmux returns pane_start_command wrapped in literal double-quotes
  // (e.g. `"sleep 300"`); strip them so the shell runs the actual command and
  // not a program literally named `sleep 300`.
  let startCommand = rawStartCommand.trim();
  if (startCommand.length >= 2 && startCommand.startsWith('"') && startCommand.endsWith('"')) {
    startCommand = startCommand.slice(1, -1);
  }
  const command =
    startCommand ||
    (currentCommand && !DUP_SHELLS.has(currentCommand) ? currentCommand : "");

  return {
    sessionId: info.sessionId,
    name: info.windowName || "",
    command,
    cwd,
  };
}

// Create a new window in the source window's session, same cwd, using the given
// name and command (the UI passes the user-confirmed/adjusted values; both fall
// back to the source defaults when omitted). Empty command -> a plain shell.
async function duplicateWindow(windowId, overrides = {}) {
  requireId(windowId, "window");
  const defaults = await getDuplicateDefaults(windowId);
  const name =
    overrides.name !== undefined ? String(overrides.name).trim() : defaults.name;
  const command =
    overrides.command !== undefined
      ? String(overrides.command).trim()
      : defaults.command;

  // new-window -P -F <fmt> [-c cwd] -t <session> [-n name] [command]
  const args = ["new-window", "-P", "-F", formats.windows, "-t", defaults.sessionId];
  if (defaults.cwd) args.push("-c", defaults.cwd);
  if (name) args.push("-n", name);
  if (command) args.push(command); // shell-command run in the new window
  const created = await runTmux(args);
  clearSessionSummaryCache(defaults.sessionId);
  const [row] = rows(created);
  if (!row) {
    const error = new Error("tmux did not return the duplicated window");
    error.status = 500;
    throw error;
  }
  return { ...windowFromRow(row), duplicatedFrom: windowId, command: command || "" };
}

// Store a free-text follow-up note on the WINDOW as the @tm_annotation
// window-scoped user option (set-option -w). Empty/whitespace clears it. Useful
// for tracking the follow-up of a long-running task in a specific window.
async function setWindowAnnotation(windowId, annotation) {
  requireId(windowId, "window");
  const text = String(annotation ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    const error = new Error("Annotation is too large");
    error.status = 413;
    throw error;
  }
  if (text.trim() === "") {
    await runTmux(["set-option", "-w", "-t", windowId, "-u", "@tm_annotation"]);
  } else {
    await runTmux(["set-option", "-w", "-t", windowId, "@tm_annotation", text]);
  }
  const stdout = await runTmux(["display-message", "-p", "-t", windowId, formats.windows]);
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error("tmux did not return the annotated window");
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

async function createSpeechAudio(text, overrides = {}) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  // Default to the user's saved config, but let callers (e.g. the voice
  // preview) pin a specific model/voice without mutating saved settings.
  const config = getVoiceConfig();
  const speechModel = overrides.model || config.speechModel;
  const speechVoice = overrides.voice || config.speechVoice;
  const body = {
    model: speechModel,
    voice: speechVoice,
    input: text,
    response_format: "mp3",
  };

  if (speechModel.startsWith("gpt-4o")) {
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

  const { realtimeModel, realtimeVoice } = getVoiceConfig();
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
          model: realtimeModel,
          instructions: REALTIME_WINDOW_BRIEFING_INSTRUCTIONS,
          max_output_tokens: REALTIME_WINDOW_BRIEFING_MAX_OUTPUT_TOKENS,
          output_modalities: ["audio"],
          audio: {
            input: {
              turn_detection: null,
            },
            output: {
              voice: realtimeVoice,
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
  form.append("model", getVoiceConfig().transcribeModel);
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

function safeEqual(actualValue, expectedValue) {
  const actual = Buffer.from(String(actualValue || ""));
  const expected = Buffer.from(String(expectedValue || ""));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const SESSION_COOKIE = "tmux_mobile_session";
const OAUTH_SCOPE = "openid email profile";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const AGENT_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const oauthStates = new Map();
const deviceSessions = new Map();

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function base64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64urlJson(value) {
  return base64urlEncode(JSON.stringify(value));
}

function signValue(value) {
  return createHmac("sha256", process.env.SESSION_SECRET || "")
    .update(value)
    .digest("base64url");
}

function issueSignedToken(payload, ttlSeconds) {
  const body = base64urlJson({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  return `${body}.${signValue(body)}`;
}

function verifySignedToken(token, expectedType) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature || !safeEqual(signature, signValue(body))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.type !== expectedType) return null;
  if (!payload.userId || !payload.email) return null;
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function originForRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host || `${HOST}:${PORT}`}`;
}

function cookieSecure(req) {
  return originForRequest(req).startsWith("https://");
}

function setSessionCookie(req, res, user) {
  const token = issueSignedToken(
    { type: "session", userId: user.userId, email: user.email, sub: user.sub },
    SESSION_TTL_SECONDS,
  );
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (cookieSecure(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (cookieSecure(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

function authenticateBrowser(req) {
  return verifySignedToken(parseCookies(req)[SESSION_COOKIE], "session");
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : "";
}

function authenticateAgent(req) {
  const tokenUser = verifySignedToken(bearerToken(req), "agent");
  if (tokenUser) return tokenUser.userId;
  if (process.env.TMUX_MOBILE_ENABLE_LEGACY_AUTH !== "1") return null;

  const legacySecret = process.env.AGENT_SECRET || "";
  if (legacySecret && safeEqual(req.headers["x-agent-secret"], legacySecret)) {
    return String(process.env.TMUX_MOBILE_USER || "default");
  }
  return null;
}

function randomId(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function sendRedirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  res.end();
}

function readAllowedGoogleConfig() {
  return {
    emails: new Set(splitCsv(process.env.ALLOWED_GOOGLE_EMAILS)),
    domains: new Set(splitCsv(process.env.ALLOWED_GOOGLE_DOMAINS)),
  };
}

function assertGoogleUserAllowed(user) {
  const allowed = readAllowedGoogleConfig();
  const email = String(user.email || "").toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() : "";
  if (allowed.emails.has(email) || allowed.domains.has(domain)) return;

  const error = new Error("Google account is not allowed for this controller");
  error.status = 403;
  throw error;
}

function googleOAuthEndpoints() {
  return {
    auth: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    token: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    deviceCode:
      process.env.GOOGLE_DEVICE_CODE_URL || "https://oauth2.googleapis.com/device/code",
    tokenInfo:
      process.env.GOOGLE_TOKENINFO_URL || "https://oauth2.googleapis.com/tokeninfo",
  };
}

function oauthRedirectUri(req) {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `${originForRequest(req)}/auth/google/callback`
  );
}

async function googleTokenInfo(idToken, expectedAudience) {
  const endpoints = googleOAuthEndpoints();
  const url = new URL(endpoints.tokenInfo);
  url.searchParams.set("id_token", idToken);
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || "Google token verification failed");
    error.status = 401;
    throw error;
  }
  if (String(data.aud || "") !== expectedAudience) {
    const error = new Error("Google token audience did not match this controller");
    error.status = 401;
    throw error;
  }
  if (String(data.email_verified) !== "true" && data.email_verified !== true) {
    const error = new Error("Google account email is not verified");
    error.status = 403;
    throw error;
  }
  const email = String(data.email || "").trim().toLowerCase();
  if (!email) {
    const error = new Error("Google token did not include an email");
    error.status = 403;
    throw error;
  }
  const user = { userId: email, email, sub: String(data.sub || "") };
  assertGoogleUserAllowed(user);
  return user;
}

async function exchangeAuthorizationCode(code, redirectUri) {
  const response = await fetch(googleOAuthEndpoints().token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || "Google OAuth code exchange failed");
    error.status = 401;
    throw error;
  }
  if (!data.id_token) {
    const error = new Error("Google OAuth response did not include an ID token");
    error.status = 401;
    throw error;
  }
  return data;
}

async function exchangeDeviceCode(deviceCode) {
  const response = await fetch(googleOAuthEndpoints().token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_DEVICE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_DEVICE_CLIENT_SECRET || "",
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { done: true, data };
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { done: false, slowDown: data.error === "slow_down" };
  }
  const error = new Error(data.error_description || data.error || "Google device login failed");
  error.status = 401;
  throw error;
}

async function handleAuthRoute(req, res, url) {
  if (req.method === "GET" && url.pathname === "/auth/me") {
    const user = authenticateBrowser(req);
    if (!user) {
      sendJson(res, 401, { error: "Authentication required" });
      return true;
    }
    sendJson(res, 200, { email: user.email, userId: user.userId });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/logout") {
    clearSessionCookie(req, res);
    sendRedirect(res, "/");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/google/login") {
    const state = randomId();
    const returnTo = safeReturnPath(url.searchParams.get("returnTo") || "/");
    const redirectUri = oauthRedirectUri(req);
    oauthStates.set(state, {
      createdAt: Date.now(),
      redirectUri,
      returnTo,
    });
    pruneAuthState();

    const googleUrl = new URL(googleOAuthEndpoints().auth);
    googleUrl.searchParams.set("client_id", process.env.GOOGLE_OAUTH_CLIENT_ID || "");
    googleUrl.searchParams.set("redirect_uri", redirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", OAUTH_SCOPE);
    googleUrl.searchParams.set("state", state);
    googleUrl.searchParams.set("prompt", "select_account");
    const loginHint = url.searchParams.get("loginHint");
    if (loginHint) googleUrl.searchParams.set("login_hint", loginHint);
    sendRedirect(res, googleUrl.toString());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/google/callback") {
    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    const pending = oauthStates.get(state);
    oauthStates.delete(state);
    if (!pending || !code) {
      sendJson(res, 400, { error: "Invalid OAuth callback" });
      return true;
    }
    const tokenData = await exchangeAuthorizationCode(code, pending.redirectUri);
    const user = await googleTokenInfo(
      tokenData.id_token,
      process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    );
    setSessionCookie(req, res, user);
    sendRedirect(res, pending.returnTo || "/");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/device/start") {
    const response = await fetch(googleOAuthEndpoints().deviceCode, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_DEVICE_CLIENT_ID || "",
        scope: OAUTH_SCOPE,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error_description || data.error || "Google device login start failed");
      error.status = 502;
      throw error;
    }
    const id = randomId();
    const interval = Math.max(Number(data.interval || 5), 1);
    deviceSessions.set(id, {
      deviceCode: data.device_code,
      interval,
      expiresAt: Date.now() + Math.max(Number(data.expires_in || 600), 60) * 1000,
      lastPollAt: 0,
    });
    pruneDeviceSessions();
    sendJson(res, 200, {
      id,
      userCode: data.user_code,
      verificationUrl: data.verification_url || data.verification_uri,
      verificationUrlComplete: data.verification_url_complete,
      expiresIn: Number(data.expires_in || 600),
      interval,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/device/poll") {
    const body = await readJsonBody(req);
    const id = String(body.id || "");
    const pending = deviceSessions.get(id);
    if (!pending || pending.expiresAt < Date.now()) {
      deviceSessions.delete(id);
      sendJson(res, 410, { error: "Device login expired" });
      return true;
    }
    const elapsedMs = Date.now() - pending.lastPollAt;
    if (pending.lastPollAt && elapsedMs < Math.max(pending.interval - 1, 1) * 1000) {
      sendJson(res, 202, { pending: true, interval: pending.interval });
      return true;
    }
    pending.lastPollAt = Date.now();
    const result = await exchangeDeviceCode(pending.deviceCode);
    if (!result.done) {
      if (result.slowDown) pending.interval += 5;
      sendJson(res, 202, { pending: true, interval: pending.interval });
      return true;
    }
    if (!result.data.id_token) {
      const error = new Error("Google device response did not include an ID token");
      error.status = 401;
      throw error;
    }
    const user = await googleTokenInfo(
      result.data.id_token,
      process.env.GOOGLE_DEVICE_CLIENT_ID || "",
    );
    deviceSessions.delete(id);
    sendJson(res, 200, {
      token: issueSignedToken(
        { type: "agent", userId: user.userId, email: user.email, sub: user.sub },
        AGENT_TOKEN_TTL_SECONDS,
      ),
      user: { email: user.email, userId: user.userId },
      expiresIn: AGENT_TOKEN_TTL_SECONDS,
    });
    return true;
  }

  return false;
}

function safeReturnPath(value) {
  const pathValue = String(value || "/");
  if (!pathValue.startsWith("/") || pathValue.startsWith("//")) return "/";
  return pathValue;
}

function pruneAuthState() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, pending] of oauthStates) {
    if (pending.createdAt < cutoff) oauthStates.delete(state);
  }
}

function pruneDeviceSessions() {
  const now = Date.now();
  for (const [id, pending] of deviceSessions) {
    if (pending.expiresAt < now) deviceSessions.delete(id);
  }
}

function sendAuthChallenge(res) {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="tmux-mobile", charset="UTF-8"',
  });
  res.end("Authentication required");
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
    sendJson(res, 200, { ok: true, revision: APP_REVISION });
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

  // Suggested name/command/cwd for duplicating a window — the UI fetches this to
  // pre-fill the editable confirmation before actually creating the duplicate.
  if (req.method === "GET" && url.pathname === "/api/window-duplicate-info") {
    const windowId = requireId(url.searchParams.get("windowId"), "window");
    sendJson(res, 200, await getDuplicateDefaults(windowId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    // `duplicateFrom` present -> clone that window (same cwd, with the
    // user-confirmed name/command); otherwise create a fresh window.
    if (Object.prototype.hasOwnProperty.call(body, "duplicateFrom")) {
      const windowId = requireId(body.duplicateFrom, "window");
      sendJson(
        res,
        200,
        await duplicateWindow(windowId, { name: body.name, command: body.command }),
      );
    } else {
      const sessionId = requireId(body.sessionId, "session");
      sendJson(res, 200, await createWindow(sessionId));
    }
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/windows") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    // `annotation` present -> set the follow-up note; otherwise rename.
    if (Object.prototype.hasOwnProperty.call(body, "annotation")) {
      sendJson(res, 200, await setWindowAnnotation(windowId, body.annotation));
    } else {
      sendJson(res, 200, await renameWindow(windowId, body.name));
    }
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

  // Smart content viewer: read a file referenced in a pane, resolving a relative
  // path against the pane's cwd (absolute/~ paths resolve as given). The only
  // boundary is the OS file permissions of the user the agent runs as — a file
  // that user can read is served; one they can't yields EACCES.
  if (req.method === "GET" && url.pathname === "/api/file") {
    const paneId = requireId(url.searchParams.get("paneId"), "pane");
    const requestedPath = String(url.searchParams.get("path") || "");
    if (!requestedPath) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const kind = fileKind(requestedPath);
    if (kind === "other") {
      sendJson(res, 415, { error: "Unsupported file type" });
      return;
    }
    const backend = currentBackend();
    // The connected agent may predate the readfile op (connector not restarted
    // onto current code). Detect that up front and tell the user plainly instead
    // of leaking a raw "unknown op: readfile" from the agent.
    if (typeof backend.supportsOp === "function" && !backend.supportsOp(OP.READFILE)) {
      sendJson(res, 501, {
        error:
          "This machine's connector is out of date — restart it (node server.mjs --register …) to view files.",
      });
      return;
    }
    const cwd = await getPaneCwd(paneId);
    // cwd is only needed to resolve a relative path; absolute and ~ paths don't
    // need it.
    const isAbsoluteOrHome = path.isAbsolute(requestedPath) || requestedPath.startsWith("~");
    if (!cwd && !isAbsoluteOrHome) {
      sendJson(res, 404, { error: "Pane has no working directory" });
      return;
    }
    let result;
    try {
      result = await backend.readfile(requestedPath, {
        baseDir: cwd,
        maxBytes: kind === "external" ? FILE_EXTERNAL_MAX_BYTES : FILE_VIEWER_MAX_BYTES,
      });
    } catch (error) {
      // Safety net: an agent that slipped past the capability check (or any
      // backend missing the method) still gets a clear message.
      if (/unknown op/i.test(error.message) || error instanceof TypeError) {
        sendJson(res, 501, {
          error:
            "This machine's connector is out of date — restart it to view files.",
        });
        return;
      }
      const status = error.code === "EACCES" ? 403 : 404;
      sendJson(res, status, { error: error.message || "Could not read file" });
      return;
    }
    sendJson(res, 200, {
      path: requestedPath,
      name: path.basename(requestedPath),
      kind,
      contentType: fileContentType(requestedPath),
      base64: result.base64,
      size: result.size,
      truncated: result.truncated,
    });
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

    let sendResult;
    if (text.length > 0) {
      // Paste + (optionally) Enter in one call so the paste->Enter delay applies
      // and the Enter reliably submits rather than being eaten by the paste.
      sendResult = await sendTextToPane(paneId, text, { enter: sendEnter });
      if (sendEnter && submitNudge) {
        sendSubmitNudge(paneId);
      }
    } else {
      // No text — a bare Enter keypress (e.g. the Enter quick-key). No paste, so
      // no race; send it directly.
      sendResult = { mode: "none", sentEnter: false };
      if (sendEnter) {
        await runTmux(["send-keys", "-t", paneId, "Enter"]);
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

    sendJson(res, 200, { text, model: getVoiceConfig().transcribeModel });
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

    // Paste + Enter together so the paste->Enter delay applies and the Enter
    // reliably submits (rather than being consumed by the bracketed paste).
    const sendResult = await sendTextToPane(paneId, text, { enter: sendEnter });
    if (sendEnter && submitNudge) {
      sendSubmitNudge(paneId);
    }

    sendJson(res, 200, {
      ok: true,
      text,
      model: getVoiceConfig().transcribeModel,
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
    const { speechModel, speechVoice } = getVoiceConfig();
    const startedAt = Date.now();
    logServerEvent("window_audio_summary_started", {
      paneId,
      windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel,
      voice: speechVoice,
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
      speechModel,
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
      speechModel,
      voice: speechVoice,
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
    const { realtimeModel, realtimeVoice } = getVoiceConfig();
    const startedAt = Date.now();
    logServerEvent("window_realtime_session_started", {
      windowId,
      paneId,
      lines,
      realtimeModel,
      voice: realtimeVoice,
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
      realtimeModel,
      voice: realtimeVoice,
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
      model: realtimeModel,
      voice: realtimeVoice,
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

// Mode: `--register <hubUrl>` runs as an agent for the cloud; `--hub` serves the
// app and brokers to registered agents; `--controller` is the public Cloud Run
// hub variant with app auth; default is today's local server.
function parseMode(args) {
  const registerIndex = args.indexOf("--register");
  if (registerIndex !== -1) {
    return {
      kind: "register",
      hubUrl: args[registerIndex + 1] || process.env.HUB_URL,
      login: args.includes("--login"),
    };
  }
  if (args.includes("--controller")) return { kind: "controller" };
  if (args.includes("--hub")) return { kind: "hub" };
  return { kind: "local" };
}

const MODE = parseMode(process.argv.slice(2));
const HOST = process.env.HOST || (MODE.kind === "controller" ? "0.0.0.0" : "127.0.0.1");
const IS_HUB_MODE = MODE.kind === "hub" || MODE.kind === "controller";
const REQUIRE_BROWSER_AUTH =
  MODE.kind === "controller" || process.env.TMUX_MOBILE_REQUIRE_AUTH === "1";

function validateStartupConfig() {
  if (MODE.kind !== "controller") return;

  const missing = [];
  for (const key of [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_DEVICE_CLIENT_ID",
    "GOOGLE_DEVICE_CLIENT_SECRET",
    "OPENAI_API_KEY",
    "SESSION_SECRET",
  ]) {
    if (!process.env[key]) missing.push(key);
  }
  if (!process.env.ALLOWED_GOOGLE_EMAILS && !process.env.ALLOWED_GOOGLE_DOMAINS) {
    missing.push("ALLOWED_GOOGLE_EMAILS or ALLOWED_GOOGLE_DOMAINS");
  }
  if (missing.length > 0) {
    console.error(
      `controller mode requires ${missing.join(", ")} to be set`,
    );
    process.exit(2);
  }
}

validateStartupConfig();

if (MODE.kind === "register") {
  if (!MODE.hubUrl) {
    console.error("usage: node server.mjs --register <hubUrl>");
    process.exit(2);
  }
  const { agentAuthState, loginAgent, runAgent } = await import("./lib/agent.mjs");
  let authState = agentAuthState(MODE.hubUrl);
  const shouldLogin = MODE.login || !authState.hasAuth;
  logServerEvent("agent_starting", {
    controller: new URL(MODE.hubUrl).origin,
    machine: process.env.AGENT_MACHINE || os.hostname(),
    login: shouldLogin,
    authSource: authState.source,
    message: shouldLogin
      ? "No agent token is available, or re-login was requested; starting Google device login before registration."
      : "Starting agent with existing credentials; this machine will register with the controller.",
  });
  if (shouldLogin) {
    await loginAgent(MODE.hubUrl);
    authState = agentAuthState(MODE.hubUrl);
    logServerEvent("agent_login_ready", {
      controller: new URL(MODE.hubUrl).origin,
      machine: process.env.AGENT_MACHINE || os.hostname(),
      authSource: authState.source,
      message: "Agent login is ready; connecting to the controller.",
    });
  }
  runAgent(MODE.hubUrl, localBackend, { logEvent: logServerEvent });
} else {
  let hub = null;

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);

      if (await handleAuthRoute(req, res, url)) {
        return;
      }

      if (
        REQUIRE_BROWSER_AUTH &&
        url.pathname !== "/api/health" &&
        !authenticateBrowser(req)
      ) {
        if (url.pathname.startsWith("/api/")) {
          sendJson(res, 401, { error: "Authentication required" });
        } else {
          sendRedirect(
            res,
            `/auth/google/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`,
          );
        }
        return;
      }
      const authenticatedUser = REQUIRE_BROWSER_AUTH ? authenticateBrowser(req) : null;
      const userId = REQUIRE_BROWSER_AUTH
        ? authenticatedUser?.userId
        : String(process.env.TMUX_MOBILE_USER || "default");

      if (req.method === "GET" && url.pathname === "/api/runtime") {
        sendJson(res, 200, {
          mode: IS_HUB_MODE ? "hub" : MODE.kind,
          revision: APP_REVISION,
          // Connector repo, shown in the "no machine connected" UI so a user
          // knows what to clone. Overridable via env for forks/mirrors.
          cloneUrl: CONNECTOR_CLONE_URL,
        });
        return;
      }

      // Voice model settings are per-user (each authenticated user has their own
      // transcription / TTS / realtime models), so they're keyed by userId and
      // live above the hub/machine routing rather than per-pane.
      if (url.pathname === "/api/voice-config") {
        if (req.method === "GET") {
          sendJson(res, 200, describeVoiceConfig(userId));
          return;
        }
        if (req.method === "PUT" || req.method === "POST") {
          const body = await readJsonBody(req);
          try {
            updateVoiceConfig(body, userId);
          } catch (error) {
            // updateVoiceConfig throws status 400 on a bad value; a persistence
            // failure (read-only home dir) carries persisted:false but the
            // in-memory override still took effect, so report success with a note.
            if (error.persisted === false) {
              sendJson(res, 200, {
                ...describeVoiceConfig(userId),
                persisted: false,
                note: error.message,
              });
              return;
            }
            sendJson(res, error.status || 400, { error: error.message });
            return;
          }
          sendJson(res, 200, { ...describeVoiceConfig(userId), persisted: true });
          return;
        }
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      // Voice preview: synthesize a short sample phrase in a chosen voice so the
      // user can hear it before saving. Validates the voice against the curated
      // allowlist and never mutates the user's saved config.
      if (req.method === "POST" && url.pathname === "/api/voice-preview") {
        const body = await readJsonBody(req);
        const voice = String(body.voice || "");
        if (!VOICE_OPTIONS.voice.includes(voice)) {
          sendJson(res, 400, {
            error: `Unknown voice: ${voice}. Allowed: ${VOICE_OPTIONS.voice.join(", ")}`,
          });
          return;
        }
        const sample =
          typeof body.text === "string" && body.text.trim()
            ? body.text.trim().slice(0, 200)
            : `Hi, this is the ${voice} voice. Your terminal is ready when you are.`;
        const audioBase64 = await createSpeechAudio(sample, { voice });
        sendJson(res, 200, { audioBase64, mimeType: "audio/mpeg", voice });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (hub) {
          if (req.method === "GET" && url.pathname === "/api/machines") {
            sendJson(res, 200, hub.listMachines(userId));
            return;
          }
          if (url.pathname === "/api/health") {
            sendJson(res, 200, { ok: true, revision: APP_REVISION });
            return;
          }
          const machineId =
            req.headers["x-machine-id"] ||
            url.searchParams.get("machineId") ||
            hub.soleMachineId(userId);
          if (!machineId) {
            sendJson(res, 400, {
              error: "machineId is required (multiple machines online)",
            });
            return;
          }
          if (!hub.hasMachine(userId, machineId)) {
            sendJson(res, 503, { error: `Machine ${machineId} is offline` });
            return;
          }
          await withBackend(hub.backendFor(userId, machineId), () =>
            withVoiceUser(userId, () => handleApi(req, res, url)),
          );
          return;
        }
        await withVoiceUser(userId, () => handleApi(req, res, url));
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

  if (IS_HUB_MODE) {
    const { createHub } = await import("./lib/hub.mjs");
    hub = createHub(server, {
      logEvent: logServerEvent,
      authenticateAgent: MODE.kind === "controller"
        ? authenticateAgent
        : () => String(process.env.TMUX_MOBILE_USER || "default"),
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`tmux ${MODE.kind} listening at http://${HOST}:${PORT}`);
  });

  // Graceful shutdown. Cloud Run sends SIGTERM to an old instance before it is
  // torn down during a revision rollout; closing agent WebSockets here makes
  // each agent reconnect immediately (onto the new revision) instead of staying
  // pinned to this dying instance until its socket eventually dies on its own.
  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logServerEvent("controller_shutdown", {
      signal,
      revision: APP_REVISION,
      message: "Closing agent connections so agents reconnect to the new revision.",
    });
    try {
      hub?.shutdown();
    } catch {}
    server.close(() => process.exit(0));
    // Don't wait forever for lingering keep-alive sockets to drain.
    setTimeout(() => process.exit(0), 5_000).unref?.();
  }
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}
