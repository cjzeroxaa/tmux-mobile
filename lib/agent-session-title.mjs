const AGENT_SESSION_TITLE_MAX_CHARS = 160;
const TITLE_FILE_CACHE_TTL_MS = 8_000;
const TITLE_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const CLAUDE_TRANSCRIPT_METADATA_MAX_BYTES = 1024 * 1024;

const backendFileCaches = new WeakMap();

export function normalizeAgentSessionTitle(value) {
  const title = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return "";
  return title.slice(0, AGENT_SESSION_TITLE_MAX_CHARS);
}

export function parseCodexSessionTitles(jsonlText) {
  const titles = new Map();
  for (const line of String(jsonlText || "").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const sessionId = String(record?.id || "").trim();
    const title = normalizeAgentSessionTitle(record?.thread_name);
    // session_index.jsonl is append-only. Later rows are authoritative, while
    // an empty rename should not erase the last useful title we observed.
    if (sessionId && title) titles.set(sessionId, title);
  }
  return titles;
}

export function parseClaudeTranscriptTitle(jsonlText) {
  let customTitle = "";
  let slug = "";
  for (const line of String(jsonlText || "").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const explicit = normalizeAgentSessionTitle(
      record?.customTitle ||
        (record?.type === "custom-title"
          ? record?.title || record?.name || record?.value
          : ""),
    );
    if (explicit) customTitle = explicit;
    const candidateSlug = normalizeAgentSessionTitle(record?.slug);
    if (candidateSlug) slug = candidateSlug;
  }
  return customTitle
    ? { title: customTitle, source: "claude-custom-title" }
    : slug
      ? { title: slug, source: "claude-slug" }
      : null;
}

export function parseClaudeSessionsIndexTitle(jsonText, sessionId) {
  let document;
  try {
    document = JSON.parse(String(jsonText || ""));
  } catch {
    return "";
  }
  const entry = Array.isArray(document?.entries)
    ? document.entries.find((candidate) => String(candidate?.sessionId || "") === String(sessionId || ""))
    : null;
  return normalizeAgentSessionTitle(entry?.summary);
}

function fileCacheForBackend(backend) {
  let cache = backendFileCaches.get(backend);
  if (!cache) {
    cache = new Map();
    backendFileCaches.set(backend, cache);
  }
  return cache;
}

async function readCachedBackendText(backend, filePath, maxBytes) {
  if (!backend || typeof backend.readfile !== "function") return "";
  const cache = fileCacheForBackend(backend);
  const key = `${filePath}\0${maxBytes}`;
  const previous = cache.get(key);
  if (previous && Date.now() - previous.checkedAt < TITLE_FILE_CACHE_TTL_MS) {
    return previous.load;
  }
  const load = backend
    .readfile(filePath, { maxBytes })
    .then((result) => Buffer.from(result?.base64 || "", "base64").toString("utf8"))
    .catch(() => "");
  cache.set(key, { checkedAt: Date.now(), load });
  return load;
}

function claudeProjectIndexPath(cwd) {
  const directory = String(cwd || "").replace(/\//g, "-");
  return directory ? `~/.claude/projects/${directory}/sessions-index.json` : "";
}

/**
 * Resolve the user-facing name owned by the agent runtime. This deliberately
 * remains separate from tmux session/window names: those are routing labels,
 * while this is optional conversational metadata.
 */
export async function resolveAgentSessionTitle(backend, session = {}) {
  const embeddedTitle = normalizeAgentSessionTitle(session.agentSessionTitle);
  if (embeddedTitle) {
    return {
      title: embeddedTitle,
      source: normalizeAgentSessionTitle(session.agentSessionTitleSource) || "agent-session",
    };
  }

  const kind = String(session.kind || "").toLowerCase();
  const sessionId = String(session.sessionId || "").trim();
  if (!sessionId) return null;

  if (kind === "codex") {
    const index = await readCachedBackendText(
      backend,
      "~/.codex/session_index.jsonl",
      TITLE_INDEX_MAX_BYTES,
    );
    const title = parseCodexSessionTitles(index).get(sessionId) || "";
    return title ? { title, source: "codex-thread-name" } : null;
  }

  if (kind !== "claude") return null;

  let transcriptTitle = null;
  if (session.transcriptPath) {
    const transcript = await readCachedBackendText(
      backend,
      session.transcriptPath,
      CLAUDE_TRANSCRIPT_METADATA_MAX_BYTES,
    );
    transcriptTitle = parseClaudeTranscriptTitle(transcript);
    if (transcriptTitle?.source === "claude-custom-title") return transcriptTitle;
  }

  const indexPath = claudeProjectIndexPath(session.cwd);
  if (indexPath) {
    const index = await readCachedBackendText(backend, indexPath, TITLE_INDEX_MAX_BYTES);
    const summary = parseClaudeSessionsIndexTitle(index, sessionId);
    if (summary) return { title: summary, source: "claude-summary" };
  }

  return transcriptTitle;
}

