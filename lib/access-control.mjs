import { readFileSync } from "node:fs";

export function readAccessControlFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read access-control file ${filePath}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Access-control config must be a JSON object");
  }
  if (parsed.version !== 1) {
    throw new Error("Access-control config version must be 1");
  }
  if (parsed.machineVisibility !== "owner-only") {
    throw new Error('Access-control machineVisibility must be "owner-only"');
  }
  if (!Array.isArray(parsed.superAdminEmails)) {
    throw new Error("Access-control superAdminEmails must be an array");
  }

  const superAdminEmails = [
    ...new Set(
      parsed.superAdminEmails
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (superAdminEmails.length !== parsed.superAdminEmails.length) {
    throw new Error("Access-control superAdminEmails must contain unique, non-empty emails");
  }
  for (const email of superAdminEmails) {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw new Error(`Invalid super-admin email in access-control config: ${email}`);
    }
  }

  if (parsed.machineShares !== undefined && !Array.isArray(parsed.machineShares)) {
    throw new Error("Access-control machineShares must be an array");
  }
  const machineShares = (parsed.machineShares || []).map((rawShare, index) => {
    if (!rawShare || typeof rawShare !== "object" || Array.isArray(rawShare)) {
      throw new Error(`Access-control machineShares[${index}] must be an object`);
    }
    const ownerEmail = String(rawShare.ownerEmail || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(ownerEmail)) {
      throw new Error(`Invalid ownerEmail in access-control machineShares[${index}]`);
    }
    const agentId = String(rawShare.agentId || "").trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(agentId)) {
      throw new Error(`Invalid agentId in access-control machineShares[${index}]`);
    }
    const emails = normalizeUniqueStrings(rawShare.emails, `machineShares[${index}].emails`);
    const domains = normalizeUniqueStrings(rawShare.domains, `machineShares[${index}].domains`);
    for (const email of emails) {
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
        throw new Error(`Invalid email in access-control machineShares[${index}]: ${email}`);
      }
    }
    for (const domain of domains) {
      if (domain.includes("@") || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
        throw new Error(`Invalid domain in access-control machineShares[${index}]: ${domain}`);
      }
    }
    if (emails.length === 0 && domains.length === 0) {
      throw new Error(`Access-control machineShares[${index}] must grant an email or domain`);
    }
    return Object.freeze({
      ownerEmail,
      agentId,
      emails: Object.freeze(emails),
      domains: Object.freeze(domains),
    });
  });
  const shareKeys = machineShares.map((share) => `${share.ownerEmail}\0${share.agentId}`);
  if (new Set(shareKeys).size !== shareKeys.length) {
    throw new Error("Access-control machineShares must identify each machine only once");
  }

  return Object.freeze({
    version: 1,
    machineVisibility: "owner-only",
    superAdminEmails: Object.freeze(superAdminEmails),
    machineShares: Object.freeze(machineShares),
  });
}

function normalizeUniqueStrings(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Access-control ${label} must be an array`);
  }
  const normalized = value.map((item) => String(item || "").trim().toLowerCase());
  if (normalized.some((item) => !item) || new Set(normalized).size !== normalized.length) {
    throw new Error(`Access-control ${label} must contain unique, non-empty values`);
  }
  return normalized;
}
