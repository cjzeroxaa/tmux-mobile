import assert from "node:assert/strict";
import {
  buildAgentAppUrl,
  createAgentRoundNtfyNotifier,
  createNtfyConfig,
  NTFY_MESSAGE_MAX_BYTES,
  ntfyTopicForMachine,
} from "../lib/agent-ntfy.mjs";

assert.equal(
  ntfyTopicForMachine({ hostname: "FIN Mini" }),
  "meowoof-fin-mini",
  "machine topic suffix is lowercase and dash-separated",
);
assert.equal(
  ntfyTopicForMachine({ hostname: "MacBook.Pro 15.local" }),
  "meowoof-macbook-pro-15-local",
  "punctuation and spaces become dashes",
);
assert.equal(
  createNtfyConfig({ NTFY_ENABLED: "1", NTFY_BASE_URL: "https://ntfy.example/" }).baseUrl,
  "https://ntfy.example",
  "base URL is normalized",
);
assert.equal(
  createNtfyConfig({ NTFY_TOPIC_MIN_INTERVAL_MS: "1500" }).topicMinIntervalMs,
  1500,
  "topic publish interval is configurable",
);
assert.equal(
  createNtfyConfig({ NTFY_RECENT_ACTIVITY_MS: "2500" }).recentActivityMs,
  2500,
  "recent first-seen completion window is configurable",
);
assert.equal(
  createNtfyConfig({ NTFY_TOPIC: " Unified Team Channel " }).topic,
  "unified-team-channel",
  "an explicit unified topic is normalized",
);
assert.equal(
  buildAgentAppUrl(
    {
      machineId: "m-fin",
      sessionName: "work",
      windowIndex: 2,
      windowName: "Codex Task",
    },
    {
      appBaseUrl: "https://eng.impo.ai/",
      machine: { agentId: "4503e6cd-795a-4f59-9592-d6c4a5df764f" },
    },
  ),
  "https://eng.impo.ai/app/?session=work&window=2&machineId=4503e6cd-795a-4f59-9592-d6c4a5df764f&windowName=Codex+Task",
  "agent app URL routes by durable machine agentId",
);
assert.equal(
  buildAgentAppUrl({
    machineId: "m-fin",
    machineAgentId: "4503e6cd-795a-4f59-9592-d6c4a5df764f",
    sessionName: "work",
    windowId: "@1",
    windowIndex: 2,
    windowName: "Codex Task",
  }),
  "/app/?session=work&windowId=%401&window=2&machineId=4503e6cd-795a-4f59-9592-d6c4a5df764f&windowName=Codex+Task",
  "command center agent URL uses the same durable route id",
);
assert.equal(
  buildAgentAppUrl(
    {
      machineId: "m-fin",
      sessionName: "work",
      windowIndex: 2,
    },
    { appBaseUrl: "https://eng.impo.ai/" },
  ),
  "https://eng.impo.ai/app/?session=work&window=2&machineId=m-fin",
  "agent app URL falls back to the route id when no agentId is available",
);
assert.equal(
  buildAgentAppUrl(
    {
      machineId: "m-fin",
      sessionName: "work",
      windowIndex: 2,
    },
    {
      appBaseUrl: "https://eng.impo.ai/app/",
      machine: { agentId: "4503e6cd-795a-4f59-9592-d6c4a5df764f" },
    },
  ),
  "https://eng.impo.ai/app/?session=work&window=2&machineId=4503e6cd-795a-4f59-9592-d6c4a5df764f",
  "agent app URL accepts an app-page base URL",
);
assert.equal(
  buildAgentAppUrl(
    {
      machineId: "local",
      sessionName: "local-work",
      windowIndex: 1,
    },
    { appBaseUrl: "http://127.0.0.1:3737" },
  ),
  "http://127.0.0.1:3737/app/?session=local-work&window=1",
  "local app URL omits machineId",
);

function createFakeClock() {
  let nowMs = 0;
  const timers = [];
  return {
    now: () => nowMs,
    advanceTo(value) {
      nowMs = value;
    },
    setTimeout(callback, delayMs) {
      const timer = {
        callback,
        cleared: false,
        dueAt: nowMs + delayMs,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    async runDueTimers() {
      const due = timers.filter((timer) => !timer.cleared && timer.dueAt <= nowMs);
      assert.ok(due.length > 0, "expected at least one due timer");
      for (const timer of due) {
        timer.cleared = true;
        timer.callback();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingTimers() {
      return timers.filter((timer) => !timer.cleared && timer.dueAt > nowMs);
    },
  };
}

const clock = createFakeClock();
const posts = [];
const notifier = createAgentRoundNtfyNotifier(
  {
    enabled: true,
    baseUrl: "https://ntfy.example",
    appBaseUrl: "https://eng.impo.ai",
  },
  {
    fetchImpl: async (url, options) => {
      posts.push({ url, options });
      return { ok: true, status: 200 };
    },
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  },
);

const machine = {
  id: "m-fin",
  agentId: "4503e6cd-795a-4f59-9592-d6c4a5df764f",
  machineId: "fin-mini",
  hostname: "FIN Mini",
};
const baseAgent = {
  machineId: "m-fin",
  kind: "codex",
  agentSessionId: "session-1",
  sessionName: "work",
  windowId: "@1",
  windowIndex: 2,
  windowName: "Codex Task",
  paneId: "%1",
};

const firstSeenPosts = [];
const firstSeenNotifier = createAgentRoundNtfyNotifier(
  {
    enabled: true,
    baseUrl: "https://ntfy.example",
    appBaseUrl: "https://eng.impo.ai",
  },
  {
    fetchImpl: async (url, options) => {
      firstSeenPosts.push({ url, options });
      return { ok: true, status: 200 };
    },
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  },
);
await firstSeenNotifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      agentSessionId: "session-first-seen",
      status: "idle",
      lastAssistantText: "fast finished response",
      lastActivityAt: new Date(0).toISOString(),
      turnCount: 1,
    },
  ],
});
assert.equal(firstSeenPosts.length, 1, "recent first-seen idle response is notified");
assert.equal(firstSeenPosts[0].url, "https://ntfy.example/meowoof-fin-mini");

await notifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      status: "idle",
      lastAssistantText: "already visible",
      turnCount: 2,
    },
  ],
});
assert.equal(posts.length, 0, "existing idle response is not notified on first observation");

await notifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      status: "running",
      lastAssistantText: "already visible",
      turnCount: 2,
    },
  ],
});
await notifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      status: "idle",
      lastAssistantText: "finished response",
      turnCount: 3,
    },
  ],
});
assert.equal(posts.length, 1, "running to idle with a new response sends one notification");
assert.equal(posts[0].url, "https://ntfy.example/meowoof-fin-mini");
assert.equal(posts[0].options.method, "POST");
assert.equal(
  posts[0].options.body,
  "finished response\n\nOpen: https://eng.impo.ai/app/?session=work&windowId=%401&window=2&machineId=4503e6cd-795a-4f59-9592-d6c4a5df764f&windowName=Codex+Task",
);
assert.match(posts[0].options.headers.Title, /FIN Mini codex finished/);
assert.equal(posts[0].options.headers.Tags, "bell");
assert.equal(posts[0].options.headers.Priority, undefined);
assert.equal(posts[0].options.headers.Click, undefined);

await notifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      status: "idle",
      lastAssistantText: "finished response",
      turnCount: 3,
    },
  ],
});
assert.equal(posts.length, 1, "settled idle response is not notified repeatedly");

await notifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      agentSessionId: "session-2",
      status: "running",
      lastAssistantText: "",
      turnCount: 0,
    },
    {
      ...baseAgent,
      agentSessionId: "session-3",
      status: "running",
      lastAssistantText: "",
      turnCount: 0,
    },
  ],
});
await notifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      agentSessionId: "session-2",
      status: "waiting",
      lastAssistantText: "which option should I pick?",
      turnCount: 1,
    },
    {
      ...baseAgent,
      agentSessionId: "session-3",
      status: "idle",
      lastAssistantText: "done too",
      turnCount: 1,
    },
  ],
});
assert.equal(posts.length, 1, "same topic notifications inside the minute are queued");
assert.equal(clock.pendingTimers().length, 1, "queued same-topic notifications schedule one flush");

const otherMachine = {
  id: "m-air",
  agentId: "38954708-7903-46eb-9224-819d0081f6a7",
  machineId: "air",
  hostname: "Air",
};
await notifier.observeAgents({
  machines: [otherMachine],
  agents: [
    {
      ...baseAgent,
      machineId: "m-air",
      agentSessionId: "session-air",
      status: "running",
      lastAssistantText: "",
      turnCount: 0,
    },
  ],
});
await notifier.observeAgents({
  machines: [otherMachine],
  agents: [
    {
      ...baseAgent,
      machineId: "m-air",
      agentSessionId: "session-air",
      status: "idle",
      lastAssistantText: "air finished",
      turnCount: 1,
    },
  ],
});
assert.equal(posts.length, 2, "different topics are not blocked by another topic window");
assert.equal(posts[1].url, "https://ntfy.example/meowoof-air");
assert.equal(
  posts[1].options.body,
  "air finished\n\nOpen: https://eng.impo.ai/app/?session=work&windowId=%401&window=2&machineId=38954708-7903-46eb-9224-819d0081f6a7&windowName=Codex+Task",
);
assert.equal(posts[1].options.headers.Tags, "bell");
assert.equal(posts[1].options.headers.Click, undefined);

clock.advanceTo(60_000);
await clock.runDueTimers();
assert.equal(posts.length, 3, "queued same-topic updates flush after one minute");
assert.equal(posts[2].url, "https://ntfy.example/meowoof-fin-mini");
assert.match(posts[2].options.headers.Title, /FIN Mini 2 agent updates/);
assert.equal(posts[2].options.headers.Tags, "bell");
assert.equal(posts[2].options.headers.Priority, undefined);
assert.equal(posts[2].options.headers.Click, undefined);
assert.match(posts[2].options.body, /\[1\/2\] FIN Mini codex/);
assert.match(posts[2].options.body, /which option should I pick\?/);
assert.match(posts[2].options.body, /Open: https:\/\/eng\.impo\.ai\/app\/\?session=work&windowId=%401&window=2&machineId=4503e6cd-795a-4f59-9592-d6c4a5df764f&windowName=Codex\+Task/);
assert.match(posts[2].options.body, /\[2\/2\] FIN Mini codex/);
assert.match(posts[2].options.body, /done too/);

const longText = `${"long response ".repeat(80)}done`;
await notifier.observeAgents({
  machines: [otherMachine],
  agents: [
    {
      ...baseAgent,
      machineId: "m-air",
      agentSessionId: "session-air-long",
      status: "running",
      lastAssistantText: "",
      turnCount: 0,
    },
  ],
});
clock.advanceTo(60_000);
await notifier.observeAgents({
  machines: [otherMachine],
  agents: [
    {
      ...baseAgent,
      machineId: "m-air",
      agentSessionId: "session-air-long",
      status: "idle",
      lastAssistantText: longText,
      turnCount: 1,
    },
  ],
});
assert.equal(posts.length, 4, "long responses are still notified");
assert.ok(posts[3].options.body.length > 320, "push body includes notification preview plus open link");
assert.ok(posts[3].options.body.startsWith(longText), "a response below 4K is preserved in full");
assert.doesNotMatch(posts[3].options.body, /\.\.\.\n\nOpen:/, "a response below 4K is not truncated");

async function captureSingleNotification(text, agentSessionId) {
  const captured = [];
  const logs = [];
  const singleClock = createFakeClock();
  const singleNotifier = createAgentRoundNtfyNotifier(
    {
      enabled: true,
      baseUrl: "https://ntfy.example",
      appBaseUrl: "https://eng.impo.ai",
    },
    {
      fetchImpl: async (url, options) => {
        captured.push({ url, options });
        return { ok: true, status: 200 };
      },
      logEvent: (event, details) => logs.push({ event, details }),
      now: singleClock.now,
      setTimeoutImpl: singleClock.setTimeout,
      clearTimeoutImpl: singleClock.clearTimeout,
    },
  );
  const agent = { ...baseAgent, agentSessionId };
  await singleNotifier.observeAgents({
    machines: [machine],
    agents: [{ ...agent, status: "running", lastAssistantText: "", turnCount: 0 }],
  });
  await singleNotifier.observeAgents({
    machines: [machine],
    agents: [{ ...agent, status: "idle", lastAssistantText: text, turnCount: 1 }],
  });
  assert.equal(captured.length, 1, "single response produces one notification");
  return { post: captured[0], logs, agent };
}

const preservedUnicodeText = `${"完整回复🙂\n".repeat(180)}结束`;
const preservedUnicode = await captureSingleNotification(
  preservedUnicodeText,
  "session-preserved-unicode",
);
const preservedUnicodeUrl = buildAgentAppUrl(preservedUnicode.agent, {
  appBaseUrl: "https://eng.impo.ai",
  machine,
});
assert.equal(
  preservedUnicode.post.options.body,
  `${preservedUnicodeText}\n\nOpen: ${preservedUnicodeUrl}`,
  "multibyte responses larger than the old 320-char preview remain complete when under 4K",
);
assert.ok(
  Buffer.byteLength(preservedUnicode.post.options.body, "utf8") <= NTFY_MESSAGE_MAX_BYTES,
  "complete multibyte response stays inside the ntfy byte limit",
);

const overlongUnicodeText = `${"完成🙂".repeat(800)}最终结尾`;
const overlongUnicode = await captureSingleNotification(
  overlongUnicodeText,
  "session-overlong-unicode",
);
const overlongBody = overlongUnicode.post.options.body;
const [overlongPreview, overlongOpenUrl] = overlongBody.split("\n\nOpen: ");
assert.equal(
  Buffer.byteLength(overlongBody, "utf8"),
  NTFY_MESSAGE_MAX_BYTES,
  "an overlong response uses the full 4K byte budget without exceeding it",
);
assert.ok(overlongPreview.endsWith("..."), "an overlong response is visibly truncated");
assert.ok(overlongOpenUrl, "the deep link survives response truncation");
assert.ok(!overlongBody.includes("最终结尾"), "content beyond the byte budget is removed");
assert.ok(!overlongBody.includes("\uFFFD"), "UTF-8 truncation does not insert a replacement character");
const lastPreviewCodePoint = Array.from(overlongPreview.slice(0, -3)).at(-1)?.codePointAt(0) || 0;
assert.ok(
  lastPreviewCodePoint < 0xd800 || lastPreviewCodePoint > 0xdfff,
  "UTF-8 truncation does not leave a split surrogate",
);
const sentLog = overlongUnicode.logs.find((entry) => entry.event === "ntfy_agent_round_sent");
assert.equal(
  sentLog?.details?.bytes,
  NTFY_MESSAGE_MAX_BYTES,
  "sent notification logs expose the UTF-8 byte size",
);

const batchLimitPosts = [];
const batchLimitNotifier = createAgentRoundNtfyNotifier(
  {
    enabled: true,
    baseUrl: "https://ntfy.example",
    appBaseUrl: "https://eng.impo.ai",
    topic: "unified-limit-test",
  },
  {
    fetchImpl: async (url, options) => {
      batchLimitPosts.push({ url, options });
      return { ok: true, status: 200 };
    },
  },
);
const batchLimitAgents = [
  { ...baseAgent, machineId: "m-fin", agentSessionId: "batch-limit-fin" },
  { ...baseAgent, machineId: "m-air", agentSessionId: "batch-limit-air" },
];
await batchLimitNotifier.observeAgents({
  machines: [machine, otherMachine],
  agents: batchLimitAgents.map((agent) => ({
    ...agent,
    status: "running",
    lastAssistantText: "",
    turnCount: 0,
  })),
});
await batchLimitNotifier.observeAgents({
  machines: [machine, otherMachine],
  agents: batchLimitAgents.map((agent, index) => ({
    ...agent,
    status: "idle",
    lastAssistantText: `${index === 0 ? "甲" : "乙"}${"完成🙂".repeat(800)}`,
    turnCount: 1,
  })),
});
assert.equal(batchLimitPosts.length, 1, "overlong same-topic responses are sent as one batch");
const batchLimitBody = batchLimitPosts[0].options.body;
assert.ok(
  Buffer.byteLength(batchLimitBody, "utf8") <= NTFY_MESSAGE_MAX_BYTES,
  "a multi-agent notification also respects the total 4K byte limit",
);
assert.match(batchLimitBody, /\[1\/2\] FIN Mini codex/);
assert.match(batchLimitBody, /\[2\/2\] Air codex/);
assert.equal(
  (batchLimitBody.match(/\n\nOpen: /g) || []).length,
  2,
  "byte budgeting keeps both batched agent deep links",
);

const failingClock = createFakeClock();
const failingPosts = [];
const failingLogs = [];
const failingNotifier = createAgentRoundNtfyNotifier(
  {
    enabled: true,
    baseUrl: "https://ntfy.example",
    appBaseUrl: "https://eng.impo.ai",
  },
  {
    fetchImpl: async (url, options) => {
      failingPosts.push({ url, options });
      throw new Error("rate limited");
    },
    logEvent: (event, details) => failingLogs.push({ event, details }),
    now: failingClock.now,
    setTimeoutImpl: failingClock.setTimeout,
    clearTimeoutImpl: failingClock.clearTimeout,
  },
);

await failingNotifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      agentSessionId: "session-fail",
      status: "running",
      lastAssistantText: "",
      turnCount: 0,
    },
  ],
});
await failingNotifier.observeAgents({
  machines: [machine],
  agents: [
    {
      ...baseAgent,
      agentSessionId: "session-fail",
      status: "idle",
      lastAssistantText: "will be dropped",
      turnCount: 1,
    },
  ],
});
assert.equal(failingPosts.length, 1, "failed notifications are attempted once");
assert.equal(failingClock.pendingTimers().length, 0, "failed notifications are not retried");
assert.equal(failingLogs[0].event, "ntfy_agent_round_failed");

const unifiedPosts = [];
const unifiedNotifier = createAgentRoundNtfyNotifier(
  {
    enabled: true,
    baseUrl: "https://ntfy.example",
    topic: "unified-team-channel",
  },
  {
    fetchImpl: async (url, options) => {
      unifiedPosts.push({ url, options });
      return { ok: true, status: 200 };
    },
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  },
);
const unifiedAgents = [
  { ...baseAgent, machineId: "m-fin", agentSessionId: "unified-fin" },
  { ...baseAgent, machineId: "m-air", agentSessionId: "unified-air" },
];
await unifiedNotifier.observeAgents({
  machines: [machine, otherMachine],
  agents: unifiedAgents.map((agent) => ({
    ...agent,
    status: "running",
    lastAssistantText: "",
    turnCount: 0,
  })),
});
await unifiedNotifier.observeAgents({
  machines: [machine, otherMachine],
  agents: unifiedAgents.map((agent, index) => ({
    ...agent,
    status: "idle",
    lastAssistantText: index === 0 ? "fin complete" : "air complete",
    turnCount: 1,
  })),
});
assert.equal(unifiedPosts.length, 1, "cross-machine completions share one batch");
assert.equal(unifiedPosts[0].url, "https://ntfy.example/unified-team-channel");
assert.match(unifiedPosts[0].options.body, /FIN Mini codex/);
assert.match(unifiedPosts[0].options.body, /Air codex/);

console.log("agent-ntfy unit tests passed");
