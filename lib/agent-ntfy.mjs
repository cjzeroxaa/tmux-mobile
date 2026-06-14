import { createHash } from "node:crypto";

export const NTFY_TOPIC_PREFIX = "meowoof";

const DEFAULT_NTFY_BASE_URL = "https://ntfy.sh";
const DEFAULT_NTFY_POLL_INTERVAL_MS = 10_000;
const DEFAULT_NTFY_TOPIC_MIN_INTERVAL_MS = 60_000;
const DEFAULT_NTFY_RECENT_ACTIVITY_MS = 5 * 60_000;
const MAX_TOPIC_LENGTH = 64;
const MAX_NOTIFICATION_PREVIEW_CHARS = 320;

export function createNtfyConfig(env = process.env) {
  const enabled = parseBoolean(env.NTFY_ENABLED || env.TMUX_MOBILE_NTFY_ENABLED);
  return {
    enabled,
    baseUrl: normalizeBaseUrl(
      env.NTFY_BASE_URL || env.TMUX_MOBILE_NTFY_BASE_URL || DEFAULT_NTFY_BASE_URL,
      DEFAULT_NTFY_BASE_URL,
    ),
    token: String(env.NTFY_TOKEN || env.TMUX_MOBILE_NTFY_TOKEN || ""),
    pollIntervalMs: parsePositiveInteger(
      env.NTFY_POLL_INTERVAL_MS || env.TMUX_MOBILE_NTFY_POLL_INTERVAL_MS,
      DEFAULT_NTFY_POLL_INTERVAL_MS,
    ),
    topicMinIntervalMs: parsePositiveInteger(
      env.NTFY_TOPIC_MIN_INTERVAL_MS || env.TMUX_MOBILE_NTFY_TOPIC_MIN_INTERVAL_MS,
      DEFAULT_NTFY_TOPIC_MIN_INTERVAL_MS,
    ),
    recentActivityMs: parsePositiveInteger(
      env.NTFY_RECENT_ACTIVITY_MS || env.TMUX_MOBILE_NTFY_RECENT_ACTIVITY_MS,
      DEFAULT_NTFY_RECENT_ACTIVITY_MS,
    ),
  };
}

export function createAgentRoundNtfyNotifier(
  config = {},
  {
    fetchImpl = globalThis.fetch,
    logEvent = () => {},
    now = () => Date.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  const enabled = Boolean(config.enabled);
  const baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_NTFY_BASE_URL, DEFAULT_NTFY_BASE_URL);
  const appBaseUrl = normalizeBaseUrl(config.appBaseUrl || "", "");
  const token = String(config.token || "");
  const pollIntervalMs = parsePositiveInteger(
    config.pollIntervalMs,
    DEFAULT_NTFY_POLL_INTERVAL_MS,
  );
  const topicMinIntervalMs = parsePositiveInteger(
    config.topicMinIntervalMs,
    DEFAULT_NTFY_TOPIC_MIN_INTERVAL_MS,
  );
  const recentActivityMs = parsePositiveInteger(
    config.recentActivityMs,
    DEFAULT_NTFY_RECENT_ACTIVITY_MS,
  );
  const states = new Map();
  const topicQueues = new Map();

  async function observeAgents({ machines = [], agents = [] } = {}) {
    if (!enabled || typeof fetchImpl !== "function") return [];
    const machineIndex = buildMachineIndex(machines);
    const affectedTopics = new Set();

    for (const agent of agents) {
      const machine = machineForAgent(machineIndex, agent);
      const notification = nextNotification(agent, machine);
      const topic = notification ? enqueueNotification(notification) : "";
      if (topic) affectedTopics.add(topic);
    }

    const immediateFlushes = [];
    for (const topic of affectedTopics) {
      const flush = flushOrScheduleTopic(topic);
      if (flush) immediateFlushes.push(flush);
    }

    const results = await Promise.allSettled(immediateFlushes);
    return results;
  }

  function nextNotification(agent, machine = {}) {
    const key = agentStateKey(agent, machine);
    if (!key) return null;

    const status = normalizeStatus(agent.status);
    const text = String(agent.lastAssistantText || "").trim();
    const hash = text ? sha1(text) : "";
    const turnCount = normalizeCount(agent.turnCount);
    const prev = states.get(key);

    if (!prev) {
      const shouldNotify = shouldNotifyFirstSeen(agent, status, hash);
      states.set(key, {
        status,
        lastHash: hash,
        notifiedHash: hash,
        turnCount,
      });
      if (!shouldNotify) return null;
      return { key, agent, machine, text };
    }

    const responseChanged = Boolean(hash && hash !== prev.notifiedHash);
    const changedThisTick = Boolean(hash && hash !== prev.lastHash);
    const countedNewTurn = turnCount > prev.turnCount;
    const shouldNotify =
      isEndedStatus(status) &&
      responseChanged &&
      (prev.status === "running" || countedNewTurn || changedThisTick);

    states.set(key, {
      status,
      lastHash: hash || prev.lastHash,
      notifiedHash: shouldNotify ? hash : prev.notifiedHash,
      turnCount: Math.max(turnCount, prev.turnCount),
    });

    if (!shouldNotify) return null;
    return { key, agent, machine, text };
  }

  function shouldNotifyFirstSeen(agent, status, hash) {
    if (!isEndedStatus(status) || !hash) return false;
    const activityMs = parseDateMs(agent.lastActivityAt);
    if (!Number.isFinite(activityMs)) return false;
    return now() - activityMs <= recentActivityMs;
  }

  function enqueueNotification({ key, agent, machine, text }) {
    const topic = ntfyTopicForMachine(machine, agent);
    const machineName = visibleMachineName(machine, agent);
    const kind = agent.kind || "agent";
    const appUrl = buildAgentAppUrl(agent, { appBaseUrl, machine });
    const queue = topicQueue(topic);
    queue.pending.push({
      key,
      topic,
      machineName,
      kind,
      title: `${machineName} ${kind} finished`,
      text,
      body: formatNotificationBody(text, appUrl),
    });
    return topic;
  }

  function topicQueue(topic) {
    let queue = topicQueues.get(topic);
    if (!queue) {
      queue = {
        pending: [],
        timer: null,
        flushing: null,
        lastSentAt: Number.NEGATIVE_INFINITY,
      };
      topicQueues.set(topic, queue);
    }
    return queue;
  }

  function flushOrScheduleTopic(topic) {
    const queue = topicQueues.get(topic);
    if (!queue || !queue.pending.length || queue.flushing) return null;
    const delayMs = msUntilTopicAllowed(queue);
    if (delayMs > 0) {
      scheduleTopicFlush(topic, queue, delayMs);
      return null;
    }
    return flushTopic(topic, queue);
  }

  function scheduleTopicFlush(topic, queue, delayMs) {
    if (queue.timer || queue.flushing || !queue.pending.length) return;
    queue.timer = setTimeoutImpl(() => {
      queue.timer = null;
      void flushOrScheduleTopic(topic);
    }, delayMs);
    queue.timer?.unref?.();
  }

  function msUntilTopicAllowed(queue) {
    if (!Number.isFinite(queue.lastSentAt)) return 0;
    return Math.max(0, topicMinIntervalMs - (now() - queue.lastSentAt));
  }

  function flushTopic(topic, queue = topicQueues.get(topic)) {
    if (!queue || queue.flushing || !queue.pending.length) return null;
    if (queue.timer) {
      clearTimeoutImpl(queue.timer);
      queue.timer = null;
    }
    const batch = queue.pending.splice(0);
    const flushing = sendNotificationBatch(topic, batch)
      .finally(() => {
        queue.lastSentAt = now();
        queue.flushing = null;
        flushOrScheduleTopic(topic);
      });
    queue.flushing = flushing;
    return flushing;
  }

  async function sendNotificationBatch(topic, batch) {
    const title = formatBatchTitle(topic, batch);
    const machineName = formatBatchMachineName(topic, batch);
    const body = formatBatchBody(batch);
    const headers = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Tags: "bell",
    };
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      const response = await fetchImpl(`${baseUrl}/${topic}`, {
        method: "POST",
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`ntfy returned HTTP ${response.status}`);
      }
      logEvent("ntfy_agent_round_sent", {
        topic,
        machine: machineName,
        agentKey: batch.length === 1 ? batch[0].key : undefined,
        agentKeys: batch.map((item) => item.key),
        count: batch.length,
        chars: body.length,
        tags: "bell",
      });
    } catch (error) {
      logEvent("ntfy_agent_round_failed", {
        topic,
        machine: machineName,
        agentKey: batch.length === 1 ? batch[0].key : undefined,
        agentKeys: batch.map((item) => item.key),
        count: batch.length,
        tags: "bell",
        message: error.message || String(error),
      });
    }
  }

  return {
    get enabled() {
      return enabled;
    },
    get baseUrl() {
      return baseUrl;
    },
    get pollIntervalMs() {
      return pollIntervalMs;
    },
    get topicMinIntervalMs() {
      return topicMinIntervalMs;
    },
    get recentActivityMs() {
      return recentActivityMs;
    },
    observeAgents,
    reset() {
      states.clear();
      for (const queue of topicQueues.values()) {
        if (queue.timer) clearTimeoutImpl(queue.timer);
      }
      topicQueues.clear();
    },
  };
}

export function buildAgentAppUrl(agent = {}, { appBaseUrl = "", machine = {} } = {}) {
  const params = new URLSearchParams();
  const session = String(agent.sessionName || agent.sessionId || "");
  const windowIndex = agent.windowIndex === undefined || agent.windowIndex === null
    ? ""
    : String(agent.windowIndex);
  const machineId = routeMachineIdForLink(agent, machine);
  const windowName = String(agent.windowName || "");

  if (session) params.set("session", session);
  if (windowIndex) params.set("window", windowIndex);
  if (machineId && machineId !== "local") params.set("machineId", machineId);
  if (windowName) params.set("windowName", windowName);

  const query = params.toString();
  const base = normalizeBaseUrl(appBaseUrl, "");
  if (!base) return `/app/${query ? `?${query}` : ""}`;
  const appBase = base.endsWith("/app") ? `${base}/` : `${base}/app/`;
  return `${appBase}${query ? `?${query}` : ""}`;
}

function routeMachineIdForLink(agent = {}, machine = {}) {
  return String(
    machine.agentId ||
      agent.machineAgentId ||
      agent.machineAgentID ||
      agent.agentMachineId ||
      agent.machineId ||
      "",
  );
}

export function ntfyTopicForMachine(machine = {}, agent = {}) {
  const prefix = NTFY_TOPIC_PREFIX;
  const machinePart = sanitizeTopicPart(visibleMachineName(machine, agent)) || "machine";
  const maxMachineLength = Math.max(1, MAX_TOPIC_LENGTH - prefix.length - 1);
  return `${prefix}-${machinePart.slice(0, maxMachineLength)}`.replace(/-+$/g, "");
}

export function visibleMachineName(machine = {}, agent = {}) {
  return String(
    machine.hostname ||
      machine.machineAlias ||
      agent.machineHostname ||
      machine.rawHostname ||
      machine.machineId ||
      machine.rawMachineId ||
      agent.machineRawId ||
      agent.machineId ||
      "machine",
  );
}

function buildMachineIndex(machines) {
  const index = new Map();
  for (const machine of machines || []) {
    for (const key of machineKeys(machine)) index.set(key, machine);
  }
  return index;
}

function machineForAgent(index, agent = {}) {
  for (const key of [
    agent.machineId,
    agent.machineRawId,
    agent.machineHostname,
  ]) {
    const machine = index.get(String(key || ""));
    if (machine) return machine;
  }
  return {};
}

function machineKeys(machine = {}) {
  return [
    machine.id,
    machine.agentId,
    machine.machineId,
    machine.rawMachineId,
    machine.hostname,
    machine.rawHostname,
    machine.machineAlias,
  ].map((value) => String(value || "")).filter(Boolean);
}

function agentStateKey(agent = {}, machine = {}) {
  const machineId = String(
    machine.agentId ||
      agent.machineAgentId ||
      agent.machineId ||
      machine.id ||
      agent.machineRawId ||
      machine.machineId ||
      "local",
  );
  const agentId = String(
    agent.agentSessionId ||
      agent.transcriptPath ||
      agent.windowId ||
      agent.paneId ||
      "",
  );
  if (!machineId || !agentId) return "";
  return `${machineId}::${agent.kind || "agent"}::${agentId}`;
}

function normalizeStatus(status) {
  const value = String(status || "");
  return value || "unverified";
}

function isEndedStatus(status) {
  return status === "idle" || status === "waiting";
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function parseDateMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function formatNotificationBody(text, appUrl = "") {
  const body = previewText(text) || "Agent finished.";
  return appUrl ? `${body}\n\nOpen: ${appUrl}` : body;
}

function formatBatchTitle(topic, batch) {
  if (batch.length === 1) return batch[0].title;
  const machines = uniqueValues(batch.map((item) => item.machineName));
  const label = machines.length === 1 ? machines[0] : topic;
  return `${label} ${batch.length} agent updates`;
}

function formatBatchMachineName(topic, batch) {
  const machines = uniqueValues(batch.map((item) => item.machineName));
  if (machines.length === 1) return machines[0];
  return topic;
}

function formatBatchBody(batch) {
  if (batch.length === 1) return batch[0].body;
  return batch
    .map((item, index) => {
      const label = `${item.machineName} ${item.kind}`.trim();
      return `[${index + 1}/${batch.length}] ${label}\n${item.body}`;
    })
    .join("\n\n---\n\n");
}

function previewText(text) {
  const compact = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= MAX_NOTIFICATION_PREVIEW_CHARS) return compact;
  return `${compact.slice(0, MAX_NOTIFICATION_PREVIEW_CHARS - 3).trimEnd()}...`;
}

function uniqueValues(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function sanitizeTopicPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function normalizeBaseUrl(value, fallback = DEFAULT_NTFY_BASE_URL) {
  return String(value || fallback).replace(/\/+$/g, "");
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
