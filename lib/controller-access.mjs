const email = value => String(value || "").trim().toLowerCase();

// A private deployment policy takes precedence over the older Google domain
// and allow-all environment settings. Invalid policy must fail startup closed.
export function readPrivateAccess(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("privateAccess must be an object");
  const ownerEmail = email(value.ownerEmail);
  if (!/^[^@\s]+@[^@\s]+$/.test(ownerEmail))
    throw new Error("privateAccess.ownerEmail must be an exact email");
  if (!Array.isArray(value.existingConnectors))
    throw new Error("privateAccess.existingConnectors must be an array");
  const existingConnectors = value.existingConnectors.map(item => {
    const ownerEmail = email(item?.ownerEmail), agentId = email(item?.agentId);
    if (!/^[^@\s]+@[^@\s]+$/.test(ownerEmail) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(agentId))
      throw new Error("privateAccess existing connector requires an email and stable agent UUID");
    return Object.freeze({ ownerEmail, agentId });
  });
  if (new Set(existingConnectors.map(item => `${item.ownerEmail}:${item.agentId}`)).size !== existingConnectors.length)
    throw new Error("privateAccess existing connectors must be unique");
  return Object.freeze({ ownerEmail, existingConnectors: Object.freeze(existingConnectors) });
}

function identity(user) {
  const address = email(user?.email || user?.userId);
  return address && email(user?.userId) === address ? address : "";
}

export function controllerLoginAllowed(policy, user) {
  return !policy || identity(user) === policy.ownerEmail;
}

export function controllerTokenAllowed(policy, user, type) {
  if (!policy || controllerLoginAllowed(policy, user)) return true;
  // Existing owner machines may retain their original archive identity. This
  // does not grant that account a browser/native session or new device login.
  return type === "agent" && policy.existingConnectors.some(item => item.ownerEmail === identity(user));
}

export function controllerMachineAllowed(policy, { owner, agentId }) {
  if (!policy || controllerLoginAllowed(policy, owner)) return true;
  return policy.existingConnectors.some(item =>
    item.ownerEmail === identity(owner) && item.agentId === email(agentId));
}
