export const PRIORITY_MACHINE_OWNER_EMAIL = "sonicgg@gmail.com";

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function machineOwnerEmail(machine) {
  return String(machine?.ownerEmail || machine?.ownerId || "")
    .trim()
    .toLowerCase();
}

function ownerRank(ownerEmail) {
  if (ownerEmail === PRIORITY_MACHINE_OWNER_EMAIL) return 0;
  return ownerEmail ? 1 : 2;
}

function machineKey(machine) {
  return String(machine?.id || machine?.machineId || machine?.hostname || "local");
}

function machineLabel(machine) {
  return String(machine?.machineAlias || machine?.hostname || machine?.machineId || machine?.id || "local");
}

export function compareMachinesByOwnerAndName(left, right) {
  const leftOwner = machineOwnerEmail(left);
  const rightOwner = machineOwnerEmail(right);
  const rankOrder = ownerRank(leftOwner) - ownerRank(rightOwner);
  if (rankOrder !== 0) return rankOrder;

  const ownerOrder = compareText(leftOwner, rightOwner);
  if (ownerOrder !== 0) return ownerOrder;

  const labelOrder = compareText(machineLabel(left), machineLabel(right));
  if (labelOrder !== 0) return labelOrder;
  return compareText(machineKey(left), machineKey(right));
}
