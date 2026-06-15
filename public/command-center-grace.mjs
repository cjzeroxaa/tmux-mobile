export const COMMAND_CENTER_RECONNECT_GRACE_MS = 12000;

export function createCommandCenterGrace() {
  return {
    until: 0,
    machines: new Set(),
  };
}

export function commandCenterGraceActive(grace, now = Date.now()) {
  return Boolean(grace?.until && grace.until > now);
}

export function commandCenterGraceMachineKeys(grace) {
  return [...(grace?.machines || [])];
}

export function holdCommandCenterSnapshot(
  grace,
  machineKeys = [],
  now = Date.now(),
  graceMs = COMMAND_CENTER_RECONNECT_GRACE_MS,
) {
  if (!grace) return false;
  if (grace.until && grace.until <= now) {
    clearCommandCenterGrace(grace);
    return false;
  }
  if (!grace.until) grace.until = now + graceMs;
  for (const key of machineKeys) {
    if (key) grace.machines.add(String(key));
  }
  return commandCenterGraceActive(grace, now);
}

export function clearCommandCenterGrace(grace, machineKeys = null) {
  if (!grace) return;
  if (!Array.isArray(machineKeys)) {
    grace.until = 0;
    grace.machines.clear();
    return;
  }
  for (const key of machineKeys) {
    grace.machines.delete(String(key));
  }
  if (grace.machines.size === 0) grace.until = 0;
}
