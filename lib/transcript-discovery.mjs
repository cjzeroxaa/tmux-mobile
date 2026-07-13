// Transport-only discovery of local agent transcript files.
//
// This module deliberately knows only the allowlisted filesystem roots and the
// session UUID encoded in a filename. It never opens or parses transcript JSON.

import { lstat, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TRANSCRIPT_KINDS = new Set(["codex", "claude"]);
const UUID_IN_FILENAME =
  /(^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[^0-9a-f])/gi;

export function defaultTranscriptRoots({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  return [
    {
      kind: "codex",
      root:
        env.TMUX_MOBILE_CODEX_TRANSCRIPT_ROOT ||
        path.join(homeDir, ".codex", "sessions"),
    },
    {
      kind: "claude",
      root:
        env.TMUX_MOBILE_CLAUDE_TRANSCRIPT_ROOT ||
        path.join(homeDir, ".claude", "projects"),
    },
  ];
}

export function agentSessionIdFromFilename(filename) {
  UUID_IN_FILENAME.lastIndex = 0;
  let agentSessionId = "";
  let match;
  while ((match = UUID_IN_FILENAME.exec(path.basename(String(filename || ""))))) {
    agentSessionId = match[2];
  }
  return agentSessionId;
}

export async function discoverTranscriptFiles({
  roots = defaultTranscriptRoots(),
} = {}) {
  const discovered = [];
  const seenFiles = new Set();

  for (const configured of roots || []) {
    const kind = String(configured?.kind || "").toLowerCase();
    if (!TRANSCRIPT_KINDS.has(kind)) {
      throw new TypeError(`Unsupported transcript kind: ${kind || "(empty)"}`);
    }

    const configuredRoot = String(configured?.root || "").trim();
    if (!configuredRoot) continue;

    const root = await resolveExistingDirectory(path.resolve(configuredRoot));
    if (!root) continue;
    await scanDirectory({ kind, directory: root, root, discovered, seenFiles });
  }

  return discovered;
}

async function scanDirectory({ kind, directory, root, discovered, seenFiles }) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    // Dirent is the cheap first check; lstat below protects against callers or
    // filesystems that return an unknown Dirent type. Neither check follows a
    // symbolic link.
    if (entry.isSymbolicLink()) continue;
    const candidate = path.join(directory, entry.name);
    const info = await lstatIfPresent(candidate);
    if (!info || info.isSymbolicLink()) continue;

    if (info.isDirectory()) {
      const child = await realpathIfPresent(candidate);
      if (!child || !isWithinRoot(root, child)) continue;
      await scanDirectory({
        kind,
        directory: child,
        root,
        discovered,
        seenFiles,
      });
      continue;
    }

    if (!info.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const agentSessionId = agentSessionIdFromFilename(entry.name);
    if (!agentSessionId) continue;

    const transcriptPath = await realpathIfPresent(candidate);
    if (!transcriptPath || !isWithinRoot(root, transcriptPath)) continue;

    // Re-check the original directory entry after realpath. This closes the
    // ordinary file-to-symlink replacement window and keeps returned sources
    // restricted to regular files directly present below the root.
    const finalInfo = await lstatIfPresent(candidate);
    if (!finalInfo?.isFile() || finalInfo.isSymbolicLink()) continue;

    const key = `${kind}\0${transcriptPath}`;
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    discovered.push({ kind, agentSessionId, transcriptPath });
  }
}

async function resolveExistingDirectory(candidate) {
  const resolved = await realpathIfPresent(candidate);
  if (!resolved) return "";
  const info = await lstatIfPresent(resolved);
  return info?.isDirectory() ? resolved : "";
}

async function realpathIfPresent(candidate) {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (isMissingPath(error)) return "";
    throw error;
  }
}

async function lstatIfPresent(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

function isMissingPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
