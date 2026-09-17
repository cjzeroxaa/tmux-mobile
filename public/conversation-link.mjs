export function conversationUrl(agent) {
  if (!agent?.machineId || !agent.agentSessionId || !['codex', 'claude'].includes(agent.kind)) return '';
  const params = new URLSearchParams({ machineId: agent.machineId, kind: agent.kind, sessionId: agent.agentSessionId });
  return `/conversation?${params}`;
}
