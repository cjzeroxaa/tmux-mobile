export const CARD_SORT_KEY = "tmux-mobile-card-sort";
export function normalizeCardSort(value) {
  return value === "recent" ? "recent" : "current";
}
export function compareRecentActivity(left, right) {
  const time = (agent) => [agent.lastActivityAt, agent.lastAssistantAt, agent.lastUserAt]
    .reduce((latest, value) => {
      const parsed = Date.parse(String(value || ""));
      return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
    }, 0);
  return time(right) - time(left);
}

function clean(value) {
  return String(value || "").trim();
}

function sessionIdentity(agent) {
  return clean(agent.sessionId) || clean(agent.sessionName) || "(unnamed session)";
}

function sessionGroupKey(agent, machineKey, muxKey) {
  return [machineKey(agent), clean(muxKey(agent)) || "tmux", sessionIdentity(agent)].join("::");
}

/**
 * Preserve the existing grouped feed, or show one global recent-activity feed.
 * Starred cards mirror mobile: they live in one priority group instead of
 * appearing twice, while sessionCount still describes every visible session.
 */
export function groupAgentSessions(
  source,
  { machineKey, isStarred, muxKey = (agent) => agent.mux, sortBy = "current" },
) {
  const starred = [];
  const sessionKeys = new Set();
  const sessionMap = new Map();

  for (const agent of source) {
    const key = sessionGroupKey(agent, machineKey, muxKey);
    sessionKeys.add(key);
    if (isStarred(agent)) {
      starred.push(agent);
      continue;
    }

    const machineId = machineKey(agent);
    const mux = clean(muxKey(agent)) || "tmux";
    const group = sessionMap.get(key) || {
      key,
      title: clean(agent.sessionName) || clean(agent.sessionId) || "Unnamed session",
      subtitle: [clean(agent.machineHostname) || machineId, mux].filter(Boolean).join(" · "),
      kind: "session",
      agents: [],
    };
    group.agents.push(agent);
    sessionMap.set(key, group);
  }

  const groups = [];
  if (starred.length > 0) {
    groups.push({
      key: "starred",
      title: "Starred",
      subtitle: "Priority windows across sessions",
      kind: "starred",
      agents: starred,
    });
  }
  if (sortBy === "recent") {
    starred.sort(compareRecentActivity);
    const recent = [...sessionMap.values()].flatMap((group) => group.agents).sort(compareRecentActivity);
    if (recent.length) groups.push({
      key: "recent", title: "Recent activity", subtitle: "Newest first · Starred cards stay on top",
      kind: "recent", agents: recent,
    });
  } else {
    groups.push(...sessionMap.values());
  }

  return {
    groups,
    agents: groups.flatMap((group) => group.agents),
    sessionCount: sessionKeys.size,
  };
}
