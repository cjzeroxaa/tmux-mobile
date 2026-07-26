import { execFile } from "node:child_process";
import os from "node:os";
import { isIP } from "node:net";

function execFileResult(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout) => {
      resolve({ error, stdout: String(stdout || "") });
    });
  });
}

function addCandidate(result, seen, value) {
  const host = String(value || "").trim().replace(/\.$/u, "");
  const key = host.toLowerCase();
  if (!host || seen.has(key)) return;
  seen.add(key);
  result.push(host);
}

export function sshHostsFromTailscaleStatus(status, systemHostname = os.hostname()) {
  const result = [];
  const seen = new Set();
  // The selected machine's real .local hostname is the useful default for an
  // iPad on the same LAN; Tailscale names remain alternatives for devices that
  // are actually joined to the tailnet.
  addCandidate(result, seen, systemHostname);
  const running =
    status &&
    typeof status === "object" &&
    status.BackendState === "Running" &&
    status.Self?.Online !== false;

  if (running) {
    addCandidate(result, seen, status.Self?.DNSName);
    for (const value of status.Self?.TailscaleIPs || []) {
      if (isIP(String(value || "").trim())) addCandidate(result, seen, value);
    }
  }
  return result;
}

/**
 * Best-effort only: a Connector must still start when Tailscale is absent,
 * logged out, or not on PATH. This inspects status; it never configures Serve.
 */
export async function detectSshHostCandidates({
  systemHostname = os.hostname(),
  run = execFileResult,
  timeout = 1_500,
} = {}) {
  let status = null;
  try {
    const { error, stdout } = await run(
      "tailscale",
      ["status", "--json"],
      { timeout, maxBuffer: 2 * 1024 * 1024 },
    );
    if (!error) status = JSON.parse(stdout);
  } catch {
    // A normal Connector does not require Tailscale.
  }
  return sshHostsFromTailscaleStatus(status, systemHostname);
}
