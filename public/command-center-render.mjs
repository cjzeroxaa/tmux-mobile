const VOLATILE_MACHINE_FIELDS = new Set([
  "inventoryAgeMs",
  "inventoryDurationMs",
  "inventoryObservedAt",
  "lastSeen",
]);

function recordKey(record = {}) {
  return [
    record.id,
    record.machineId,
    record.mux,
    record.sessionId,
    record.windowId,
    record.paneId,
    record.agentSessionId,
  ].map((value) => String(value || "")).join("\0");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableRecords(records, { omit = null } = {}) {
  return (Array.isArray(records) ? records : [])
    .map((record) => Object.fromEntries(
      Object.entries(record || {}).filter(([key]) => !omit?.has(key)),
    ))
    .sort((a, b) => recordKey(a).localeCompare(recordKey(b)))
    .map(stableValue);
}

// Poll responses carry timing diagnostics that change on every inventory push
// even when the visible fleet is identical. Excluding those fields lets the UI
// keep existing card nodes—and their hover state—until display data changes.
export function commandCenterDataFingerprint({ machines = [], agents = [] } = {}) {
  return JSON.stringify({
    machines: stableRecords(machines, { omit: VOLATILE_MACHINE_FIELDS }),
    agents: stableRecords(agents),
  });
}
