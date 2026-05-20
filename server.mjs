import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadLocalEnv(path.join(__dirname, ".env"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3737);
const MAX_BODY_BYTES = 512 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 8192;
const MAX_CAPTURE_LINES = 5000;
const TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5.4-mini";
const WINDOW_BRIEFING_MODEL =
  process.env.OPENAI_WINDOW_BRIEFING_MODEL || "gpt-5.4-mini";
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
const WINDOW_BRIEFING_LINES = 100;
const REALTIME_WINDOW_BRIEFING_CHUNK_LINES = parsePositiveInteger(
  process.env.OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_LINES,
  12,
);
const REALTIME_WINDOW_BRIEFING_CHUNK_CHARS = parsePositiveInteger(
  process.env.OPENAI_REALTIME_WINDOW_BRIEFING_CHUNK_CHARS,
  1200,
);
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const WINDOW_BRIEFING_INSTRUCTIONS =
  "You are turning the last visible terminal output into something useful to listen to. The input is the last lines captured from the active pane of a tmux window where a coding agent, shell, editor, or test/build process may be running. Your job is to summarize and restate the actual content in those lines, not to describe the fact that an agent is speaking, explaining, coding, or summarizing. If the output contains an explanation, explain the substance of that explanation. If it contains a plan, report the plan. If it contains code-review findings, report the findings. If it contains command output, report the meaningful results, errors, files, commands, and blockers. Avoid meta phrases such as \"the agent is explaining\", \"the output discusses\", \"it mentions\", or \"the terminal shows\" unless there is no substantive content to report. Ignore ANSI escape sequences, control characters, redraw artifacts, repeated progress-only lines, prompts with no meaningful state, and other terminal noise. Be faithful to the visible output and do not invent missing context. Write a natural spoken summary of 3-7 sentences, no Markdown, no bullets, no code fences. Use Chinese if the terminal output or user task is primarily Chinese; otherwise use English.";
const REALTIME_WINDOW_BRIEFING_INSTRUCTIONS =
  "You are reading the last visible terminal output aloud for a user who does not want to inspect the terminal manually. The input is a chunk from the last lines captured from the active pane of a tmux window where a coding agent, shell, editor, or test/build process may be running. Restate the actual substance of this chunk completely enough that the user can understand what happened without looking. Do not merely say that an agent is explaining, coding, summarizing, or discussing something. If the output contains an explanation, explain the substance of that explanation. If it contains a plan, report the plan. If it contains code-review findings, report the findings. If it contains command output, report the meaningful results, errors, files, commands, and blockers. Ignore ANSI escape sequences, control characters, redraw artifacts, repeated progress-only lines, prompts with no meaningful state, and other terminal noise. Be faithful to the visible output and do not invent missing context. Speak in a natural way and cover all meaningful content in the chunk. If the input includes chunk metadata, do not announce the chunk number; just continue naturally. Use Chinese if the terminal output or user task is primarily Chinese; otherwise use English.";
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
  "Backspace",
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

function cleanTerminalText(text) {
  return String(text || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
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

async function currentPaneProcess(paneId) {
  requireId(paneId, "pane");
  const stdout = await runTmux([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{pane_current_command}\t#{pane_pid}",
  ]);
  const [command = "", pid = ""] = stdout.trim().split("\t");
  return { command, pid: Number(pid) };
}

async function processArgs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  return (await runFile("ps", ["-p", String(pid), "-o", "args="])).trim();
}

async function childProcessNames(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  return await runFile("pgrep", ["-P", String(pid), "-l"]).catch(() => "");
}

function isCodexNodeArgs(args) {
  return (
    /(?:^|\s)node\s+(?:\S*\/)?codex(?:\s|$)/.test(args) ||
    /@openai\/codex|\/codex\.js(?:\s|$)/.test(args)
  );
}

async function isCodexPane(paneId) {
  const { command, pid } = await currentPaneProcess(paneId);
  if (command === "codex") return true;
  if (command !== "node") return false;

  const args = await processArgs(pid).catch(() => "");
  if (isCodexNodeArgs(args)) return true;

  const children = await childProcessNames(pid);
  return /^\d+\s+codex$/m.test(children);
}

function bracketedPastePayload(text) {
  return `${BRACKETED_PASTE_START}${text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[(?:200|201)~/g, "")}${BRACKETED_PASTE_END}`;
}

async function sendTextToPane(paneId, text, { enter = false } = {}) {
  if (enter) {
    await runTmux(["send-keys", "-t", paneId, text, "Enter"]);
    return { mode: "keys-with-enter", sentEnter: true };
  }

  if (await isCodexPane(paneId).catch(() => false)) {
    await runTmux(["send-keys", "-t", paneId, "-l", bracketedPastePayload(text)]);
    return { mode: "bracketed-paste", sentEnter: false };
  }

  await runTmux(["send-keys", "-t", paneId, "-l", text]);
  return { mode: "literal", sentEnter: false };
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
    sessionId,
    sessionName,
    windowIndex: Number(windowIndex),
    windowName,
  };
}

async function buildWindowBriefingInput(windowId, lineCount) {
  requireId(windowId, "window");
  const lines = Math.min(parseLines(lineCount || WINDOW_BRIEFING_LINES), 100);
  const [windowInfo, panes] = await Promise.all([
    getWindowInfo(windowId),
    listPanes(windowId),
  ]);
  const pane = panes.find((item) => item.active) || panes[0];
  const text = pane ? await capturePane(pane.id, "tail", lines) : "";
  const cleanedOutput = cleanTerminalText(text);
  const sample = {
    ...windowInfo,
    paneIndex: pane?.index ?? null,
    command: pane?.command || "",
    cwd: pane?.cwd || "",
    capturedLines: lines,
    output: textExcerpt(cleanedOutput, 10000),
  };
  const chunkOutputs = splitRealtimeBriefingOutput(cleanedOutput);
  const totalChunks = Math.max(1, chunkOutputs.length);
  const inputChunks =
    chunkOutputs.length > 0
      ? chunkOutputs.map((output, index) =>
          JSON.stringify({
            source: "tmux active pane tail for a coding-agent workflow",
            lines,
            part: {
              index: index + 1,
              total: totalChunks,
            },
            window: {
              ...sample,
              output,
            },
          }),
        )
      : [
          JSON.stringify({
            source: "tmux active pane tail for a coding-agent workflow",
            lines,
            part: {
              index: 1,
              total: 1,
            },
            window: sample,
          }),
        ];

  return {
    lines,
    input: JSON.stringify({
      source: "tmux active pane tail for a coding-agent workflow",
      lines,
      window: sample,
    }),
    inputChunks,
  };
}

async function summarizeWindowForSpeech(windowId, lineCount) {
  const briefing = await buildWindowBriefingInput(windowId, lineCount);

  const summary = await createTextModelResponse({
    instructions: WINDOW_BRIEFING_INSTRUCTIONS,
    input: briefing.input,
    maxOutputTokens: 520,
    model: WINDOW_BRIEFING_MODEL,
  });

  return limitWords(summary, 320);
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

async function createRealtimeCall(sdp) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set");
    error.status = 500;
    throw error;
  }

  const sdpOffer = String(sdp || "");
  if (!sdpOffer.trimStart().startsWith("v=0")) {
    const error = new Error("Invalid WebRTC SDP offer");
    error.status = 400;
    throw error;
  }

  const form = new FormData();
  form.set("sdp", sdpOffer);
  form.set(
    "session",
    JSON.stringify({
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
    }),
  );

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  const answerSdp = await response.text();
  if (!response.ok) {
    const error = new Error(textExcerpt(answerSdp || response.statusText, 1200));
    error.status = 502;
    throw error;
  }

  return {
    sdp: answerSdp,
    callLocation: response.headers.get("location") || "",
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
        ? await sendTextToPane(paneId, text, { enter: sendEnter })
        : { mode: "none", sentEnter: false };
    if (sendEnter && !sendResult.sentEnter) {
      await runTmux(["send-keys", "-t", paneId, "Enter"]);
      if (submitNudge && text.length > 0) {
        sendSubmitNudge(paneId);
      }
    } else if (sendEnter && submitNudge && text.length > 0) {
      sendSubmitNudge(paneId);
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

  if (req.method === "POST" && url.pathname === "/api/window-audio-summary") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    const lines = Math.min(parseLines(body.lines || WINDOW_BRIEFING_LINES), 100);
    const startedAt = Date.now();
    logServerEvent("window_audio_summary_started", {
      windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel: SPEECH_MODEL,
      voice: SPEECH_VOICE,
    });
    const summary = await summarizeWindowForSpeech(windowId, lines);
    logServerEvent("window_audio_summary_summarized", {
      windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      summaryChars: summary.length,
      elapsedMs: Date.now() - startedAt,
    });
    const audioBase64 = await createSpeechAudio(summary);
    logServerEvent("window_audio_summary_completed", {
      windowId,
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel: SPEECH_MODEL,
      audioBase64Chars: audioBase64.length,
      elapsedMs: Date.now() - startedAt,
    });
    sendJson(res, 200, {
      summary,
      audioBase64,
      mimeType: "audio/mpeg",
      lines,
      summaryModel: WINDOW_BRIEFING_MODEL,
      speechModel: SPEECH_MODEL,
      voice: SPEECH_VOICE,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/window-realtime-session") {
    const body = await readJsonBody(req);
    const windowId = requireId(body.windowId, "window");
    const lines = Math.min(parseLines(body.lines || WINDOW_BRIEFING_LINES), 100);
    const sdp = String(body.sdp || "");
    const startedAt = Date.now();
    logServerEvent("window_realtime_session_started", {
      windowId,
      lines,
      realtimeModel: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      sdpChars: sdp.length,
    });
    const briefing = await buildWindowBriefingInput(windowId, lines);
    const call = await createRealtimeCall(sdp);
    logServerEvent("window_realtime_session_ready", {
      windowId,
      lines: briefing.lines,
      realtimeModel: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      inputChars: briefing.input.length,
      chunkCount: briefing.inputChunks.length,
      chunkLines: REALTIME_WINDOW_BRIEFING_CHUNK_LINES,
      chunkChars: REALTIME_WINDOW_BRIEFING_CHUNK_CHARS,
      callLocation: call.callLocation,
      elapsedMs: Date.now() - startedAt,
    });
    sendJson(res, 200, {
      sdp: call.sdp,
      input: briefing.input,
      inputChunks: briefing.inputChunks,
      chunkCount: briefing.inputChunks.length,
      lines: briefing.lines,
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
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
]);

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const relative = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, relative.replace(/^\/+/, ""));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
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
