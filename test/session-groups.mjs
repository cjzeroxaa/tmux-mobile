import assert from "node:assert/strict";

import { groupAgentSessions } from "../public/session-groups.js";

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
