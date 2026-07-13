// Connector integration for raw transcript replication.
//
// Inventory discovery supplies `{kind, agentSessionId, transcriptPath}`. This
// publisher remembers every observed source, periodically asks the transport-
// only replicator for newline-aligned chunks, and persists both cursors and
// pending bytes atomically under ~/.local/share. No Claude/Codex JSON semantics
// live here; completion events are derived centrally from the archived stream.

import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createTranscriptReplicator } from "./transcript-replicator.mjs";

const DEFAULT_SYNC_INTERVAL_MS = 10_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 60_000;
const DEFAULT_BACKFILL_SESSIONS_PER_SYNC = 8;
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "tmux-mobile",
  "transcript-archive.json",
);

export function createFileTranscriptStateStore({
  filePath = process.env.TMUX_MOBILE_TRANSCRIPT_STATE || DEFAULT_STATE_PATH,
} = {}) {
  let statesPromise = null;
  let writeChain = Promise.resolve();

  async function states() {
    if (!statesPromise) {
      statesPromise = readFile(filePath, "utf8")
        .then((text) => {
          const parsed = JSON.parse(text);
          return parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object"
            ? parsed.sessions
            : {};
        })
        .catch((error) => {
          if (error.code === "ENOENT") return {};
          throw error;
        });
    }
    return statesPromise;
  }

  async function persist(current) {
    const snapshot = JSON.stringify({ version: 1, sessions: current }, null, 2) + "\n";
    // A transient disk failure must reject this save without poisoning every
    // later save in the process. The exact state remains in memory and the next
    // sync can retry persistence.
    writeChain = writeChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temp = `${filePath}.tmp-${process.pid}`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, filePath);
    });
    return writeChain;
  }

  return {
    filePath,
    async load(sessionKey) {
      return cloneJson((await states())[String(sessionKey)] ?? null);
    },
    async save(sessionKey, state) {
      const current = await states();
      current[String(sessionKey)] = cloneJson(state);
      await persist(current);
    },
    async list() {
      const current = await states();
      return Object.entries(current).map(([key, state]) => [key, cloneJson(state)]);
    },
  };
}

export function createAgentTranscriptPublisher({
  uploadChunk,
  stateStore = createFileTranscriptStateStore(),
  syncIntervalMs = numberFromEnv(
    process.env.TMUX_MOBILE_TRANSCRIPT_SYNC_MS,
    DEFAULT_SYNC_INTERVAL_MS,
  ),
  logEvent = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  realpathImpl = realpath,
  discoverFiles = null,
  discoveryIntervalMs = numberFromEnv(
    process.env.TMUX_MOBILE_TRANSCRIPT_DISCOVERY_MS,
    DEFAULT_DISCOVERY_INTERVAL_MS,
  ),
  now = () => Date.now(),
  maxBackfillSessionsPerSync = positiveCountFromEnv(
    process.env.TMUX_MOBILE_TRANSCRIPT_BACKFILL_SESSIONS_PER_SYNC,
    DEFAULT_BACKFILL_SESSIONS_PER_SYNC,
  ),
  ...replicatorOptions
} = {}) {
  if (typeof uploadChunk !== "function") {
    throw new TypeError("uploadChunk must be a function");
  }
  const contexts = new Map();
  let enabled = false;
  let discoveryEnabled = false;
  let stopped = false;
  let timer = null;
  let running = null;
  let rerunRequested = false;
  let initializationError = null;
  let lastDiscoveryAt = Number.NEGATIVE_INFINITY;

  const ready = restoreTrackedSessions().catch((error) => {
    initializationError = error;
    logEvent("transcript_state_load_failed", {
      code: error.code || undefined,
      message: "Could not load transcript replication state",
    });
  });
  const replicator = createTranscriptReplicator({
    stateStore,
    ...replicatorOptions,
    uploadChunk: async (item) => {
      const context = contexts.get(item.sessionKey);
      if (!context) throw new Error(`Missing transcript context for ${item.sessionKey}`);
      const result = await uploadChunk({
        agentKind: context.agentKind,
        agentSessionId: context.agentSessionId,
        fileEpoch: item.fileEpoch,
        startOffset: item.startOffset,
        endOffsetExclusive: item.endOffsetExclusive,
        firstLineSeq: item.firstLineSeq,
        nextLineSeq: item.nextLineSeq,
        previousChunkSha256: item.previousChunkSha256,
        sha256: item.bodySha256,
        base64: item.bytes.toString("base64"),
        chunkId: item.chunkId,
      });
      if (result?.ack === true && !result.chunkId) result.chunkId = item.chunkId;
      return result;
    },
  });

  async function restoreTrackedSessions() {
    if (typeof stateStore.list !== "function") return;
    for (const [sessionKey, state] of await stateStore.list()) {
      const parsed = parseSessionKey(sessionKey);
      if (!parsed || !state?.filePath) continue;
      const filePath = await resolveAllowedTranscriptPath(
        parsed.agentKind,
        state.filePath,
        realpathImpl,
      );
      if (!filePath) continue;
      contexts.set(sessionKey, {
        ...parsed,
        filePath,
        lastActiveAt: 0,
        lastSyncAt: 0,
      });
    }
  }

  async function observeAgents(agents = []) {
    await ready;
    const added = await registerAgents(agents, { active: true });
    if (enabled && added > 0) void requestSync();
    return added;
  }

  async function registerAgents(agents = [], { active = false } = {}) {
    let added = 0;
    for (const agent of agents || []) {
      const agentKind = String(agent?.kind || "").toLowerCase();
      const agentSessionId = String(agent?.agentSessionId || "").trim();
      const transcriptPath = expandHome(agent?.transcriptPath);
      if (!agentSessionId || !transcriptPath) continue;
      if (agentKind !== "codex" && agentKind !== "claude") continue;
      const allowedPath = await resolveAllowedTranscriptPath(
        agentKind,
        transcriptPath,
        realpathImpl,
      );
      if (!allowedPath) continue;
      const sessionKey = sessionKeyFor(agentKind, agentSessionId, allowedPath);
      const previous = contexts.get(sessionKey);
      contexts.set(sessionKey, {
        ...(previous || {}),
        agentKind,
        agentSessionId,
        filePath: allowedPath,
        ...(active ? { lastActiveAt: Number(now()) } : {}),
      });
      if (!previous) added += 1;
    }
    return added;
  }

  async function discoverNow({ force = false } = {}) {
    await ready;
    if (typeof discoverFiles !== "function" || (!discoveryEnabled && !force)) return 0;
    const observedAt = Number(now());
    if (!force && observedAt - lastDiscoveryAt < discoveryIntervalMs) return 0;
    // Advance before I/O so a failing root does not cause every inventory poll
    // to hammer the filesystem. The next scheduled interval retries.
    lastDiscoveryAt = observedAt;
    return registerAgents(await discoverFiles(), { active: false });
  }

  async function tick() {
    await ready;
    if (!enabled || stopped) return { sessions: 0, chunks: 0 };
    if (initializationError) {
      return { sessions: contexts.size, chunks: 0, failures: 1 };
    }
    let discoveryFailures = 0;
    try {
      await discoverNow();
    } catch (error) {
      discoveryFailures = 1;
      logEvent("transcript_discovery_failed", {
        code: error.code || undefined,
        message: "Transcript root discovery failed",
      });
    }
    let chunks = 0;
    let failures = 0;
    let quarantined = 0;
    let deferred = 0;
    let backfillSessions = 0;
    const tickAt = Number(now());
    const activeWindowMs = Math.max(syncIntervalMs * 3, 30_000);
    const orderedContexts = [...contexts.entries()].sort(
      (left, right) =>
        Number(right[1].lastActiveAt || 0) - Number(left[1].lastActiveAt || 0),
    );
    for (const [sessionKey, context] of orderedContexts) {
      const active =
        Number(context.lastActiveAt || 0) > 0 &&
        tickAt - Number(context.lastActiveAt) <= activeWindowMs;
      if (!active) {
        if (
          Number(context.lastSyncAt || 0) > 0 &&
          tickAt - Number(context.lastSyncAt) < discoveryIntervalMs
        ) {
          deferred += 1;
          continue;
        }
        if (backfillSessions >= maxBackfillSessionsPerSync) {
          deferred += 1;
          continue;
        }
        backfillSessions += 1;
      }
      context.lastSyncAt = tickAt;
      try {
        const result = await replicator.syncSession({
          sessionKey,
          filePath: context.filePath,
        });
        chunks += result.uploaded.length;
        if (result.quarantined) {
          quarantined += 1;
          if (context.quarantineCode !== result.quarantined.code) {
            context.quarantineCode = result.quarantined.code;
            logEvent("transcript_source_quarantined", {
              agentKind: context.agentKind,
              agentSessionId: context.agentSessionId,
              code: result.quarantined.code,
              limit: result.quarantined.limit,
            });
          }
        } else {
          context.quarantineCode = "";
        }
      } catch (error) {
        failures += 1;
        logEvent("transcript_sync_failed", {
          agentKind: context.agentKind,
          agentSessionId: context.agentSessionId,
          code: error.code || undefined,
          message: "Transcript source sync failed",
        });
      }
    }
    return {
      sessions: contexts.size,
      chunks,
      failures: failures + discoveryFailures,
      quarantined,
      deferred,
    };
  }

  function syncNow() {
    if (running) return running;
    running = tick().finally(() => {
      running = null;
      if (rerunRequested && enabled && !stopped) {
        rerunRequested = false;
        void syncNow();
      } else {
        rerunRequested = false;
      }
    });
    return running;
  }

  function requestSync() {
    if (running) {
      rerunRequested = true;
      return running;
    }
    return syncNow();
  }

  function setEnabled(value) {
    enabled = Boolean(value) && !stopped;
    if (!enabled) {
      if (timer) clearIntervalImpl(timer);
      timer = null;
      return;
    }
    if (!timer) {
      timer = setIntervalImpl(() => void syncNow(), syncIntervalMs);
      timer?.unref?.();
    }
    void syncNow();
  }

  function setDiscoveryEnabled(value) {
    discoveryEnabled = Boolean(value) && !stopped;
    if (enabled && discoveryEnabled) void requestSync();
  }

  function stop() {
    stopped = true;
    enabled = false;
    discoveryEnabled = false;
    rerunRequested = false;
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }

  return {
    observeAgents,
    discoverNow,
    setEnabled,
    setDiscoveryEnabled,
    syncNow,
    stop,
    get enabled() {
      return enabled;
    },
    get trackedSessions() {
      return contexts.size;
    },
  };
}

export function sessionKeyFor(agentKind, agentSessionId, transcriptPath = "") {
  const base = `${String(agentKind || "").toLowerCase()}:${String(agentSessionId || "").trim()}`;
  const sourcePath = String(transcriptPath || "");
  if (!sourcePath) return base;
  const sourceFingerprint = createHash("sha256")
    .update(sourcePath)
    .digest("hex")
    .slice(0, 24);
  return `${base}:file-${sourceFingerprint}`;
}

function parseSessionKey(value) {
  const match = /^(codex|claude):(.+)$/.exec(String(value || ""));
  if (!match) return null;
  const agentSessionId = match[2].replace(/:file-[0-9a-f]{24}$/, "");
  return agentSessionId ? { agentKind: match[1], agentSessionId } : null;
}

function expandHome(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

async function resolveAllowedTranscriptPath(agentKind, filePath, realpathImpl) {
  const configuredRoot = path.resolve(
    agentKind === "codex"
      ? process.env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT ||
          path.join(os.homedir(), ".codex", "sessions")
      : process.env.TMUX_MOBILE_CLAUDE_TRANSCRIPT_ROOT ||
          path.join(os.homedir(), ".claude", "projects"),
  );
  try {
    const [root, target] = await Promise.all([
      realpathImpl(configuredRoot),
      realpathImpl(path.resolve(filePath)),
    ]);
    return target.startsWith(root + path.sep) && target.endsWith(".jsonl")
      ? target
      : "";
  } catch {
    return "";
  }
}

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 ? Math.floor(parsed) : fallback;
}

function positiveCountFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
