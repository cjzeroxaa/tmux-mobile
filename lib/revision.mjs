import { execFileSync } from "node:child_process";

export function appRevision(baseDir = process.cwd()) {
  const configured = String(
    process.env.TMUX_MOBILE_REVISION || process.env.K_REVISION || "",
  ).trim();
  if (configured) return configured;

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
