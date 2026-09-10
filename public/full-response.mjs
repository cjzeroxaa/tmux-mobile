// Old connectors cap each inventory preview at 4096 UTF-8 bytes. A final
// four-byte character may leave up to three bytes unused at that boundary.
export function needsFullResponse(agent) {
  return agent.lastAssistantTruncated || agent.lastUserTruncated ||
    [agent.lastAssistantText, agent.lastUserText].some(
      text => new TextEncoder().encode(String(text || "")).length >= 4093,
    );
}

// One shared, bounded queue across all machines in a list refresh. This runs
// only as part of that refresh; it never installs a timer or retries itself.
export function createFullResponseLoader(api, concurrency = 4) {
  let running = 0;
  const queue = [];
  function drain() {
    while (running < concurrency && queue.length) {
      const { task, resolve, reject } = queue.shift();
      running++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        running--;
        drain();
      });
    }
  }
  function enqueue(task) {
    return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
  }
  return (agents, isCurrent) => Promise.all(agents.map(agent => {
    if (!needsFullResponse(agent)) return agent;
    return enqueue(async () => {
      if (!isCurrent()) return agent;
      try {
        const params = new URLSearchParams({ paneId: agent.paneId, latest: "1" });
        const { result } = await api(`/api/agent-transcript?${params}`, {
          machineId: agent.machineId, mux: agent.mux || agent.machineMux || "tmux",
        });
        if (!isCurrent()) return agent;
        if (!result || (agent.agentSessionId && result.sessionId !== agent.agentSessionId)) {
          throw new Error("Session changed or full response unavailable. Refresh to retry.");
        }
        const turns = result.turns || [];
        const assistant = [...turns].reverse().find(turn => turn.role === "assistant");
        const user = [...turns].reverse().find(turn => turn.role === "user");
        if (agent.lastAssistantText && !assistant) throw new Error("Full response unavailable. Refresh to retry.");
        return {
          ...agent,
          ...(assistant ? { lastAssistantText: assistant.text, lastAssistantAt: assistant.t } : {}),
          ...(user ? { lastUserText: user.text, lastUserAt: user.t } : {}),
          fullTextError: "",
        };
      } catch (error) {
        if (error.silent || !isCurrent()) return agent;
        return { ...agent, fullTextError: error.message || "Full response unavailable. Refresh to retry." };
      }
    });
  }));
}
