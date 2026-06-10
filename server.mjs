import { readFileSync } from "node:fs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  currentBackend,
  findClaudeSessionFromBackend,
  localBackend,
  readClaudeTranscriptFromSession,
  withBackend,
} from "./lib/backend.mjs";
import { CONNECTOR_COMPAT_VERSION, OP } from "./lib/protocol.mjs";
import {
  computeWindowMetadata,
  createMetadataCache,
  detectCommandCenterAgentType,
} from "./lib/window-metadata.mjs";
import { detectTurn } from "./lib/turn-detection.mjs";
import { detectAgentMode, AGENT_MODES } from "./lib/agent-mode.mjs";
import { isScrollbackMode } from "./lib/pane-mode.mjs";
import { renderMarkdown } from "./public/markdown.js";
import { escapeHtml as escapeHtmlShared } from "./public/linkify.js";
import { detectAskQuestion, parseAskQuestion } from "./lib/ask-question.mjs";
import {
  singleSelectKeys,
  multiSelectKeys,
  reviewSubmitKeys,
  freeFormKeys,
  cancelKeys,
} from "./lib/ask-question-keys.mjs";
import {
  VOICE_OPTIONS,
  describeVoiceConfig,
  getVoiceConfig,
  updateVoiceConfig,
  withVoiceUser,
} from "./lib/voice-config.mjs";
import { appRevision } from "./lib/revision.mjs";
import {
  createAgentRoundNtfyNotifier,
  createNtfyConfig,
  NTFY_TOPIC_PREFIX,
} from "./lib/agent-ntfy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadLocalEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3737);
// Browser tab / PWA name. Defaults to a clean product name rather than the host
// name (which on Cloud Run / local shows unhelpful values like "localhost").
// Override with TMUX_MOBILE_APP_TITLE.
const APP_TITLE = process.env.TMUX_MOBILE_APP_TITLE || "tmux Mobile";
const APP_REVISION = appRevision(__dirname);
const CONNECTOR_VERSION =
  process.env.TMUX_MOBILE_CONNECTOR_VERSION || CONNECTOR_COMPAT_VERSION;
const DEFAULT_MACHINE_ALIASES = {
  "homos-mac-mini.local": "mini",
  "macbook-pro-15.local": "MacBook",
  "macbook": "MacBook",
  "fulong-mini": "FIN Mini",
  "ip-172-31-7-169.ec2.internal": "MSB-REBYTE",
  "msbbuild-rebyte": "MSB-REBYTE",
  "msb-build-srp.us-central1-a.c.cj-dev-498907.internal": "MSB-SRP",
  "msb-build-srp": "MSB-SRP",
  "msb-srp": "MSB-SRP",
};
const MACHINE_ALIASES = readMachineAliases(
  process.env.TMUX_MOBILE_MACHINE_ALIASES,
  DEFAULT_MACHINE_ALIASES,
);
const MAX_BODY_BYTES = 512 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
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
// video, audio, and standalone HTML. The browser handles playback/rendering
// natively (audio opens with built-in <audio> controls in the new tab).
const EXTERNAL_EXTS = new Map([
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  // Audio — served inline so the browser tab plays it with native controls.
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
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

// Make a basename safe for a Content-Disposition filename: strip path bits and
// quotes/control chars that could break the header or smuggle directives.
function sanitizeFilename(name) {
  return String(name || "file")
    .replace(/^.*[/\\]/, "") // basename only
    .replace(/["\r\n]/g, "") // no quotes/newlines in the header
    .replace(/[\x00-\x1f]/g, "")
    .slice(0, 255) || "file";
}

// Wrap rendered markdown in a minimal, self-contained HTML page for a new tab.
// The <title> is the file name so the tab label and "Save as…" are sensible.
// Styles are inlined (the tab isn't the app) and kept close to the in-app viewer.
function renderMarkdownPage(name, markdown, truncated) {
  const title = escapeHtmlShared(sanitizeFilename(name));
  const body = renderMarkdown(markdown);
  const note = truncated
    ? '<p class="trunc">Showing the first part of a large file.</p>'
    : "";
  // Lazily upgrade ```mermaid blocks to diagrams — only inject the script when
  // the page actually contains one (mirrors the in-app lazy CDN loader). strict
  // securityLevel so an untrusted diagram can't inject HTML/script.
  const mermaidScript = /class="mermaid-block"/.test(body)
    ? `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict",
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
  let n = 0;
  for (const block of document.querySelectorAll('pre.mermaid-block')) {
    try {
      const { svg } = await mermaid.render("md-" + (++n), block.textContent);
      const fig = document.createElement("div"); fig.innerHTML = svg; block.replaceWith(fig);
    } catch (e) { block.title = "Mermaid render failed: " + (e?.message || ""); }
  }
</script>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 820px; margin: 0 auto; padding: 24px 18px 64px;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1,h2,h3,h4 { line-height: 1.25; }
  pre { background: rgba(127,127,127,.12); padding: 12px; border-radius: 8px; overflow:auto; }
  code { background: rgba(127,127,127,.14); padding: .1em .35em; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(127,127,127,.4); padding: 6px 10px; }
  blockquote { margin: .6em 0; padding-left: 12px; border-left: 3px solid rgba(127,127,127,.5); opacity:.85; }
  img { max-width: 100%; height: auto; }
  li.task-item { list-style: none; margin-left: -1.2em; }
  del { opacity: .7; }
  .trunc { color: #b26b00; font-style: italic; }
  svg { max-width: 100%; height: auto; }
</style>
</head><body>
${note}
${body}
${mermaidScript}
</body></html>`;
}

// Shared validation + read for the file-serving routes (/api/file, /api/file-raw,
// /api/file-view). Returns { requestedPath, name, kind, contentType, result } on
// success, or null after sending the appropriate error response.
async function readFileForServing(req, res, url) {
  const paneId = requireId(url.searchParams.get("paneId"), "pane");
  const requestedPath = String(url.searchParams.get("path") || "");
  if (!requestedPath) {
    sendJson(res, 400, { error: "path is required" });
    return null;
  }
  const kind = fileKind(requestedPath);
  if (kind === "other") {
    sendJson(res, 415, { error: "Unsupported file type" });
    return null;
  }
  const backend = currentBackend();
  if (typeof backend.supportsOp === "function" && !backend.supportsOp(OP.READFILE)) {
    sendJson(res, 501, {
      error:
        "This machine's connector is out of date — restart it (node server.mjs --register …) to view files.",
    });
    return null;
  }
  const cwd = await getPaneCwd(paneId);
  const isAbsoluteOrHome = path.isAbsolute(requestedPath) || requestedPath.startsWith("~");
  if (!cwd && !isAbsoluteOrHome) {
    sendJson(res, 404, { error: "Pane has no working directory" });
    return null;
  }
  try {
    const result = await backend.readfile(requestedPath, {
      baseDir: cwd,
      maxBytes: kind === "external" ? FILE_EXTERNAL_MAX_BYTES : FILE_VIEWER_MAX_BYTES,
    });
    return {
      requestedPath,
      name: path.basename(requestedPath),
      kind,
      contentType: fileContentType(requestedPath),
      result,
    };
  } catch (error) {
    if (/unknown op/i.test(error.message) || error instanceof TypeError) {
      sendJson(res, 501, {
        error: "This machine's connector is out of date — restart it to view files.",
      });
      return null;
    }
    const status = error.code === "EACCES" ? 403 : 404;
    sendJson(res, status, { error: error.message || "Could not read file" });
    return null;
  }
}

// Sanitize a voice-send prefix (e.g. "/btw "). Allow a leading-slash command
// word plus an optional trailing space — letters/digits/-/_ only — and cap the
// length, so it can't smuggle control sequences or shell into the pasted text.
function sanitizeVoicePrefix(raw) {
  const s = String(raw || "").slice(0, 32);
  const m = s.match(/^(\/[A-Za-z][A-Za-z0-9_-]{0,20})(\s?)$/);
  if (!m) return "";
  return `${m[1]} `; // normalize to exactly one trailing space
}
// Git repo a user clones to run the connector (agent). Shown in the
// "no machine connected" UI; override for forks/mirrors.
const CONNECTOR_CLONE_URL =
  process.env.TMUX_MOBILE_CLONE_URL ||
  "https://github.com/cjzeroxaa/tmux-mobile.git";
const DEFAULT_CONTROLLER_URL =
  process.env.TMUX_MOBILE_CONTROLLER_URL || "https://eng.impo.ai";
const CONNECTOR_UPDATE_SCRIPT_PATH = "scripts/update-connector.mjs";
const CONNECTOR_UPDATE_SCRIPT_URL =
  process.env.TMUX_MOBILE_UPDATE_SCRIPT_URL ||
  defaultConnectorUpdateScriptUrl(CONNECTOR_CLONE_URL, APP_REVISION);
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
// Delay between keystrokes when driving the AskUserQuestion TUI, so its cursor
// movement / toggles keep up with the input over the WebSocket.
const ASK_KEY_DELAY_MS = parsePositiveInteger(
  process.env.TMUX_ASK_KEY_DELAY_MS,
  140,
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

function defaultConnectorUpdateScriptUrl(cloneUrl, revision) {
  const ref = safeUpdateToken(revision) || "main";
  const repo = githubRepoPath(cloneUrl);
  if (!repo) {
    return `https://raw.githubusercontent.com/cjzeroxaa/tmux-mobile/${ref}/${CONNECTOR_UPDATE_SCRIPT_PATH}`;
  }
  return `https://raw.githubusercontent.com/${repo}/${ref}/${CONNECTOR_UPDATE_SCRIPT_PATH}`;
}

function githubRepoPath(cloneUrl) {
  const url = String(cloneUrl || "").trim();
  const https = url.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = url.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return "";
}

function safeUpdateToken(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._/-]{1,120}$/.test(text) ? text : "";
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
    "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_flags}\t#{pane_current_command}\t#{pane_tty}\t#{pane_current_path}\t#{@tm_annotation}",
  // pane_pid is included for structured agent transcript lookup and fork-agent.
  // pane_title is the LAST field and may contain tabs, so listPanes rejoins it.
  panes:
    "#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_mode}\t#{pane_pid}\t#{pane_title}",
  paneInfo:
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_active}",
};

const allowedKeys = new Set([
  "Enter",
  "q",
  "C-c",
  "C-d",
  "C-u",
  "C-z",
  "Tab",
  "BTab", // Shift+Tab — cycles agent permission mode (Claude + Codex)
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
  return /no server running|failed to connect to server|error connecting to .*\/tmux-/i.test(
    error.message,
  );
}

function rows(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function requireTmuxFieldCount(row, minFields, label) {
  if (row.length >= minFields) return;
  const error = new Error(
    `Malformed tmux ${label} row: expected at least ${minFields} tab-separated fields, got ${row.length}`,
  );
  error.status = 500;
  throw error;
}

function requireTmuxNumericField(value, label) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const error = new Error(`Malformed tmux row: ${label} must be numeric`);
  error.status = 500;
  throw error;
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

function requireDirectoryPath(value) {
  const dirPath = String(value || "").trim();
  if (!dirPath) {
    const error = new Error("Directory path is required");
    error.status = 400;
    throw error;
  }
  if (dirPath.length > 4096 || /[\0\r\n]/.test(dirPath)) {
    const error = new Error("Directory path is invalid");
    error.status = 400;
    throw error;
  }
  return dirPath;
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
  // If the pane is parked in copy-mode (scrollback pager), a paste/Enter is
  // swallowed by the pager and the window looks stuck. Exit it first. Centralized
  // here so EVERY text-send path is covered (voice-send, /api/send, …), not just
  // the endpoints that remembered to call it.
  await exitCopyModeIfNeeded(paneId);
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

// Before delivering any input, drop the pane out of the scrollback pager so the
// keystroke lands on the program. Returns true if it had to exit.
async function exitCopyModeIfNeeded(paneId) {
  let mode = "";
  try {
    mode = (
      await runTmux(["display-message", "-p", "-t", paneId, "#{pane_mode}"])
    ).trim();
  } catch {
    return false; // pane vanished / query failed — let the caller proceed
  }
  if (!isScrollbackMode(mode)) return false;
  // `-X cancel` leaves the pager without disturbing the command line (unlike
  // sending `q`, which the program would receive once we're out of mode).
  await runTmux(["send-keys", "-t", paneId, "-X", "cancel"]);
  return true;
}

function sendSubmitNudge(paneId) {
  setTimeout(() => {
    runTmux(["send-keys", "-t", paneId, "Enter"]).catch((error) => {
      console.error(`submit nudge failed: ${error.message}`);
    });
  }, SUBMIT_NUDGE_DELAY_MS);
}

function sessionFromRow(row) {
  requireTmuxFieldCount(row, 5, "session");
  const [id, name, windows, attached, created] = row;
  requireId(id, "session");
  return {
    id,
    name,
    windows: requireTmuxNumericField(windows || 0, "session_windows"),
    attached: attached === "1",
    created,
  };
}

function windowFromRow(fields) {
  requireTmuxFieldCount(fields, 10, "window");
  const [id, index, name, active, panes, flags, activeCommand, tty, cwd] = fields;
  requireId(id, "window");
  // The annotation is the last format field and is free text (may contain tabs),
  // so take everything from index 9 onward and rejoin rather than positionally.
  const annotation = fields.slice(9).join("\t");
  return {
    id,
    index: requireTmuxNumericField(index, "window_index"),
    name,
    active: active === "1",
    panes: requireTmuxNumericField(panes || 0, "window_panes"),
    flags,
    activeCommand,
    tty: tty || "",
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

const START_AGENT_COMMANDS = {
  codex: { command: "codex", windowName: "codex" },
  claude: { command: "claude", windowName: "claude" },
};

function requireStartAgentKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(START_AGENT_COMMANDS, kind)) return kind;
  const error = new Error("Agent kind must be codex or claude");
  error.status = 400;
  throw error;
}

function sessionSlug(value) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || "work";
}

function defaultStartAgentSessionName(kind, cwd) {
  const trimmed = String(cwd || "").replace(/\/+$/, "");
  const base = path.basename(trimmed) || "home";
  return `${kind}-${sessionSlug(base)}-${Date.now().toString(36)}`;
}

async function startAgentSession(options = {}) {
  const kind = requireStartAgentKind(options.kind);
  const cwd = requireDirectoryPath(options.cwd);
  const spec = START_AGENT_COMMANDS[kind];
  const sessionName = requireSessionName(
    options.sessionName || defaultStartAgentSessionName(kind, cwd),
  );
  const format = `${formats.sessions}\t#{window_id}\t#{pane_id}`;
  const stdout = await runTmux(
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      format,
      "-s",
      sessionName,
      "-n",
      spec.windowName,
      "-c",
      cwd,
    ],
    { timeout: 5000 },
  );
  const [row] = rows(stdout);
  if (!row) {
    const error = new Error("tmux did not return the new agent session");
    error.status = 500;
    throw error;
  }
  requireTmuxFieldCount(row, 7, "agent session");
  const session = sessionFromRow(row.slice(0, 5));
  const windowId = requireId(row[5], "window");
  const paneId = requireId(row[6], "pane");
  await sendTextToPane(paneId, spec.command, { enter: true });
  clearSessionSummaryCache(session.id);
  return {
    ok: true,
    kind,
    command: spec.command,
    cwd,
    session,
    windowId,
    paneId,
  };
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

// Cold-load batch: one `tmux list-windows -a` returns every window on the
// machine, with session_* fields prepended so we can rebuild both the
// sessions[] list and the windows[] list from a single agent round-trip.
// Replaces /api/sessions + N× /api/windows?sessionId=… on app boot.
const TREE_SESSION_FIELDS =
  "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}\t";
async function listTree() {
  let windowRows = [];
  try {
    const stdout = await runTmux([
      "list-windows",
      "-a",
      "-F",
      TREE_SESSION_FIELDS + formats.windows,
    ]);
    windowRows = rows(stdout);
  } catch (error) {
    if (isNoServerError(error)) return { sessions: [], windows: [] };
    throw error;
  }
  // Preserve the original session order (first-time-seen order in list-windows
  // -a output, which mirrors `list-sessions`). Map keeps insertion order.
  const sessionsById = new Map();
  const windows = [];
  for (const row of windowRows) {
    const sessionFields = row.slice(0, 5);
    const windowFields = row.slice(5);
    const [sessionId] = sessionFields;
    if (!sessionsById.has(sessionId)) {
      sessionsById.set(sessionId, sessionFromRow(sessionFields));
    }
    windows.push({ ...windowFromRow(windowFields), sessionId });
  }
  return {
    sessions: [...sessionsById.values()],
    windows,
  };
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

async function startConnectorUpdate(options = {}) {
  const repoDir = safeUpdateValue(options.repoDir, 512) || "~/src/tmux-mobile";
  const controllerUrl = safeControllerUrl(options.controllerUrl) || DEFAULT_CONTROLLER_URL;
  const cloneUrl = safeUpdateValue(options.cloneUrl, 512) || CONNECTOR_CLONE_URL;
  const expectedRevision =
    safeUpdateToken(options.expectedRevision) ||
    safeUpdateToken(APP_REVISION) ||
    "";
  const targetRef = safeUpdateToken(options.targetRef) || "main";
  const nodePath = safeUpdateValue(options.nodePath, 512) || "node";
  const agentMachine = safeUpdateValue(options.agentMachine, 120);
  const machineLabel = safeUpdateValue(options.machineLabel, 120);
  const sessionName = `tmux-mobile-update-${Date.now().toString(36)}`;
  const windowName = "connector-update";
  const scriptUrl = CONNECTOR_UPDATE_SCRIPT_URL;
  const heredoc = `TMUX_MOBILE_UPDATE_${Date.now().toString(36).toUpperCase()}`;
  const inner = [
    "set -euo pipefail",
    `export TMUX_MOBILE_UPDATE_REPO=${shellQuote(repoDir)}`,
    `export TMUX_MOBILE_UPDATE_CONTROLLER=${shellQuote(controllerUrl)}`,
    `export TMUX_MOBILE_UPDATE_CLONE_URL=${shellQuote(cloneUrl)}`,
    `export TMUX_MOBILE_UPDATE_EXPECTED_REVISION=${shellQuote(expectedRevision)}`,
    `export TMUX_MOBILE_UPDATE_REF=${shellQuote(targetRef)}`,
    `export TMUX_MOBILE_UPDATE_AGENT_MACHINE=${shellQuote(agentMachine)}`,
    `export TMUX_MOBILE_UPDATE_SCRIPT_URL=${shellQuote(scriptUrl)}`,
    `NODE_BIN=${shellQuote(nodePath)}`,
    `echo "tmux-mobile connector update${machineLabel ? ` for ${machineLabel}` : ""}"`,
    'echo "script: $TMUX_MOBILE_UPDATE_SCRIPT_URL"',
    'if command -v curl >/dev/null 2>&1; then',
    '  curl -fsSL "$TMUX_MOBILE_UPDATE_SCRIPT_URL" | "$NODE_BIN" --input-type=module',
    "else",
    '  "$NODE_BIN" --input-type=module -e \'const r=await fetch(process.env.TMUX_MOBILE_UPDATE_SCRIPT_URL); if(!r.ok) throw new Error(`download failed ${r.status}`); process.stdout.write(await r.text());\' | "$NODE_BIN" --input-type=module',
    "fi",
    'echo "update command finished; closing this tmux update session"',
    `if command -v tmux >/dev/null 2>&1; then tmux kill-session -t ${shellQuote(sessionName)} >/dev/null 2>&1 || true; fi`,
  ].join("\n");
  const command = `bash <<'${heredoc}'\n${inner}\n${heredoc}`;

  const paneId = (
    await runTmux(
      ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", sessionName, "-n", windowName],
      { timeout: 5000 },
    )
  ).trim();
  if (!paneId) {
    const error = new Error("tmux did not return the update pane");
    error.status = 500;
    throw error;
  }
  await sendTextToPane(paneId, command, { enter: true });
  return {
    ok: true,
    sessionName,
    windowName,
    paneId,
    repoDir,
    controllerUrl,
    expectedRevision,
    scriptUrl,
  };
}

function safeUpdateValue(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) return "";
  return text;
}

function safeControllerUrl(value) {
  const text = safeUpdateValue(value, 512);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || (req.socket?.encrypted ? "https" : "http");
  const host = String(
    req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:3737",
  )
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function shellQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\\''")}'`;
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

// "New branch" quick action for a bare-repo-backed worktree: create a new git
// worktree + branch off the source window's cwd, then open a new tmux window in
// that worktree — running the same command the source window does, like
// Duplicate. The window's cwd is the freshly-created worktree, not the source.
async function newBranchWindow(windowId, { branch, command, name } = {}) {
  requireId(windowId, "window");
  const defaults = await getDuplicateDefaults(windowId);
  if (!defaults.cwd) {
    const error = new Error("source window has no working directory");
    error.status = 400;
    throw error;
  }
  // Create the worktree on the target machine (local or via the agent).
  const created = await currentBackend().worktreeAdd({
    fromDir: defaults.cwd,
    branch: String(branch || ""),
  });
  const finalCommand =
    command !== undefined ? String(command).trim() : defaults.command;
  const finalName =
    name !== undefined && String(name).trim() !== ""
      ? String(name).trim()
      : created.branch; // default the window name to the branch

  const args = ["new-window", "-P", "-F", formats.windows, "-t", defaults.sessionId];
  args.push("-c", created.path); // run IN the new worktree
  if (finalName) args.push("-n", finalName);
  if (finalCommand) args.push(finalCommand);
  const out = await runTmux(args);
  clearSessionSummaryCache(defaults.sessionId);
  const [row] = rows(out);
  if (!row) {
    const error = new Error("tmux did not return the new-branch window");
    error.status = 500;
    throw error;
  }
  return {
    ...windowFromRow(row),
    branch: created.branch,
    path: created.path,
    command: finalCommand || "",
  };
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
  const killedSession = windows.length <= 1;
  await runTmux(["kill-window", "-t", windowId]);
  clearSessionSummaryCache(windowInfo.sessionId);
  return { ok: true, killed: windowInfo, killedSession };
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
    ([id, index, active, command, cwd, width, height, mode, pid, ...titleParts]) => ({
      id,
      index: Number(index),
      active: active === "1",
      command,
      cwd,
      width: Number(width || 0),
      height: Number(height || 0),
      pid: Number(pid || 0) || null,
      // The scrollback pager (copy-mode OR view-mode — see isScrollbackMode)
      // swallows input; that's what the "scroll mode" banner warns about.
      // `pane_mode` is "" when not in a mode.
      inCopyMode: isScrollbackMode(mode),
      // pane_title is last and may contain tabs — rejoin any split pieces.
      title: titleParts.join("\t"),
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
  return directoriesForCwd(cwd);
}

// Shared by listPaneDirectories and getWindowView: turn an already-known cwd
// into the {cwd, parent, entries} payload by reading the directory once.
async function directoriesForCwd(cwd) {
  if (!cwd) return { cwd: "", parent: "", entries: [] };
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

// Switch-window batch: one HTTP request returns everything the client needs to
// render the new window (pane list + the active pane's captured snapshot + cwd
// directory listing). Replaces the sequential /api/panes → /api/directories →
// /api/capture chain. listPanes is one RPC; capture + readdir then fire in
// parallel, so the agent sees 1 + max(1,1) = 2 round-trips, down from 3.
//
// allSettled, not all: a readdir failure on a deleted/inaccessible cwd
// shouldn't blank the snapshot, and vice versa. Each piece carries its own
// error so the client can show partial state — matching today's behavior
// where the directory navigator can be "unavailable" while the snapshot
// renders fine.
async function getWindowView(windowId, lines) {
  const panes = await listPanes(windowId);
  const active = panes.find((p) => p.active) || panes[0] || null;
  if (!active) {
    return {
      panes: [],
      activePaneId: "",
      capture: { paneId: "", mode: "tail", lines, text: "", error: null },
      directories: { cwd: "", parent: "", entries: [], error: null },
    };
  }
  const [captureResult, dirResult] = await Promise.allSettled([
    capturePane(active.id, "tail", lines, { ansi: true }),
    directoriesForCwd(active.cwd),
  ]);
  const captureText =
    captureResult.status === "fulfilled"
      ? cleanTerminalTextKeepAnsi(captureResult.value)
      : "";
  const captureError =
    captureResult.status === "rejected"
      ? captureResult.reason?.message || "capture failed"
      : null;
  const directories =
    dirResult.status === "fulfilled"
      ? { ...dirResult.value, error: null }
      : {
          cwd: active.cwd || "",
          parent: active.cwd ? path.dirname(active.cwd) : "",
          entries: [],
          error: dirResult.reason?.message || "Directory unavailable",
        };
  return {
    panes,
    activePaneId: active.id,
    capture: {
      paneId: active.id,
      mode: "tail",
      lines,
      text: captureText,
      error: captureError,
    },
    directories,
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

// cwd-keyed TTL cache for expensive window metadata (repo, branch). Lives for
// the process; shared across sessions/windows with the same cwd.
const windowMetadataCache = createMetadataCache();

// Returns per-window metadata for a session:
//   { agentType, repo, git, turn, contentHash }
// Live (agentType) + cwd-scoped (repo, git) come from computeWindowMetadata.
// turn (working/idle, agent-specific) and contentHash (for client "unread"
// detection) need pane content, computed here for windows that have an agent.
async function getSessionWindowMetadata(sessionId) {
  const windows = await listWindows(sessionId);
  const base = await computeWindowMetadata(
    windows,
    currentBackend(),
    windowMetadataCache,
    Date.now(),
  );
  // Enrich with turn + contentHash. We capture the active pane once per window
  // and derive both from it. Only windows with a detected agent get a turn;
  // every window gets a contentHash so the client can flag unread changes.
  await Promise.all(
    windows.map(async (win) => {
      try {
        const panes = await listPanes(win.id);
        const pane = panes.find((p) => p.active) || panes[0];
        if (!pane) return;
        // Surface copy-mode so the UI can warn that the pane's scrollback pager
        // is intercepting input (keystrokes won't reach the program until it's
        // exited). /api/send and /api/key auto-exit it, but a banner makes the
        // state visible when it happens.
        base[win.id].inCopyMode = Boolean(pane.inCopyMode);
        const screen = await capturePane(pane.id, "screen");
        const clean = cleanTerminalText(screen);
        base[win.id].contentHash = createHash("sha1")
          .update(clean)
          .digest("hex")
          .slice(0, 16);
        const agentType = base[win.id].agentType;
        if (agentType) {
          const lines = clean.split("\n");
          // detectTurn returns { state, confidence }. Store the state in `turn`
          // (back-compat wire field) and the confidence separately so the client
          // can rank a low-confidence "unverified" window below confirmed items
          // rather than trusting or dropping it (honest-state, Wave 1).
          const t = detectTurn(agentType, {
            title: pane.title,
            paneTail: lines.slice(-12).join("\n"),
          });
          base[win.id].turn = t ? t.state : "";
          base[win.id].turnConfidence = t ? t.confidence : "";
          // Mode/effort needs a DEEPER tail than turn: the model+effort line and
          // the mode line sit above a growing input box, so with command history
          // they can be ~20+ rows up from the bottom. 28 lines reliably spans the
          // whole footer block without scanning the entire scrollback.
          base[win.id].agentMode = detectAgentMode(agentType, {
            title: pane.title,
            paneTail: lines.slice(-28).join("\n"),
          });
        }
        // Cheap "is this pane blocked on an AskUserQuestion prompt?" check — just
        // the detector's two regex tests over the screen we already captured (NOT
        // the full parse, which stays on-demand via /api/ask-question). This lets
        // the UI flag a window as "waiting for your answer" distinctly from a
        // turn that merely ended.
        // detectAskQuestion returns { waiting, confidence }. A low-confidence
        // "maybe blocked" (ambiguous prompt chrome, mid-redraw) is still surfaced
        // — ranked as unverified by the client — rather than silently dropped.
        const ask = detectAskQuestion(clean);
        base[win.id].waitingForInput = ask.waiting;
        base[win.id].waitingConfidence = ask.confidence;
      } catch {
        // pane vanished / capture failed — leave turn & contentHash unset
      }
    }),
  );
  return base;
}

// Attention descriptors for every window on the CURRENT backend's machine: the
// fields the client needs to decide "needs you" (turn / waitingForInput) plus the
// stable identity (session name + window index) it keys unread state by, and the
// contentHash so the client can apply its own unread comparison. Used by the
// cross-machine /api/attention aggregate. Best-effort: a failing session is
// skipped rather than failing the whole sweep.
async function collectMachineAttention() {
  let sessions = [];
  try {
    sessions = rows(await runTmux(["list-sessions", "-F", formats.sessions])).map(
      sessionFromRow,
    );
  } catch (error) {
    if (isNoServerError(error)) return [];
    throw error;
  }
  const out = [];
  await Promise.all(
    sessions.map(async (session) => {
      let windows;
      let meta;
      try {
        windows = await listWindows(session.id);
        meta = await getSessionWindowMetadata(session.id);
      } catch {
        return; // session vanished mid-sweep
      }
      for (const win of windows) {
        const m = meta[win.id] || {};
        out.push({
          sessionName: session.name,
          windowIndex: win.index,
          windowName: win.name,
          agentType: m.agentType || "",
          turn: m.turn || "",
          turnConfidence: m.turnConfidence || "",
          waitingForInput: Boolean(m.waitingForInput),
          waitingConfidence: m.waitingConfidence || "",
          contentHash: m.contentHash || "",
        });
      }
    }),
  );
  return out;
}

// --- AskUserQuestion overlay support (on-demand) ---

// The active pane id for a window (a pane id is also accepted as-is).
async function resolveActivePane(idMaybeWindow) {
  // If it's already a pane id (%N) just use it; if a window id (@N) find its
  // active pane. The client passes the active paneId, so this usually no-ops.
  if (/^%/.test(idMaybeWindow)) return idMaybeWindow;
  const panes = await listPanes(idMaybeWindow);
  const pane = panes.find((p) => p.active) || panes[0];
  return pane ? pane.id : idMaybeWindow;
}

// Parse the current AskUserQuestion state of a pane (null if not showing one).
async function readAskQuestion(paneId) {
  const screen = cleanTerminalText(await capturePane(paneId, "screen"));
  return parseAskQuestion(screen);
}

// A compact signature of the current prompt state, so we can tell when applying
// an answer has actually changed the screen (advanced to the next question /
// reached the review screen / the prompt is gone) vs. still showing the same
// prompt mid-transition. Null parse (no prompt) -> "gone".
function askQuestionSignature(parsed) {
  if (!parsed) return "gone";
  if (parsed.review) return "review";
  // question text + which tabs are answered + checkbox state — enough to detect
  // an advance to the next question or a toggle landing.
  const tabs = (parsed.tabs || []).map((t) => (t.answered ? "1" : "0")).join("");
  const checks = (parsed.options || []).map((o) => (o.checked ? "1" : "0")).join("");
  return `q:${parsed.questionText || ""}|${tabs}|${checks}`;
}

// After sending answer keystrokes the TUI takes a beat to tear down / advance the
// prompt — and over the controller->agent WebSocket each capture round-trips, so
// a single fixed delay races the redraw (the re-parse can still see the OLD
// prompt, making the overlay look stuck). Instead, poll until the prompt state
// SETTLES to something different from `before`, or a timeout. Returns the final
// parsed state (possibly null = prompt gone).
async function settleAskQuestion(paneId, beforeSig, { timeoutMs = 2500 } = {}) {
  const stepMs = ASK_KEY_DELAY_MS; // ~140ms between polls
  const deadline = Date.now() + timeoutMs;
  let parsed = await readAskQuestion(paneId);
  // Keep polling while the state still matches the pre-answer signature (i.e.
  // the redraw hasn't landed yet). As soon as it differs (next question, review,
  // or gone), we're settled.
  while (askQuestionSignature(parsed) === beforeSig && Date.now() < deadline) {
    await delay(stepMs);
    parsed = await readAskQuestion(paneId);
  }
  return parsed;
}

// Send a computed key list to the pane, one key at a time with a small delay so
// the TUI keeps up (same rationale as the paste->Enter delay). A list item that
// is { text } is sent as literal text rather than a key name.
async function sendAskKeys(paneId, keys) {
  for (const k of keys) {
    if (k && typeof k === "object" && typeof k.text === "string") {
      await sendTextToPane(paneId, k.text, { enter: false });
    } else {
      await runTmux(["send-keys", "-t", paneId, k]);
    }
    await delay(ASK_KEY_DELAY_MS);
  }
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
    "#{window_id}\t#{session_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_tty}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_mode}\t#{pane_pid}\t#{pane_title}",
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
    tty = "",
    cwd = "",
    width = "",
    height = "",
    mode = "",
    pid = "",
    ...titleParts
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
      tty,
      cwd,
      width: Number(width || 0),
      height: Number(height || 0),
      inCopyMode: isScrollbackMode(mode),
      pid: Number(pid || 0),
      title: titleParts.join("\t"),
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
  let exactClaudeSession = null;
  try {
    exactClaudeSession = await findClaudeSessionFromBackend(backend, {
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    const exactTranscript = exactClaudeSession
      ? await readClaudeTranscriptFromSession(backend, exactClaudeSession)
      : null;
    const lastAssistantTurn = exactTranscript?.turns
      ?.slice()
      .reverse()
      .find((turn) => turn.role === "assistant");
    if (lastAssistantTurn) {
      return {
        kind: "claude",
        sessionId: exactClaudeSession.sessionId,
        transcriptPath: exactClaudeSession.transcriptPath,
        text: lastAssistantTurn.text || "",
      };
    }
  } catch {}
  if (typeof backend.agentLastResponse !== "function") return null;
  try {
    // Pass cwd so Claude Code's filesystem fallback can find the right
    // transcript — its CLI doesn't keep the JSONL file open so lsof alone
    // returns nothing.
    const result = await backend.agentLastResponse({
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    if (
      exactClaudeSession &&
      result?.kind === "claude" &&
      result.sessionId !== exactClaudeSession.sessionId
    ) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

async function safeAgentTranscript(pane) {
  if (!pane?.pid) return null;
  const backend = currentBackend();
  let exactClaudeSession = null;
  try {
    exactClaudeSession = await findClaudeSessionFromBackend(backend, {
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    const exactTranscript = exactClaudeSession
      ? await readClaudeTranscriptFromSession(backend, exactClaudeSession)
      : null;
    if (exactTranscript) return exactTranscript;
  } catch {}
  const emptyExactClaudeTranscript = () =>
    exactClaudeSession
      ? {
          kind: "claude",
          sessionId: exactClaudeSession.sessionId,
          transcriptPath: exactClaudeSession.transcriptPath,
          turns: [],
          turnsTotal: 0,
        }
      : null;
  if (typeof backend.agentTranscript !== "function") return emptyExactClaudeTranscript();
  try {
    const result = await backend.agentTranscript({
      rootPid: pane.pid,
      cwd: pane.cwd || "",
    });
    if (
      exactClaudeSession &&
      result?.kind === "claude" &&
      result.sessionId !== exactClaudeSession.sessionId
    ) {
      return emptyExactClaudeTranscript();
    }
    return result;
  } catch {
    return emptyExactClaudeTranscript();
  }
}

async function detectCommandCenterAgent(pane) {
  const direct = detectCommandCenterAgentType([
    pane?.command || "",
    pane?.title || "",
  ]);
  if (direct) return direct;
  if (!pane?.pid || typeof currentBackend().processTree !== "function") return "";
  try {
    const processes = await currentBackend().processTree(pane.pid);
    const commands = processes.map((processInfo) => processInfo.command || "");
    return detectCommandCenterAgentType(commands) || "";
  } catch {
    return "";
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
 *   - a status derived from the live pane state, not transcript order. The
 *     transcript can lag or contain injected tool/user records, so "last role"
 *     is only exposed as context, never used as the live Working/Idle label.
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

      let info = await safeAgentTranscript(pane);
      if (!info?.kind) {
        const kind = await detectCommandCenterAgent(pane);
        if (!kind) return null;
        info = {
          kind,
          sessionId: "",
          transcriptPath: "",
          turns: [],
          turnsTotal: 0,
        };
      }

      const turns = Array.isArray(info.turns) ? info.turns : [];
      const lastTurn = turns[turns.length - 1] || null;
      const lastAssistantTurn = [...turns].reverse().find((t) => t.role === "assistant") || null;
      const lastUserTurn = [...turns].reverse().find((t) => t.role === "user") || null;
      let turn = null;
      let waitingForInput = false;
      let waitingConfidence = "";
      try {
        const screen = cleanTerminalText(await capturePane(pane.id, "screen"));
        const lines = screen.split("\n");
        turn = detectTurn(info.kind, {
          title: pane.title,
          paneTail: lines.slice(-12).join("\n"),
        });
        const ask = detectAskQuestion(screen);
        waitingForInput = Boolean(ask.waiting);
        waitingConfidence = ask.confidence || "";
      } catch {
        turn = null;
      }
      const turnState = turn?.state || "unverified";
      const status = waitingForInput
        ? "waiting"
        : turnState === "working"
          ? "running"
          : turnState === "idle"
            ? "idle"
            : "unverified";

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
        lastUserAt: lastUserTurn?.t || null,
        lastAssistantText: lastAssistantTurn?.text || "",
        lastAssistantAt: lastAssistantTurn?.t || null,
        lastRole: lastTurn?.role || "",
        turn: turnState,
        turnConfidence: turn?.confidence || "low",
        waitingForInput,
        waitingConfidence,
        // Prefer the agent's pre-slice total (added with the larger 32 MB tail
        // read). Old agent bundles don't send this — fall back to turns.length
        // so they still render, just pinned at the slice cap as before.
        turnCount: typeof info.turnsTotal === "number" ? info.turnsTotal : turns.length,
        status,
        // ISO timestamp of the most recent turn (when the agent transcript
        // carries one). Drives the "recent activity" sort in the Command
        // Center; null for transcripts that predate per-turn timestamps.
        lastActivityAt: lastTurn?.t || null,
      };
    }),
  );

  return { agents: rows_.filter(Boolean) };
}

let localTmuxVersion = null;
async function localCommandCenterMachine(agentCount = 0) {
  if (localTmuxVersion === null) {
    try {
      localTmuxVersion = (await runTmux(["-V"])).trim();
    } catch {
      localTmuxVersion = "";
    }
  }
  const ownerId = String(process.env.TMUX_MOBILE_USER || "");
  const hostname = os.hostname();
  return {
    id: "local",
    machineId: "local",
    hostname: machineAliasFor(hostname) || hostname,
    rawHostname: hostname,
    machineAlias: machineAliasFor(hostname),
    ownerId,
    ownerEmail: ownerId,
    ownerHd: "",
    os: process.platform,
    arch: process.arch,
    tmux: localTmuxVersion,
    agentRevision: APP_REVISION,
    connectorVersion: CONNECTOR_VERSION,
    agentCwd: __dirname,
    homeDir: os.homedir(),
    nodePath: process.execPath,
    expectedRevision: APP_REVISION,
    expectedConnectorVersion: CONNECTOR_VERSION,
    online: true,
    lastSeen: Date.now(),
    stale: false,
    missingOps: [],
    connectorStatus: "current",
    revisionStatus: "current",
    agentCount,
  };
}

function commandCenterMachineMatches(machine, machineId) {
  const id = String(machineId || "");
  if (!id) return false;
  return (
    machine.id === id ||
    machine.agentId === id ||
    machine.machineId === id ||
    machine.rawMachineId === id ||
    machine.hostname === id ||
    machine.rawHostname === id ||
    machine.machineAlias === id
  );
}

function tagCommandCenterAgents(result, machine) {
  return (result.agents || []).map((agent) => ({
    machineId: machine.id,
    machineRawId: machine.machineId || "",
    machineAgentId: machine.agentId || "",
    machineHostname: machine.hostname,
    machineOwnerId: machine.ownerId || "",
    machineOwnerHd: machine.ownerHd || "",
    ...agent,
  }));
}

function observeCommandCenterAgentsForNtfy(machines, agents) {
  if (!agentRoundNtfyNotifier.enabled) return;
  void agentRoundNtfyNotifier.observeAgents({ machines, agents });
}

function viewerForMachineOwner(machine) {
  const email = String(machine.ownerEmail || machine.ownerId || "").trim();
  const userId = String(machine.ownerId || email).trim();
  return {
    email,
    userId,
    hd: String(machine.ownerHd || "").trim(),
  };
}

async function sweepLocalAgentRoundsForNtfy() {
  const result = await listAgentSessions();
  const machine = await localCommandCenterMachine(result.agents?.length || 0);
  const agents = tagCommandCenterAgents(result, machine);
  await agentRoundNtfyNotifier.observeAgents({
    machines: [{ ...machine, agentCount: agents.length }],
    agents,
  });
}

async function sweepHubAgentRoundsForNtfy(hub) {
  const machines = typeof hub.listAllMachines === "function" ? hub.listAllMachines() : [];
  await Promise.allSettled(
    machines.map(async (machine) => {
      const viewer = viewerForMachineOwner(machine);
      if (!viewer.userId) return;
      const result = await withBackend(
        hub.backendFor(viewer, machine.id),
        () => listAgentSessions(),
      );
      const agents = tagCommandCenterAgents(result, machine);
      await agentRoundNtfyNotifier.observeAgents({
        machines: [{ ...machine, agentCount: agents.length }],
        agents,
      });
    }),
  );
}

function startAgentRoundNtfyWatcher({ hub = null } = {}) {
  if (!agentRoundNtfyNotifier.enabled) return () => {};
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      if (hub) {
        await sweepHubAgentRoundsForNtfy(hub);
      } else {
        await sweepLocalAgentRoundsForNtfy();
      }
    } catch (error) {
      logServerEvent("ntfy_agent_round_sweep_failed", {
        message: error.message || String(error),
      });
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, agentRoundNtfyNotifier.pollIntervalMs);
  timer.unref?.();
  const firstTick = setTimeout(tick, 1_000);
  firstTick.unref?.();
  logServerEvent("ntfy_agent_round_watcher_started", {
    intervalMs: agentRoundNtfyNotifier.pollIntervalMs,
    topicMinIntervalMs: agentRoundNtfyNotifier.topicMinIntervalMs,
    baseUrl: agentRoundNtfyNotifier.baseUrl,
    topicPrefix: NTFY_TOPIC_PREFIX,
  });
  return () => {
    clearInterval(timer);
    clearTimeout(firstTick);
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

function readMachineAliases(value, defaults = {}) {
  const aliases = { ...defaults };
  const raw = String(value || "").trim();
  if (!raw) return aliases;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, alias] of Object.entries(parsed)) {
          setMachineAlias(aliases, key, alias);
        }
        return aliases;
      }
    } catch {
      // Fall through to the compact comma format below.
    }
  }

  for (const item of raw.split(",")) {
    const [key, ...rest] = item.split("=");
    setMachineAlias(aliases, key, rest.join("="));
  }
  return aliases;
}

function setMachineAlias(aliases, key, alias) {
  const normalized = normalizeMachineAliasKey(key);
  const value = String(alias || "").trim();
  if (normalized && value) aliases[normalized] = value;
}

function machineAliasFor(machineId) {
  return MACHINE_ALIASES[normalizeMachineAliasKey(machineId)] || "";
}

function normalizeMachineAliasKey(value) {
  return String(value || "").trim().toLowerCase();
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
    {
      type: "session",
      userId: user.userId,
      email: user.email,
      hd: user.hd || "",
      sub: user.sub,
    },
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
  if (tokenUser) return tokenUser;
  if (process.env.TMUX_MOBILE_ENABLE_LEGACY_AUTH !== "1") return null;

  const legacySecret = process.env.AGENT_SECRET || "";
  if (legacySecret && safeEqual(req.headers["x-agent-secret"], legacySecret)) {
    const userId = String(process.env.TMUX_MOBILE_USER || "default");
    return { userId, email: userId, hd: "" };
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
    allowAll: process.env.ALLOW_ALL_GOOGLE_USERS !== "0",
    emails: new Set(splitCsv(process.env.ALLOWED_GOOGLE_EMAILS)),
    domains: new Set(splitCsv(process.env.ALLOWED_GOOGLE_DOMAINS)),
  };
}

function assertGoogleUserAllowed(user) {
  const allowed = readAllowedGoogleConfig();
  if (allowed.allowAll) return;
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
  const user = {
    userId: email,
    email,
    hd: String(data.hd || "").trim().toLowerCase(),
    sub: String(data.sub || ""),
  };
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
    sendJson(res, 200, { email: user.email, userId: user.userId, hd: user.hd || "" });
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
        {
          type: "agent",
          userId: user.userId,
          email: user.email,
          hd: user.hd || "",
          sub: user.sub,
        },
        AGENT_TOKEN_TTL_SECONDS,
      ),
      user: { email: user.email, userId: user.userId, hd: user.hd || "" },
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

const agentRoundNtfyNotifier = createAgentRoundNtfyNotifier({
  ...createNtfyConfig(process.env),
  appBaseUrl:
    process.env.NTFY_APP_BASE_URL ||
    process.env.TMUX_MOBILE_PUBLIC_URL ||
    DEFAULT_CONTROLLER_URL,
}, {
  logEvent: logServerEvent,
});

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
    sendJson(res, 200, {
      ok: true,
      revision: APP_REVISION,
      connectorVersion: CONNECTOR_VERSION,
    });
    return;
  }

  // Local-mode attention sweep (single machine). In hub mode this is handled
  // earlier across all machines; here it returns one "local" machine entry so the
  // client uses the same code path in both modes.
  if (req.method === "GET" && url.pathname === "/api/attention") {
    const windows = await collectMachineAttention();
    sendJson(res, 200, { machines: [{ machineId: "local", hostname: "local", windows }] });
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

  // Cold-load batch (sessions + all windows in one agent round-trip). See
  // listTree() for why this exists.
  if (req.method === "GET" && url.pathname === "/api/tree") {
    try {
      sendJson(res, 200, await listTree());
    } catch (error) {
      if (isNoServerError(error)) {
        sendJson(res, 200, { sessions: [], windows: [] });
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

  if (req.method === "POST" && url.pathname === "/api/agent-sessions") {
    const body = await readJsonBody(req);
    const requestedMachineId =
      req.headers["x-machine-id"] || url.searchParams.get("machineId") || "";
    logServerEvent("start_agent_session_requested", {
      machineId: requestedMachineId,
      kind: String(body.kind || ""),
      cwd: String(body.cwd || ""),
      sessionName: String(body.sessionName || ""),
    });
    const result = await startAgentSession({
      kind: body.kind,
      cwd: body.cwd,
      sessionName: body.sessionName,
    });
    logServerEvent("start_agent_session_started", {
      machineId: requestedMachineId,
      kind: result.kind,
      cwd: result.cwd,
      sessionName: result.session?.name || "",
      sessionId: result.session?.id || "",
      windowId: result.windowId || "",
      paneId: result.paneId || "",
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/connector-update") {
    const body = await readJsonBody(req);
    sendJson(
      res,
      200,
      await startConnectorUpdate({
        repoDir: body.repoDir,
        controllerUrl: body.controllerUrl || requestOrigin(req),
        cloneUrl: body.cloneUrl || CONNECTOR_CLONE_URL,
        expectedRevision: body.expectedRevision || APP_REVISION,
        targetRef: body.targetRef || "main",
        nodePath: body.nodePath || "node",
        agentMachine: body.agentMachine,
        machineLabel: body.machineLabel,
      }),
    );
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

  // Per-window metadata (agentType, repo, git branch/worktree). Replaces the
  // old window-branches endpoint, which is kept as an alias for compatibility.
  if (
    req.method === "GET" &&
    (url.pathname === "/api/window-metadata" || url.pathname === "/api/window-branches")
  ) {
    const sessionId = requireId(url.searchParams.get("sessionId"), "session");
    sendJson(res, 200, await getSessionWindowMetadata(sessionId));
    return;
  }

  // On-demand: parse the active pane's current AskUserQuestion (if any). The
  // user triggers this by tapping "Answer question" — no continuous scanning.
  if (req.method === "GET" && url.pathname === "/api/ask-question") {
    const paneId = await resolveActivePane(requireId(url.searchParams.get("paneId"), "pane"));
    const parsed = await readAskQuestion(paneId);
    sendJson(res, 200, { paneId, active: Boolean(parsed), question: parsed });
    return;
  }

  // Apply an AskUserQuestion answer by driving the TUI with keystrokes. Body:
  //   { paneId, action: "single", optionIndex }
  //   { paneId, action: "multi", checked: number[] }
  //   { paneId, action: "free", text }
  //   { paneId, action: "reviewSubmit" }
  //   { paneId, action: "cancel" }
  // Re-parses the pane first so the keys are computed against the live cursor
  // state, then returns the new parsed state so the overlay can continue
  // (next question / review / done).
  if (req.method === "POST" && url.pathname === "/api/ask-answer") {
    const body = await readJsonBody(req);
    const paneId = await resolveActivePane(requireId(body.paneId, "pane"));
    const parsed = await readAskQuestion(paneId);
    if (!parsed) {
      sendJson(res, 409, { error: "No active question in this pane" });
      return;
    }
    let keys = [];
    switch (body.action) {
      case "single":
        keys = singleSelectKeys(parsed, Number(body.optionIndex));
        break;
      case "multi":
        keys = multiSelectKeys(parsed, new Set((body.checked || []).map(Number)));
        break;
      case "free":
        keys = freeFormKeys(String(body.text || ""));
        break;
      case "reviewSubmit":
        keys = reviewSubmitKeys(parsed);
        break;
      case "cancel":
        keys = cancelKeys();
        break;
      default:
        sendJson(res, 400, { error: `Unknown action: ${body.action}` });
        return;
    }
    const beforeSig = askQuestionSignature(parsed);
    await sendAskKeys(paneId, keys);
    // Poll until the prompt actually changes (advances / review / gone) rather
    // than guessing a fixed delay — robust to a slow redraw and to the extra
    // round-trip latency in controller mode. cancel/free decline the prompt, so
    // their expected end state is "gone".
    const next = await settleAskQuestion(paneId, beforeSig);
    sendJson(res, 200, { paneId, active: Boolean(next), question: next });
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

  if (req.method === "POST" && url.pathname === "/api/fork-agent-window") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    sendJson(res, 200, await forkAgentWindow(paneId));
    return;
  }

  // "New branch": create a worktree+branch off the window's cwd and open a new
  // window in it (command prefilled like Duplicate). Only meaningful when the
  // source window is a bare-repo-backed worktree; the client gates the action.
  if (req.method === "POST" && url.pathname === "/api/window-new-branch") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    sendJson(
      res,
      200,
      await newBranchWindow(windowId, {
        branch: body.branch,
        command: body.command,
        name: body.name,
      }),
    );
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
    const result = await listAgentSessions();
    const localMachine = await localCommandCenterMachine(result.agents?.length || 0);
    const agents = (result.agents || []).map((agent) => ({
      machineId: localMachine.id,
      machineRawId: localMachine.machineId,
      machineHostname: localMachine.hostname,
      machineOwnerId: localMachine.ownerId || "",
      machineOwnerHd: localMachine.ownerHd || "",
      ...agent,
    }));
    observeCommandCenterAgentsForNtfy([localMachine], agents);
    sendJson(res, 200, { machines: [localMachine], agents });
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
    const explicitPath = url.searchParams.get("path");
    if (explicitPath !== null) {
      sendJson(res, 200, await directoriesForCwd(requireDirectoryPath(explicitPath)));
    } else {
      const paneId = requireId(url.searchParams.get("paneId"), "pane");
      sendJson(res, 200, await listPaneDirectories(paneId));
    }
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

  // Switch-window batch (panes + active capture + cwd directories in one
  // request, two parallel agent round-trips total). See getWindowView() above.
  if (req.method === "GET" && url.pathname === "/api/window-view") {
    const windowId = requireId(url.searchParams.get("windowId"), "window");
    const lines = parseLines(url.searchParams.get("lines"));
    sendJson(res, 200, await getWindowView(windowId, lines));
    return;
  }

  // Smart content viewer: read a file referenced in a pane, resolving a relative
  // path against the pane's cwd (absolute/~ paths resolve as given). The only
  // boundary is the OS file permissions of the user the agent runs as — a file
  // that user can read is served; one they can't yields EACCES.
  if (req.method === "GET" && url.pathname === "/api/file") {
    const f = await readFileForServing(req, res, url);
    if (!f) return; // error already sent
    sendJson(res, 200, {
      path: f.requestedPath,
      name: f.name,
      kind: f.kind,
      contentType: f.contentType,
      base64: f.result.base64,
      size: f.result.size,
      truncated: f.result.truncated,
    });
    return;
  }

  // Raw file streaming with a SENSIBLE filename. Used so artifacts open in a new
  // tab as a real URL (not an opaque blob:) and downloads save under the actual
  // file name via Content-Disposition. Routed by machineId (header OR ?machineId)
  // and cookie-authed like every /api route, so a plain tab navigation works.
  // `?dl=1` forces a download (attachment); otherwise the browser shows it inline.
  if (req.method === "GET" && url.pathname === "/api/file-raw") {
    const f = await readFileForServing(req, res, url);
    if (!f) return;
    const bytes = Buffer.from(f.result.base64, "base64");
    const download = url.searchParams.get("dl") === "1";
    res.writeHead(200, {
      "content-type": f.contentType,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${sanitizeFilename(f.name)}"`,
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    });
    res.end(bytes);
    return;
  }

  // Markdown rendered to a standalone HTML page for opening in a new tab — keeps
  // the formatted view (headings, lists, tables) with a real document <title> so
  // the tab and any "Save as" use the file's name, not a blob GUID.
  if (req.method === "GET" && url.pathname === "/api/file-view") {
    const f = await readFileForServing(req, res, url);
    if (!f) return;
    if (f.kind !== "markdown") {
      // Non-markdown has nothing to render; just stream it inline.
      const bytes = Buffer.from(f.result.base64, "base64");
      res.writeHead(200, {
        "content-type": f.contentType,
        "content-disposition": `inline; filename="${sanitizeFilename(f.name)}"`,
        "content-length": String(bytes.length),
        "cache-control": "no-store",
      });
      res.end(bytes);
      return;
    }
    const md = Buffer.from(f.result.base64, "base64").toString("utf8");
    const page = renderMarkdownPage(f.name, md, f.result.truncated);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(page);
    return;
  }

  // Upload a file to a temp directory on the target machine; the client inserts
  // the returned path into the composer. Body is the raw file bytes; the filename
  // is the `name` query param. Routes through the backend seam, so a controller
  // brokers it to the registered agent (file rides as base64 in the frame).
  if (req.method === "POST" && url.pathname === "/api/upload") {
    requireId(url.searchParams.get("paneId"), "pane");
    const backend = currentBackend();
    if (typeof backend.supportsOp === "function" && !backend.supportsOp(OP.WRITEFILE)) {
      sendJson(res, 501, {
        error:
          "This machine's connector is out of date — restart it (node server.mjs --register …) to upload files.",
      });
      return;
    }
    const bytes = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
    if (bytes.length === 0) {
      sendJson(res, 400, { error: "No file received" });
      return;
    }
    const name = url.searchParams.get("name") || "upload";
    let result;
    try {
      result = await backend.writeTempFile(name, bytes.toString("base64"));
    } catch (error) {
      if (/unknown op/i.test(error.message) || error instanceof TypeError) {
        sendJson(res, 501, {
          error: "This machine's connector is out of date — restart it to upload files.",
        });
        return;
      }
      sendJson(res, 500, { error: error.message || "Could not save the file" });
      return;
    }
    sendJson(res, 200, { path: result.path, name: result.name });
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

    // If the pane is parked in copy-mode, our input would be swallowed by the
    // scrollback pager — exit it first so the paste/Enter reaches the program.
    await exitCopyModeIfNeeded(paneId);

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
    // Optional prefix prepended to the transcript before sending — e.g. "/btw "
    // so a voice note becomes a Claude `/btw` side-note slash-command. Validated
    // to a short, safe set of chars so it can't inject arbitrary control input.
    const rawPrefix = url.searchParams.get("prefix") || "";
    const prefix = sanitizeVoicePrefix(rawPrefix);
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
      const transcript = await transcribeAudio(audio, contentType);
      if (!transcript) {
        const error = new Error("No speech recognized");
        error.status = 422;
        throw error;
      }
      const text = prefix ? `${prefix}${transcript}` : transcript;
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        const error = new Error("Transcribed text is too large");
        error.status = 413;
        throw error;
      }
      // Paste + Enter together so the paste->Enter delay applies and the Enter
      // reliably submits (rather than being consumed by the bracketed paste).
      const sendResult = await sendTextToPane(paneId, text, { enter: sendEnter });
      if (sendEnter && submitNudge) {
        sendSubmitNudge(paneId);
      }
      return {
        ok: true,
        text, // the full sent text (prefix + transcript)
        transcript, // the raw transcript without the prefix
        prefix,
        model: getVoiceConfig().transcribeModel,
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
    // Exit copy-mode first so the key reaches the program, not the pager. (One
    // exception: if the user is deliberately sending a navigation key to drive
    // copy-mode, this would fight them — but the allowed keys here are
    // submit/edit keys for the app's input, not copy-mode navigation.)
    await exitCopyModeIfNeeded(paneId);
    await runTmux(["send-keys", "-t", paneId, key]);
    sendJson(res, 200, { ok: true });
    return;
  }

  // Set a Claude agent's effort level by driving its in-TUI `/effort` slider:
  // open the slider, step Left/Right from the current level to the target, then
  // Enter to confirm. The slider levels + command live in the per-agent table;
  // "current" is read live from the pane footer so we step the right distance
  // even if the user moved it by hand. This reuses the same sequenced-key
  // primitive as the AskUserQuestion answer flow (sendAskKeys + a settle poll).
  if (req.method === "POST" && url.pathname === "/api/agent-effort") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const agentType = String(body.agentType || "");
    const target = String(body.level || "").toLowerCase();
    const spec = AGENT_MODES[agentType]?.effort;
    if (!spec) {
      sendJson(res, 400, { error: `No effort control for agent "${agentType}"` });
      return;
    }
    const targetIdx = spec.levels.indexOf(target);
    if (targetIdx === -1) {
      sendJson(res, 400, { error: `Unknown effort level "${target}"` });
      return;
    }
    await exitCopyModeIfNeeded(paneId);
    // Open the slider, then drive it DETERMINISTICALLY without parsing the
    // current level (the footer's effort marker is unreliable across levels and
    // widths — e.g. max/ultracode render differently and may not show "/effort").
    // The slider clamps at its ends, so: press Left N times to guarantee we're at
    // the far-left (index 0 = lowest), then Right `targetIdx` times to land on the
    // target. N = levels.length is always enough to reach the left edge.
    await sendTextToPane(paneId, spec.command, { enter: true });
    await delay(ASK_KEY_DELAY_MS * 3); // let the slider render before stepping
    const keys = [];
    for (let i = 0; i < spec.levels.length; i++) keys.push("Left"); // clamp to low
    for (let i = 0; i < targetIdx; i++) keys.push("Right"); // step up to target
    keys.push("Enter");
    await sendAskKeys(paneId, keys);
    sendJson(res, 200, { ok: true, to: target });
    return;
  }

  // Set an agent's permission mode by cycling Shift+Tab until the pane's parsed
  // mode matches the target. We do NOT assume a fixed ring order/membership (it
  // varies with launch flags) — we step one cycle, re-read the REAL mode, and
  // stop when it matches or we've made a full loop without finding it.
  if (req.method === "POST" && url.pathname === "/api/agent-mode") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const agentType = String(body.agentType || "");
    const target = String(body.mode || "");
    const cfg = AGENT_MODES[agentType];
    if (!cfg) {
      sendJson(res, 400, { error: `No mode control for agent "${agentType}"` });
      return;
    }
    await exitCopyModeIfNeeded(paneId);
    const readMode = async () => {
      const clean = cleanTerminalText(await capturePane(paneId, "screen"));
      return detectAgentMode(agentType, {
        paneTail: clean.split("\n").slice(-12).join("\n"),
      }).mode;
    };
    let current = await readMode();
    // A whole ring is at most ~6 modes; cap steps generously to avoid spinning.
    const maxSteps = 8;
    let steps = 0;
    while (current !== target && steps < maxSteps) {
      await runTmux(["send-keys", "-t", paneId, cfg.cycleKey]);
      await delay(ASK_KEY_DELAY_MS * 2); // let the footer redraw before re-reading
      current = await readMode();
      steps++;
    }
    sendJson(res, 200, {
      ok: current === target,
      mode: current,
      steps,
      reached: current === target,
    });
    return;
  }

  // Explicitly drop a pane out of tmux copy-mode (the "Exit scroll mode" banner
  // button). Idempotent: a no-op if it isn't in copy-mode.
  if (req.method === "POST" && url.pathname === "/api/exit-copy-mode") {
    const body = await readJsonBody(req);
    const paneId = requireId(body.paneId, "pane");
    const exited = await exitCopyModeIfNeeded(paneId);
    sendJson(res, 200, { ok: true, exited });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  // .mjs needs an explicit JS MIME — browsers refuse to execute `<script
  // type="module">` over application/octet-stream. The SPA router lives at
  // public/spa-router.mjs.
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".wav", "audio/wav"], // bundled notification chime (public/sounds/notify.wav)
]);

async function serveStatic(req, res, url) {
  let pathname = url.pathname;
  // SPA shell. All four user-facing routes ("/", "/command-center", "/app",
  // and their trailing-slash variants) serve the same spa.html host page;
  // its router (public/spa-router.mjs) decides which view to mount based on
  // pathname and keeps both views alive in one document after the first
  // visit, so flipping between them no longer tears down the JS heap.
  //
  // index.html and command-center.html are still reachable as static files
  // because the router fetches them on first nav to extract each view's
  // body markup. They're never sent as a top-level response anymore.
  if (
    pathname === "/" ||
    pathname === "/command-center" ||
    pathname === "/command-center/" ||
    pathname === "/app" ||
    pathname === "/app/"
  ) {
    pathname = "/spa.html";
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
    // Every served .html file goes through __APP_TITLE__ substitution: this
    // used to be index.html-only, which made command-center.html ship with
    // a literal "Command Center · __APP_TITLE__" in its title bar. spa.html
    // (the new SPA shell) also uses the placeholder; widening this keeps
    // them in sync.
    const isHtml = path.extname(filePath) === ".html";
    const body = isHtml
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

// Three modes:
//   default       — local single-machine server (today's everyday usage)
//   --register U  — agent that dials out to a controller over WebSocket
//   --controller  — the public hub (Fargate / Cloud Run) with Google OAuth
// The legacy `--hub` (no-auth public broker) is gone; the controller path
// covers every public-broker use case with proper auth.
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
  if (args.includes("--hub")) {
    console.error(
      "--hub mode has been removed; use --controller (Google OAuth) for the public broker.",
    );
    process.exit(2);
  }
  return { kind: "local" };
}

const MODE = parseMode(process.argv.slice(2));
const HOST = process.env.HOST || (MODE.kind === "controller" ? "0.0.0.0" : "127.0.0.1");
// IS_HUB_MODE is now just "is this the public broker", which only the
// controller is. Kept under the old name so the many call sites don't churn.
const IS_HUB_MODE = MODE.kind === "controller";
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
  if (
    process.env.ALLOW_ALL_GOOGLE_USERS === "0" &&
    !process.env.ALLOWED_GOOGLE_EMAILS &&
    !process.env.ALLOWED_GOOGLE_DOMAINS
  ) {
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
  let stopAgentRoundWatcher = () => {};

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
      const viewer = REQUIRE_BROWSER_AUTH
        ? authenticatedUser
        : { userId, email: userId, hd: "" };

      if (req.method === "GET" && url.pathname === "/api/runtime") {
        sendJson(res, 200, {
          // Frontend still uses the legacy 'hub' literal to mean "I'm
          // talking to the public broker (vs my own local tmux server)";
          // preserved here so the UI doesn't need to learn 'controller'.
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
            sendJson(res, 200, hub.listMachines(viewer));
            return;
          }
          // Cross-machine attention sweep: per-window turn/waitingForInput/
          // contentHash for every online machine this user can access, so the
          // client's "needs you" pill/title/favicon span the full visible set.
          // One request per poll regardless of machine count. The client applies
          // its own (local) unread comparison against contentHash.
          if (req.method === "GET" && url.pathname === "/api/attention") {
            const online = hub.listMachines(viewer);
            const machines = await Promise.all(
              online.map(async (machine) => {
                let windows = [];
                try {
                  windows = await withBackend(
                    hub.backendFor(viewer, machine.id),
                    () => collectMachineAttention(),
                  );
                } catch {
                  windows = []; // machine hiccup — skip it this tick
                }
                return { machineId: machine.id, hostname: machine.hostname, windows };
              }),
            );
            sendJson(res, 200, { machines });
            return;
          }
          if (url.pathname === "/api/health") {
            sendJson(res, 200, {
              ok: true,
              revision: APP_REVISION,
              connectorVersion: CONNECTOR_VERSION,
            });
            return;
          }
          // Command Center spans every online machine this user can access.
          // Tag each agent with its machine and ownerId for UI labels.
          // Per-machine failures get swallowed so one hiccupping agent doesn't
          // poison the whole feed.
          if (req.method === "GET" && url.pathname === "/api/command-center") {
            const online = hub.listMachines(viewer);
            const requestedMachineId =
              req.headers["x-machine-id"] || url.searchParams.get("machineId");
            if (requestedMachineId) {
              const machine = online.find((item) =>
                commandCenterMachineMatches(item, requestedMachineId),
              );
              if (!machine || !hub.hasMachine(viewer, requestedMachineId)) {
                sendJson(res, 503, { error: `Machine ${requestedMachineId} is offline` });
                return;
              }
              const result = await withBackend(
                hub.backendFor(viewer, requestedMachineId),
                () => listAgentSessions(),
              );
              const agents = tagCommandCenterAgents(result, machine);
              const machines = [{ ...machine, agentCount: agents.length }];
              observeCommandCenterAgentsForNtfy(machines, agents);
              sendJson(res, 200, {
                machines,
                agents,
              });
              return;
            }
            const agentCounts = new Map(online.map((machine) => [machine.id, 0]));
            const all = [];
            await Promise.all(
              online.map(async (machine) => {
                try {
                  const result = await withBackend(
                    hub.backendFor(viewer, machine.id),
                    () => listAgentSessions(),
                  );
                  const agents = tagCommandCenterAgents(result, machine);
                  for (const a of agents) {
                    agentCounts.set(machine.id, (agentCounts.get(machine.id) || 0) + 1);
                    all.push(a);
                  }
                } catch {
                  // per-machine failure — keep the machine row, just omit agents
                }
              }),
            );
            const machines = online.map((machine) => ({
              ...machine,
              agentCount: agentCounts.get(machine.id) || 0,
            }));
            observeCommandCenterAgentsForNtfy(machines, all);
            sendJson(res, 200, { machines, agents: all });
            return;
          }
          const machineId =
            req.headers["x-machine-id"] ||
            url.searchParams.get("machineId") ||
            hub.soleMachineId(viewer);
          if (!machineId) {
            sendJson(res, 400, {
              error: "machineId is required (multiple machines online)",
            });
            return;
          }
          if (!hub.hasMachine(viewer, machineId)) {
            sendJson(res, 503, { error: `Machine ${machineId} is offline` });
            return;
          }
          await withBackend(hub.backendFor(viewer, machineId), () =>
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
      superAdminEmails: splitCsv(process.env.SUPER_ADMIN_EMAILS),
      currentRevision: APP_REVISION,
      requiredConnectorVersion: CONNECTOR_VERSION,
      machineAliases: MACHINE_ALIASES,
    });
  }
  stopAgentRoundWatcher = startAgentRoundNtfyWatcher({ hub });

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
    stopAgentRoundWatcher();
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
