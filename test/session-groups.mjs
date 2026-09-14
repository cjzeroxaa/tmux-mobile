import assert from "node:assert/strict";

import { normalizeCardSort, groupAgentSessions } from "../public/session-groups.js";

const agents = [
  { id: "recent", machineId: "mac", sessionName: "alpha", windowIndex: 2, mux: "tmux" },
  { id: "star", machineId: "mini", sessionName: "beta", windowIndex: 1, mux: "rmux" },
  { id: "older", machineId: "mac", sessionName: "alpha", windowIndex: 1, mux: "tmux" },
  { id: "third", machineId: "mac", sessionName: "gamma", windowIndex: 0, mux: "tmux" },
];

const grouped = groupAgentSessions(agents, {
  machineKey: (agent) => agent.machineId,
  isStarred: (agent) => agent.id === "star",
});

assert.equal(grouped.sessionCount, 3);
assert.deepEqual(grouped.groups.map((group) => group.title), ["Starred", "alpha", "gamma"]);
assert.deepEqual(grouped.groups[0].agents.map((agent) => agent.id), ["star"]);
assert.deepEqual(grouped.groups[1].agents.map((agent) => agent.id), ["recent", "older"]);
assert.equal(grouped.groups[1].subtitle, "mac · tmux");
assert.deepEqual(grouped.agents.map((agent) => agent.id), ["star", "recent", "older", "third"]);

console.log("session grouping tests passed");

const timeline = [
  { id: "new", machineId: "a", sessionName: "alpha", lastActivityAt: "2026-09-14T12:00:00Z" },
  { id: "old", machineId: "a", sessionName: "alpha", lastActivityAt: "2026-09-12T12:00:00Z" },
  { id: "middle", machineId: "b", sessionName: "beta", lastAssistantAt: "2026-09-13T12:00:00Z", lastActivityAt: "invalid" },
  { id: "star", machineId: "b", sessionName: "beta" },
  { id: "missing", machineId: "a", sessionName: "gamma" },
];
const options = { machineKey: a => a.machineId, isStarred: a => a.id === "star" };
assert.deepEqual(groupAgentSessions(timeline, options).agents.map(a => a.id), ["star", "new", "old", "middle", "missing"]);
const recent = groupAgentSessions(timeline, { ...options, sortBy: "recent" });
assert.deepEqual(recent.agents.map(a => a.id), ["star", "new", "middle", "old", "missing"]);
assert.equal(recent.sessionCount, 3);
assert.equal(normalizeCardSort("recent"), "recent");
for (const value of [null, "invalid", "current"]) assert.equal(normalizeCardSort(value), "current");
assert.deepEqual(timeline.map(a => a.id), ["new", "old", "middle", "star", "missing"]);
