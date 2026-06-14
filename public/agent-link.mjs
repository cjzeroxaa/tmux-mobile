export function buildAgentAppUrl(agent = {}, { appBaseUrl = "", machine = {} } = {}) {
  const params = new URLSearchParams();
  const session = String(agent.sessionName || agent.sessionId || "");
  const windowId = String(agent.windowId || "");
  const windowIndex =
    agent.windowIndex === undefined || agent.windowIndex === null
      ? ""
      : String(agent.windowIndex);
  const machineId = routeMachineIdForLink(agent, machine);
  const windowName = String(agent.windowName || "");

  if (session) params.set("session", session);
  if (windowId) params.set("windowId", windowId);
  if (windowIndex) params.set("window", windowIndex);
  if (machineId && machineId !== "local") params.set("machineId", machineId);
  if (windowName) params.set("windowName", windowName);

  const query = params.toString();
  const base = normalizeAppBaseUrl(appBaseUrl);
  if (!base) return `/app/${query ? `?${query}` : ""}`;
  return `${base}${query ? `?${query}` : ""}`;
}

export function routeMachineIdForLink(agent = {}, machine = {}) {
  return String(
    machine.agentId ||
      agent.machineAgentId ||
      agent.machineAgentID ||
      agent.agentMachineId ||
      agent.machineId ||
      "",
  );
}

function normalizeAppBaseUrl(value) {
  const base = String(value || "").replace(/\/+$/g, "");
  if (!base) return "";
  return base.endsWith("/app") ? `${base}/` : `${base}/app/`;
}
