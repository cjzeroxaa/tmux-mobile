export function draftMachineName(draft) {
  return draft.machineName || draft.machineId;
}

// Build the machine selector from the complete authorized library, before
// applying a session filter. An offline machine's drafts stay in the library.
export function draftLibrary(drafts, filter = {}) {
  const machines = new Map();
  for (const draft of drafts) {
    const machine = machines.get(draft.machineId) || {
      id: draft.machineId, name: draftMachineName(draft), count: 0,
    };
    machine.count++;
    machines.set(machine.id, machine);
  }
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const items = drafts.filter(d =>
    (!filter.machineId || d.machineId === filter.machineId) &&
    (!filter.sessionId || (d.sessionId === filter.sessionId && d.kind === filter.kind)),
  ).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const groups = filter.sort === "machine"
    ? [...machines.values()].sort(byName).map(m => ({
        name: m.name, id: m.id, drafts: items.filter(d => d.machineId === m.id),
      })).filter(g => g.drafts.length)
    : [{ name: "", id: "", drafts: items }];
  return { machines: [...machines.values()].sort(byName), groups, count: items.length };
}

export function draftLibraryUrl({ embedded, machineId, kind, sessionId, sort, id } = {}) {
  const query = new URLSearchParams();
  if (embedded) query.set("embedded", "1");
  for (const [key, value] of Object.entries({ machineId, kind, sessionId, sort, id })) {
    if (value) query.set(key, value);
  }
  return `/drafts${query.size ? `?${query}` : ""}`;
}
