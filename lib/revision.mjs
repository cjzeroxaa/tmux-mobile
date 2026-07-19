import { execFileSync } from "node:child_process";

// The controller's reported revision is the per-deploy identity signal. It MUST
// be unique per deploy — two consumers depend on that:
//  - the browser (public/app.js compares runtime.revision to detect the
//    controller changed under it), and
//  - the controller's own staleness signaling (CONNECTOR_EXPECTED_REVISION).
// Agents do NOT poll this to migrate: since the transport moved to Socket.IO
// (commit 3fec7f2, 2026-06-20), a deploy's io.close() on the old instance
// surfaces as a "transport close" and Socket.IO auto-reconnects the agent onto
// the new revision (see lib/agent.mjs disconnect handler + lib/hub.mjs shutdown).
// The revision string is still what a *human*/deploy-verification reads to
// confirm a rollout landed; a non-unique value would just make that check
// useless, and would blind the controller's stale-connector detection.
//
// Precedence:
//  1. An explicit, meaningful TMUX_MOBILE_REVISION (e.g. a git SHA passed as a
//     build-arg by scripts/push-image.sh). The literal "dev" is NOT meaningful —
//     the Dockerfile bakes `ARG TMUX_MOBILE_REVISION=dev` as a default, so a
//     deploy that doesn't pass the build-arg would otherwise report a constant
//     "dev" on every revision and defeat agent migration.
//  2. K_REVISION — injected by Cloud Run, unique per deploy (e.g.
//     "svc-00027-zwm"). The robust signal for any Cloud Run deploy.
//  3. The baked TMUX_MOBILE_REVISION even if it is "dev" (last resort before git).
//  4. git short SHA (local/dev checkouts).
//  5. "dev".
export function appRevision(baseDir = process.cwd()) {
  const configured = String(process.env.TMUX_MOBILE_REVISION || "").trim();
  if (configured && configured !== "dev") return configured;

  const cloudRun = String(process.env.K_REVISION || "").trim();
  if (cloudRun) return cloudRun;

  if (configured) return configured; // baked "dev" — keep it over nothing

  return gitRevision(baseDir) || "dev";
}

function gitRevision(baseDir) {
  let sha = "";
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: baseDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return "";
  }
  if (!sha) return "";

  return gitDirty(baseDir) ? `${sha}-dirty` : sha;
}

function gitDirty(baseDir) {
  try {
    execFileSync("git", ["diff", "--quiet"], {
      cwd: baseDir,
      stdio: "ignore",
      timeout: 1000,
    });
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: baseDir,
      stdio: "ignore",
      timeout: 1000,
    });
    return false;
  } catch {
    return true;
  }
}
