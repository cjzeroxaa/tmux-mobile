import { createHash } from "node:crypto";
import { buildAgentAppUrl } from "../public/agent-link.mjs";

export { buildAgentAppUrl };

export const NTFY_TOPIC_PREFIX = "meowoof";
export const NTFY_MESSAGE_MAX_BYTES = 4 * 1024;

const DEFAULT_NTFY_BASE_URL = "https://ntfy.sh";
const DEFAULT_NTFY_POLL_INTERVAL_MS = 10_000;
const DEFAULT_NTFY_TOPIC_MIN_INTERVAL_MS = 60_000;
const DEFAULT_NTFY_RECENT_ACTIVITY_MS = 5 * 60_000;
const MAX_TOPIC_LENGTH = 64;
const TRUNCATION_MARKER = "...";

export function createNtfyConfig(env = process.env) {
  const enabled = parseBoolean(env.NTFY_ENABLED || env.TMUX_MOBILE_NTFY_ENABLED);
  return {
    enabled,
    baseUrl: normalizeBaseUrl(
      env.NTFY_BASE_URL || env.TMUX_MOBILE_NTFY_BASE_URL || DEFAULT_NTFY_BASE_URL,
      DEFAULT_NTFY_BASE_URL,
    ),
    token: String(env.NTFY_TOKEN || env.TMUX_MOBILE_NTFY_TOKEN || ""),
    topic: sanitizeTopicPart(
      env.NTFY_TOPIC || env.TMUX_MOBILE_NTFY_TOPIC || "",
    ),
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
  const configuredTopic = sanitizeTopicPart(config.topic || "");
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
    const topic = configuredTopic || ntfyTopicForMachine(machine, agent);
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
      appUrl,
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
        bytes: Buffer.byteLength(body, "utf8"),
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

function formatNotificationBody(text, appUrl = "", maxBytes = NTFY_MESSAGE_MAX_BYTES) {
  const body = String(text || "").trim() || "Agent finished.";
  const link = appUrl ? `\n\nOpen: ${appUrl}` : "";
  if (utf8Bytes(body) + utf8Bytes(link) <= maxBytes) return `${body}${link}`;

  // Keep the deep link intact whenever it fits. It is the escape hatch to the
  // full transcript when the response itself is too large for ntfy/APNS.
  const bodyBudget = Math.max(0, maxBytes - utf8Bytes(link));
  if (bodyBudget > 0) return `${truncateUtf8(body, bodyBudget)}${link}`;
  return truncateUtf8(`${body}${link}`, maxBytes);
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

  const separator = "\n\n---\n\n";
  const entries = batch.map((item, index) => {
    const label = `${item.machineName} ${item.kind}`.trim();
    return {
      item,
      prefix: `[${index + 1}/${batch.length}] ${label}\n`,
      fullBody: formatNotificationBody(item.text, item.appUrl, Number.POSITIVE_INFINITY),
    };
  });
  const fullBody = entries.map((entry) => `${entry.prefix}${entry.fullBody}`).join(separator);
  if (utf8Bytes(fullBody) <= NTFY_MESSAGE_MAX_BYTES) return fullBody;

  const framingBytes =
    entries.reduce((total, entry) => total + utf8Bytes(entry.prefix), 0) +
    utf8Bytes(separator) * Math.max(0, entries.length - 1);
  const bodyBudgets = allocateByteBudgets(
    entries.map((entry) => utf8Bytes(entry.fullBody)),
    Math.max(0, NTFY_MESSAGE_MAX_BYTES - framingBytes),
  );
  const fitted = entries
    .map(
      (entry, index) =>
        `${entry.prefix}${formatNotificationBody(
          entry.item.text,
          entry.item.appUrl,
          bodyBudgets[index],
        )}`,
    )
    .join(separator);
  return truncateUtf8(fitted, NTFY_MESSAGE_MAX_BYTES);
}

function allocateByteBudgets(byteLengths, totalBudget) {
  const budgets = byteLengths.map(() => 0);
  let remaining = Math.max(0, Math.floor(totalBudget));
  let pending = byteLengths.map((_, index) => index);

  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const satisfied = pending.filter((index) => byteLengths[index] <= share);
    if (satisfied.length === 0) {
      const remainder = remaining - share * pending.length;
      pending.forEach((index, pendingIndex) => {
        budgets[index] = share + (pendingIndex < remainder ? 1 : 0);
      });
      break;
    }
    const satisfiedSet = new Set(satisfied);
    for (const index of satisfied) {
      budgets[index] = byteLengths[index];
      remaining -= byteLengths[index];
    }
    pending = pending.filter((index) => !satisfiedSet.has(index));
  }

  return budgets;
}

function truncateUtf8(value, maxBytes, marker = TRUNCATION_MARKER) {
  const text = String(value || "");
  const budget = Math.max(0, Math.floor(maxBytes));
  if (utf8Bytes(text) <= budget) return text;
  if (budget === 0) return "";

  const markerBytes = utf8Bytes(marker);
  if (markerBytes > budget) return takeUtf8Prefix(marker, budget);
  const prefix = takeUtf8Prefix(text, budget - markerBytes).trimEnd();
  return `${prefix}${marker}`;
}

function takeUtf8Prefix(value, maxBytes) {
  const chars = [];
  let used = 0;
  for (const char of String(value || "")) {
    const bytes = utf8Bytes(char);
    if (used + bytes > maxBytes) break;
    chars.push(char);
    used += bytes;
  }
  return chars.join("");
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
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
