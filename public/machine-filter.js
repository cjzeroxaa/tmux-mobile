export function exclusiveMachineFilterValue(filterMachines) {
  if (!(filterMachines instanceof Set) || filterMachines.size === 0) return "";
  return String(filterMachines.values().next().value || "");
}

export function setExclusiveMachineFilter(filterMachines, machineId) {
  if (!(filterMachines instanceof Set)) {
    throw new TypeError("filterMachines must be a Set");
  }
  const next = String(machineId || "");
  filterMachines.clear();
  if (next) filterMachines.add(next);
  return next;
}
