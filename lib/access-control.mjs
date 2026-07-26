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

  return Object.freeze({
    version: 1,
    machineVisibility: "owner-only",
    superAdminEmails: Object.freeze(superAdminEmails),
  });
}
